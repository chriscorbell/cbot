import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { db } from '../src/db.js';
import { createApp } from '../src/app.js';
import { startSession } from '../src/lib/auth.js';
import { appendRow, markUnread } from '../src/store.js';
import { LOOKING_MS, notify } from '../src/notifications.js';
import { auth, json, seedBot, seedOwner } from './helpers.js';
import { browserKeys, decrypt } from './push.js';
import type { PushNotice } from '../src/types.js';

const app = createApp();
let user: ReturnType<typeof seedOwner>;
beforeAll(() => { user = seedOwner(); });

/** What reached the push services: where, with which headers, and the sealed body. */
interface Sent { url: string; headers: Record<string, string>; body: Buffer }
let sent: Sent[] = [];
/** The status the push services answer with. */
let answer = 201;

beforeEach(() => {
  sent = [];
  answer = 201;
  db.prepare('DELETE FROM push_devices').run();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
    return new Response(answer === 201 ? null : 'nope', { status: answer });
  }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const put = (path: string, body: unknown, headers: Record<string, string> = auth()) =>
  app.request(path, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A browser turning notifications on, signed in with `headers`. */
async function device(endpoint: string, headers = auth()) {
  const k = browserKeys();
  const r = await put('/api/notifications/device', { endpoint, keys: { p256dh: k.p256dh, auth: k.auth } }, headers);
  expect(r.status).toBe(200);
  return { endpoint, ...k };
}

const opened = (s: Sent, k: ReturnType<typeof browserKeys>) => JSON.parse(decrypt(s.body, k.privateKey, k.authSecret).toString()) as PushNotice;
const unread = () => (db.prepare('SELECT SUM(unread) AS n FROM bots WHERE user_id=?').get(user.id) as { n: number }).n;
const says = (botId: string, text: string) => { appendRow(botId, 'message', { type: 'message', role: 'assistant', text }); markUnread(botId); };

test('a message nobody is looking at reaches each device, sealed for it', async () => {
  const bot = seedBot(user.id, { name: 'Ada' });
  const phone = await device('https://web.push.apple.com/QGl1');
  const laptop = await device('https://fcm.googleapis.com/fcm/send/abc:def');
  says(bot.id, 'The report is in your Library.\n\nIt covers   the last quarter.');
  // It waits a moment for whatever else the bot writes in the same breath.
  expect(sent).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  for (const k of [phone, laptop]) {
    const s = sent.find((x) => x.url === k.endpoint)!;
    expect(opened(s, k)).toEqual({ botId: bot.id, title: 'Ada', body: 'The report is in your Library. It covers the last quarter.', unread: unread() });
    expect(s.headers).toMatchObject({ 'content-encoding': 'aes128gcm', urgency: 'normal', ttl: '86400' });
    expect(s.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(s.headers.topic).toMatch(/^[\w-]{32}$/);
  }
});

test('a burst is one notification, urgent when it waits on the user', async () => {
  const bot = seedBot(user.id, { name: 'Bo' });
  const phone = await device('https://web.push.apple.com/QGl2');
  says(bot.id, 'I can book either one.');
  appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which flight?', options: ['7:10', '9:45'], status: 'pending' });
  notify(bot.id, true);
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(opened(sent[0], phone)).toMatchObject({ title: 'Bo', body: 'Which flight?' });
  expect(sent[0].headers.urgency).toBe('high');
});

test('nothing goes about a chat someone is looking at; a tab that went quiet stops counting', async () => {
  const bot = seedBot(user.id, { name: 'Cy' });
  const other = seedBot(user.id, { name: 'Di' });
  await device('https://web.push.apple.com/QGl3');
  expect((await put('/api/notifications/presence', { tab: 'tab-1', botId: bot.id })).status).toBe(200);
  says(bot.id, 'Done.');
  says(other.id, 'Done too.');
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  // Only the chat that wasn't on screen.
  expect(sent).toHaveLength(1);

  // The tab says it shows nothing now (the app went to the background).
  await put('/api/notifications/presence', { tab: 'tab-1', botId: null });
  says(bot.id, 'One more thing.');
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(sent).toHaveLength(2));

  // A tab that stops saying so (a phone that locked mid-request) counts until LOOKING_MS runs out.
  await put('/api/notifications/presence', { tab: 'tab-1', botId: bot.id });
  says(bot.id, 'Still here?');
  await vi.advanceTimersByTimeAsync(2000);
  expect(sent).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(LOOKING_MS);
  says(bot.id, 'Hello?');
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(sent).toHaveLength(3));
});

test('a device whose subscription ended is forgotten, and one that signed out gets nothing', async () => {
  const bot = seedBot(user.id, { name: 'Ed' });
  await device('https://fcm.googleapis.com/fcm/send/gone');
  answer = 410;
  says(bot.id, 'Hi.');
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) AS n FROM push_devices').get()).toEqual({ n: 0 }));

  answer = 201;
  sent = [];
  const session = startSession(user.id);
  await device('https://fcm.googleapis.com/fcm/send/other-browser', { cookie: `dispatch_session=${session}` });
  db.prepare('DELETE FROM auth_sessions WHERE token=?').run(session);
  says(bot.id, 'Anyone?');
  await vi.advanceTimersByTimeAsync(2000);
  expect(sent).toHaveLength(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM push_devices').get()).toEqual({ n: 0 });
});

test('a group chat says which bot wrote', async () => {
  const ada = seedBot(user.id, { name: 'Ada' });
  const room = seedBot(user.id, { name: 'Crew', kind: 'room', members: [ada.id] });
  const phone = await device('https://web.push.apple.com/QGl4');
  appendRow(room.id, 'message', { type: 'message', role: 'assistant', text: 'Shipped.', from: { kind: 'bot', id: ada.id, name: 'Ada' } });
  markUnread(room.id);
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(opened(sent[0], phone)).toMatchObject({ botId: room.id, title: 'Crew', body: 'Ada: Shipped.' });
});

test('Send a Test reaches only this device, and says why it did not', async () => {
  const phone = await device('https://web.push.apple.com/QGl5');
  await device('https://fcm.googleapis.com/fcm/send/laptop');
  vi.useRealTimers();
  const r = await app.request('/api/notifications/test', json({ endpoint: phone.endpoint }));
  expect(await r.json()).toEqual({ ok: true, error: null });
  expect(sent.map((s) => s.url)).toEqual([phone.endpoint]);
  expect(opened(sent[0], phone)).toMatchObject({ botId: null, title: 'Dispatch' });

  answer = 403;
  expect(await (await app.request('/api/notifications/test', json({ endpoint: phone.endpoint }))).json()).toEqual({ ok: false, error: 'web.push.apple.com refused it (403: nope).' });
  const unknown = await (await app.request('/api/notifications/test', json({ endpoint: 'https://web.push.apple.com/nobody' }))).json() as { ok: boolean };
  expect(unknown.ok).toBe(false);
});

test('devices and tabs are checked where they come in', async () => {
  const key = (await (await app.request('/api/notifications', { headers: auth() })).json() as { publicKey: string }).publicKey;
  expect(Buffer.from(key, 'base64url')).toHaveLength(65);
  // One key pair, kept: every subscription depends on it.
  expect((await (await app.request('/api/notifications', { headers: auth() })).json() as { publicKey: string }).publicKey).toBe(key);
  expect((await app.request('/api/notifications')).status).toBe(401);

  const k = browserKeys();
  expect((await put('/api/notifications/device', { endpoint: 'http://push.example.com/x', keys: { p256dh: k.p256dh, auth: k.auth } })).status).toBe(400);
  expect((await put('/api/notifications/device', { endpoint: 'https://push.example.com/x', keys: { p256dh: 'short', auth: k.auth } })).status).toBe(400);
  expect((await put('/api/notifications/presence', { tab: 'tab-1', botId: 'bot_nobody' })).status).toBe(404);

  await device('https://push.example.com/x');
  const del = await app.request('/api/notifications/device', { method: 'DELETE', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://push.example.com/x' }) });
  expect(del.status).toBe(200);
  expect(db.prepare('SELECT COUNT(*) AS n FROM push_devices').get()).toEqual({ n: 0 });
});
