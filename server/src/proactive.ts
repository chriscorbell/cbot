import { db, now, type BotRecord, type ProactivityRecord } from './db.js';
import type { Trigger } from './agent/turns.js';
import { env } from './env.js';

/**
 * Proactive check-ins for the primary bot.
 * The user (or the bot, via the set_checkins tool) picks local times; at each time the
 * primary bot gets a [check-in] turn and either sends ONE concise message or stays silent.
 */

let enqueueFn: ((botId: string, t: Trigger) => void) | null = null;

export function initProactive(enqueue: (botId: string, t: Trigger) => void) {
  enqueueFn = enqueue;
  setInterval(tick, 60_000).unref();
  console.log(`[proactive] ${db.prepare<[], { n: number }>('SELECT COUNT(*) n FROM proactivity WHERE enabled=1').get()!.n} user(s) with check-ins`);
}

export function getCheckins(userId: string) {
  const r = db.prepare<[string], ProactivityRecord>('SELECT * FROM proactivity WHERE user_id=?').get(userId);
  return r ? { enabled: !!r.enabled, times: JSON.parse(r.times) as string[], timezone: r.timezone } : { enabled: false, times: ['09:00', '16:30'], timezone: env.timeZone };
}

export function setCheckins(userId: string, p: { enabled?: boolean; times?: string[]; timezone?: string }) {
  const cur = getCheckins(userId);
  const times = (p.times ?? cur.times).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0, 6);
  const tz = p.timezone ?? cur.timezone;
  new Intl.DateTimeFormat('en-US', { timeZone: tz }); // throws on a bad zone
  db.prepare(`INSERT INTO proactivity(user_id,enabled,times,timezone,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, times=excluded.times, timezone=excluded.timezone, updated_at=excluded.updated_at`)
    .run(userId, (p.enabled ?? cur.enabled) ? 1 : 0, JSON.stringify(times), tz, now());
  return getCheckins(userId);
}

function localParts(tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

function tick() {
  if (!enqueueFn) return;
  const rows = db.prepare<[], ProactivityRecord>('SELECT * FROM proactivity WHERE enabled=1').all();
  for (const r of rows) {
    try {
      const { date, hm } = localParts(r.timezone);
      const times: string[] = JSON.parse(r.times);
      const slot = times.find((t) => minutesBetween(t, hm) >= 0 && minutesBetween(t, hm) < 5);
      if (!slot) continue;
      const key = `${date} ${slot}`;
      if (r.last_fired === key) continue;
      db.prepare('UPDATE proactivity SET last_fired=? WHERE user_id=?').run(key, r.user_id);
      fireCheckin(r.user_id);
    } catch (e) {
      console.warn('[proactive] tick failed for', r.user_id, (e as Error).message);
    }
  }
}

const minutesBetween = (from: string, to: string) => {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return th * 60 + tm - (fh * 60 + fm);
};

export function fireCheckin(userId: string, force = false) {
  const primary = db.prepare<[string], Pick<BotRecord, 'id'>>('SELECT id FROM bots WHERE user_id=? AND is_primary=1').get(userId);
  if (!primary || !enqueueFn) return;
  // Don't interrupt an active conversation.
  const lastUser = db.prepare("SELECT MAX(created_at) t FROM rows WHERE bot_id IN (SELECT id FROM bots WHERE user_id=?) AND kind='message' AND json_extract(body,'$.role')='user'").get(userId) as { t: number | null } | undefined;
  if (!force && lastUser?.t && now() - lastUser.t < 20 * 60_000) return;

  const since = now() - 12 * 3600_000;
  const routineRuns = db.prepare("SELECT b.name bot, r.name FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.last_run_at > ?").all(userId, since) as { bot: string; name: string }[];
  const pendingApprovals = db.prepare("SELECT b.name bot, a.tool FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE b.user_id=? AND a.status='pending'").all(userId) as { bot: string; tool: string }[];
  const otherBots = db.prepare("SELECT name, label FROM bots WHERE user_id=? AND is_primary=0").all(userId) as { name: string; label: string }[];

  const context = [
    pendingApprovals.length ? `Pending approvals: ${pendingApprovals.map((a) => `${a.bot}: ${a.tool}`).join('; ')}` : 'No pending approvals.',
    routineRuns.length ? `Routines that ran in the last 12h: ${routineRuns.map((r) => `${r.name} (${r.bot})`).join('; ')}` : 'No routines ran in the last 12h.',
    otherBots.length ? `Team: ${otherBots.map((b) => `${b.name}${b.label ? ` (${b.label})` : ''}`).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  enqueueFn(primary.id, {
    type: 'system',
    text:
      `[check-in] Scheduled proactive check-in. Look at what's going on: read your memories, use your browser or web search if it helps, and check on other Bots if needed. ` +
      `If there is something genuinely useful to tell the user (a decision they owe, something that changed, today's schedule, a finished result), send ONE short message. ` +
      `If not, call stay_silent and send nothing.\n${context}`,
  });
}
