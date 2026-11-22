import crypto from 'node:crypto';
import { db, now, type PushDeviceRecord, type PushKeysRecord } from './db.js';
import { errorText } from './lib/errors.js';
import { makeVapidKeys, MAX_PAYLOAD, sendPush, type PushOptions, type PushTarget, type VapidKeys } from './lib/webpush.js';
import { chatPreview, getBotRow } from './store.js';
import type { PushNotice } from './types.js';

/**
 * Notifications on the user's phones and computers, by Web Push, when a bot's chat gets something new
 * while nobody is looking at it: a message (store.ts markUnread), an approval card (agent/approvals.ts)
 * or a question (ask_user in agent/tools.ts).
 *
 * A browser that turns them on (Settings > General) subscribes at its maker's push service and hands
 * us the subscription, which is a row in `push_devices` tied to the session that sent it: a device that
 * signs out, or whose session ends any other way, gets nothing more. Each message is encrypted for its
 * device (lib/webpush.ts), so the push service carries it without reading it.
 *
 * Looking: a tab that shows a bot's chat in front of the user (visible and focused) says so, and again
 * every LOOKING_MS / 2 while it does (PUT /api/notifications/presence). Nothing is sent about a chat
 * someone is looking at, on any device. A tab that goes away without a word stops counting after
 * LOOKING_MS. What the tabs say lives in memory: after a restart, the next report puts it back.
 *
 * What a bot writes in a quick burst (a message, then the question it leads into) is one notification:
 * the first waits BURST_MS, then shows the chat's newest preview. Each bot's notification replaces its
 * last one, on the device (its tag) and at the push service while it waits there (its topic).
 */

/** How long a burst gathers before its one notification goes. */
const BURST_MS = 1500;
/** How long a tab's word that it shows a chat counts for. The web app says it again before then. */
export const LOOKING_MS = 45_000;
/** How long a push service keeps a notification for a device that is off or out of reach. */
const TTL_S = 24 * 3600;
/** How a push service can tell who sends these; VAPID requires one (RFC 8292 section 2.1). */
const SUBJECT = 'https://github.com/chriscorbell/dispatch';
/** A notification's text, at most: about what a phone shows before "more". */
const BODY_CHARS = 300;
/** Tabs remembered at once; a bot can't send more of them than this, and they age out anyway. */
const MAX_TABS = 64;

// ---------- the key pair ----------

const readKeys = db.prepare<[], PushKeysRecord>('SELECT * FROM push_keys WHERE id=1');

/** The server's VAPID keys, made the first time anything asks. Every device subscribes with the public one. */
export function vapidKeys(): VapidKeys {
  let row = readKeys.get();
  if (!row) {
    const k = makeVapidKeys();
    db.prepare('INSERT OR IGNORE INTO push_keys(id,public_key,private_key,created_at) VALUES (1,?,?,?)').run(k.publicKey, k.privateKey, now());
    row = readKeys.get()!;
  }
  return { publicKey: row.public_key, privateKey: row.private_key };
}

// ---------- devices ----------

const liveDevices = db.prepare<[string, number], PushDeviceRecord>('SELECT d.* FROM push_devices d JOIN auth_sessions s ON s.token=d.session WHERE d.user_id=? AND s.expires_at>?');
const anyDevice = db.prepare<[string, number], { n: number }>('SELECT 1 AS n FROM push_devices d JOIN auth_sessions s ON s.token=d.session WHERE d.user_id=? AND s.expires_at>? LIMIT 1');
const forget = db.prepare<[string]>('DELETE FROM push_devices WHERE endpoint=?');

/**
 * A device turned notifications on, or said so again (the web app does on every start, so a new
 * session after signing in again takes the device over). A subscription is one device's, whoever sent it before.
 */
export function addDevice(userId: string, session: string, t: PushTarget) {
  db.prepare(`INSERT INTO push_devices(endpoint,user_id,session,p256dh,auth,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, session=excluded.session, p256dh=excluded.p256dh, auth=excluded.auth, updated_at=excluded.updated_at`)
    .run(t.endpoint, userId, session, t.p256dh, t.auth, now(), now());
}

/** A device turned notifications off. */
export function removeDevice(userId: string, endpoint: string) {
  db.prepare('DELETE FROM push_devices WHERE endpoint=? AND user_id=?').run(endpoint, userId);
}

const hostOf = (endpoint: string) => { try { return new URL(endpoint).host; } catch { return 'a push service'; } };

/**
 * Sends `notice` to each of the user's devices (or the one `only` names) and answers what went wrong
 * per device. A subscription the service says is gone for good (404, 410) is forgotten.
 */
async function send(userId: string, notice: PushNotice, o: Omit<PushOptions, 'ttl'>, only?: string): Promise<Map<string, string>> {
  const keys = vapidKeys();
  let n = notice;
  // Long names and text in a script that takes 3 bytes a letter could pass the limit; the text gives way.
  while (Buffer.byteLength(JSON.stringify(n)) > MAX_PAYLOAD && n.body) n = { ...n, body: n.body.slice(0, Math.floor(n.body.length / 2)) };
  const payload = Buffer.from(JSON.stringify(n));
  const failed = new Map<string, string>();
  const devices = liveDevices.all(userId, now()).filter((d) => !only || d.endpoint === only);
  await Promise.all(devices.map(async (d) => {
    const where = hostOf(d.endpoint);
    try {
      const r = await sendPush({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, payload, keys, SUBJECT, { ttl: TTL_S, ...o });
      if (r.status === 404 || r.status === 410) {
        forget.run(d.endpoint);
        failed.set(d.endpoint, `${where} says this device's subscription has ended. Turn notifications off and on again.`);
      } else if (r.status >= 400) {
        console.warn(`[notifications] ${where} refused a notification (${r.status}): ${r.text}`);
        failed.set(d.endpoint, `${where} refused it (${r.status}${r.text ? `: ${r.text}` : ''}).`);
      }
    } catch (e) {
      console.warn(`[notifications] couldn't reach ${where}:`, errorText(e));
      failed.set(d.endpoint, `Dispatch couldn't reach ${where}: ${errorText(e)}`);
    }
  }));
  return failed;
}

const unreadOf = db.prepare<[string], { n: number }>('SELECT COALESCE(SUM(unread), 0) AS n FROM bots WHERE user_id=?');

/** Settings' "Send a Test": a notification to this one device. Answers why it didn't go, or null. */
export async function testDevice(userId: string, endpoint: string): Promise<string | null> {
  if (!liveDevices.all(userId, now()).some((d) => d.endpoint === endpoint)) return 'This device isn’t set up for notifications. Turn them off and on again.';
  const failed = await send(userId, { botId: null, title: 'Dispatch', body: 'Notifications are on for this device.', unread: unreadOf.get(userId)?.n ?? 0 }, { urgency: 'high' }, endpoint);
  return failed.get(endpoint) ?? null;
}

// ---------- who is looking ----------

interface Look { userId: string; botId: string; until: number }
/** What each tab last said it shows, by user and tab. */
const looks = new Map<string, Look>();

/** A tab says which bot's chat it shows in front of the user, or null when it shows none (hidden, in the background). */
export function setLooking(userId: string, tab: string, botId: string | null) {
  const t = now();
  for (const [k, v] of looks) if (v.until <= t) looks.delete(k);
  const key = `${userId}\n${tab}`;
  looks.delete(key);
  if (!botId) return;
  looks.set(key, { userId, botId, until: t + LOOKING_MS });
  if (looks.size > MAX_TABS) looks.delete(looks.keys().next().value!);
}

/** Whether a tab shows this chat in front of the user now. */
export function isLooking(userId: string, botId: string): boolean {
  const t = now();
  for (const v of looks.values()) if (v.userId === userId && v.botId === botId && v.until > t) return true;
  return false;
}

// ---------- notifying ----------

/** Bursts gathering, by bot: whether anything in it waits for the user (an approval, a question). */
const gathering = new Map<string, { waiting: boolean }>();

/**
 * Something new in a bot's chat. `waiting`: it waits for the user's answer, so the notification asks
 * the push service to wake the phone at once. Nothing happens for a user with no device to tell.
 */
export function notify(botId: string, waiting = false) {
  const bot = getBotRow(botId);
  if (!bot || !anyDevice.get(bot.user_id, now())) return;
  const g = gathering.get(botId);
  if (g) { g.waiting ||= waiting; return; }
  gathering.set(botId, { waiting });
  setTimeout(() => {
    const w = gathering.get(botId)?.waiting ?? waiting;
    gathering.delete(botId);
    deliver(botId, w).catch((e: unknown) => console.warn('[notifications] sending failed:', errorText(e)));
  }, BURST_MS).unref();
}

/** The notification for a bot's chat as it stands, to every device, unless someone is looking at the chat. */
export async function deliver(botId: string, waiting: boolean): Promise<void> {
  const bot = getBotRow(botId);
  if (!bot || isLooking(bot.user_id, botId)) return;
  const p = chatPreview(bot);
  if (!p?.text) return;
  const text = p.text.replace(/\s+/g, ' ').trim();
  const body = (p.from ? `${p.from}: ${text}` : text).slice(0, BODY_CHARS);
  await send(bot.user_id, { botId, title: bot.name, body, unread: unreadOf.get(bot.user_id)?.n ?? 0 }, {
    urgency: waiting ? 'high' : 'normal',
    topic: crypto.createHash('sha256').update(botId).digest('base64url').slice(0, 32),
  });
}
