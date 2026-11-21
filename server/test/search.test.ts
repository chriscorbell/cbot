import { beforeAll, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { db, now } = await import('../src/db.js');
const { excerpt, searchLibraries, searchMessages } = await import('../src/search.js');
const { createApp } = await import('../src/app.js');
const { auth, seedBot, seedOwner } = await import('./helpers.js');

let user: ReturnType<typeof seedOwner>;
let ada: ReturnType<typeof seedBot>;
let bo: ReturnType<typeof seedBot>;
let seq = 0;
const row = (botId: string, body: object, generation = 1, at = now()) =>
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run(botId, generation, ++seq, seq, 'message', JSON.stringify(body), at);

beforeAll(() => {
  user = seedOwner();
  ada = seedBot(user.id, { name: 'Ada' });
  bo = seedBot(user.id, { name: 'Bo' });
  db.prepare('UPDATE bots SET generation=2 WHERE id=?').run(bo.id);
  row(ada.id, { type: 'message', role: 'user', text: 'Find the **Kalshi** paper-trading docs' }, 1, 1000);
  row(ada.id, { type: 'message', role: 'assistant', text: 'Done: the kalshi demo works with 50% fees.' }, 1, 2000);
  row(ada.id, { type: 'message', role: 'assistant', text: 'Kalshi thinking aloud', note: true }, 1, 3000);
  row(bo.id, { type: 'message', role: 'assistant', text: 'Kalshi from a chat that was cleared' }, 1, 4000);
  row(bo.id, { type: 'message', role: 'user', text: 'Kalshi again, after New chat', from: { kind: 'bot', id: ada.id, name: 'Ada' } }, 2, 5000);
  const other = 'usr_other';
  db.prepare("INSERT INTO users(id,username,created_at) VALUES (?,?,?)").run(other, 'other', now());
  const theirs = seedBot(other, { name: 'Theirs' });
  row(theirs.id, { type: 'message', role: 'user', text: 'Kalshi for someone else' }, 1, 6000);
});

test('messages match case-insensitively, newest first, only in chats the person can open', () => {
  const hits = searchMessages(user.id, 'KALSHI');
  expect(hits.map((h) => h.text)).toEqual(['Kalshi again, after New chat', 'Done: the kalshi demo works with 50% fees.', 'Find the Kalshi paper-trading docs']);
  expect(hits[0]).toMatchObject({ botId: bo.id, generation: 2, role: 'user', from: 'Ada' });
  expect(hits[2]).toMatchObject({ botId: ada.id, generation: 1, role: 'user' });
});

test('% and _ in a search are text, not wildcards', () => {
  expect(searchMessages(user.id, '50%').map((h) => h.text)).toEqual(['Done: the kalshi demo works with 50% fees.']);
  expect(searchMessages(user.id, '5_%')).toEqual([]);
});

test('an excerpt keeps about a line around the match and says where it was cut', () => {
  const long = `${'word '.repeat(40)}the needle is here ${'tail '.repeat(40)}`;
  const e = excerpt(long, 'NEEDLE');
  expect(e.startsWith('…')).toBe(true);
  expect(e.endsWith('…')).toBe(true);
  expect(e).toContain('the needle is here');
  expect(e.length).toBeLessThan(180);
  expect(excerpt('short `code` and **bold**', 'bold')).toBe('short code and bold');
});

test('Library files and folders match by name; dot-files, links and group chats are left out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-lib-'));
  const room = seedBot(user.id, { name: 'Team', kind: 'room', members: [ada.id, bo.id] });
  fs.mkdirSync(path.join(root, ada.id, 'reports/2026'), { recursive: true });
  fs.writeFileSync(path.join(root, ada.id, 'reports/2026/kalshi-summary.md'), 'x');
  fs.mkdirSync(path.join(root, ada.id, 'Kalshi'), { recursive: true });
  fs.writeFileSync(path.join(root, ada.id, '.kalshi-secret'), 'x');
  fs.symlinkSync('/etc', path.join(root, ada.id, 'kalshi-link'));
  fs.mkdirSync(path.join(root, room.id), { recursive: true });
  fs.writeFileSync(path.join(root, room.id, 'kalshi-room.txt'), 'x');
  const hits = await searchLibraries(user.id, 'kalshi', root);
  expect(hits.map((h) => [h.path, h.isDir]).sort()).toEqual([['Kalshi', true], ['reports/2026/kalshi-summary.md', false]]);
  expect(hits.every((h) => h.botId === ada.id)).toBe(true);
  // A Library that doesn't exist yet is just empty.
  expect(await searchLibraries(user.id, 'kalshi', path.join(root, 'missing'))).toEqual([]);
});

test('the search route needs a session and at least two letters', async () => {
  const app = createApp();
  expect((await app.request('/api/search?q=kalshi')).status).toBe(401);
  const short = await app.request('/api/search?q=k', { headers: auth() });
  expect(await short.json()).toEqual({ messages: [], files: [] });
  const res = await app.request('/api/search?q=kalshi', { headers: auth() });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { messages: unknown[] }).messages).toHaveLength(3);
});
