import { expect, test, vi } from 'vitest';
import type { BotResponse, MeResponse } from '../src/contract.js';

// A new bot's greeting is a turn, and the bot itself would start a gateway: record the turns, start nothing.
const enqueued: { botId: string; trigger: unknown }[] = [];
vi.mock('../src/agent/turns.js', async (orig) => ({
  ...(await orig<typeof import('../src/agent/turns.js')>()),
  enqueue: (botId: string, trigger: unknown) => { enqueued.push({ botId, trigger }); },
}));
vi.mock('../src/engine.js', async (orig) => ({ ...(await orig<typeof import('../src/engine.js')>()), provisionEngine: () => {} }));

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const { ensureOwner, setupPending } = await import('../src/bots.js');
const { initAuth } = await import('../src/lib/auth.js');
const { auth, json } = await import('./helpers.js');

const app = createApp();
const me = async () => (await (await app.request('/api/auth/me', { headers: auth() })).json()) as MeResponse;
const finish = (greet: boolean) => app.request('/api/setup/finish', json({ greet }));
const create = async (b: Record<string, string>) => ((await (await app.request('/api/bots', json(b))).json()) as BotResponse).bot;
const greeted = () => enqueued.map((e) => e.botId);

test('a fresh install starts with the owner and no bot', () => {
  const owner = ensureOwner();
  initAuth(owner);
  expect(db.prepare('SELECT COUNT(*) n FROM bots').get()).toEqual({ n: 0 });
  expect(setupPending(owner.id)).toBe(true);
  // Approvals start on Smart (Settings > Permissions).
  expect(db.prepare('SELECT approval_mode FROM users WHERE id=?').get(owner.id)).toEqual({ approval_mode: 'smart' });
  // The first visit creates the account (auth.test.ts); here it is written straight in.
  db.prepare("UPDATE users SET username='tess', password_hash='x'").run();
});

test('setup cannot finish before the first bot exists', async () => {
  expect((await me()).needsSetup).toBe(true);
  expect((await finish(true)).status).toBe(409);
  expect((await me()).needsSetup).toBe(true);
});

test("the wizard's bot is the primary one, with its label, About and instructions, and holds its greeting while setup is pending", async () => {
  const bot = await create({ name: ' Ada ', label: 'Front Desk', description: 'Runs my week.', instructions: 'Be brief.' });
  expect(bot).toMatchObject({ name: 'Ada', label: 'Front Desk', description: 'Runs my week.', instructions: 'Be brief.', isPrimary: true });
  expect(greeted()).toEqual([]);
});

test('finishing setup with a model greets once, from the first bot', async () => {
  const [ada] = db.prepare<[], { id: string }>("SELECT id FROM bots WHERE name='Ada'").all();
  expect((await finish(true)).status).toBe(200);
  expect(greeted()).toEqual([ada.id]);
  expect((enqueued[0].trigger as { type: string; text: string })).toMatchObject({ type: 'system', text: expect.stringContaining('Greet tess by name and introduce yourself as Ada') });
  expect((await me()).needsSetup).toBe(false);
  // A second finish (a double click, another tab) changes nothing.
  expect((await finish(true)).status).toBe(200);
  expect(greeted()).toEqual([ada.id]);
});

test('setup left for later finishes without a greeting', async () => {
  db.prepare('UPDATE users SET setup_at=NULL').run();
  enqueued.length = 0;
  expect((await finish(false)).status).toBe(200);
  expect(greeted()).toEqual([]);
  expect((await me()).needsSetup).toBe(false);
});

test('after setup, a new bot is not primary and greets at once', async () => {
  enqueued.length = 0;
  const bea = await create({ name: 'Bea' });
  expect(bea.isPrimary).toBe(false);
  expect(greeted()).toEqual([bea.id]);
});
