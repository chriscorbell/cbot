import { expect, test, vi } from 'vitest';

// What a reset takes down, recorded instead of done. The process exit is recorded too.
const steps: string[] = [];
vi.mock('../src/engine.js', async (orig) => ({ ...(await orig<typeof import('../src/engine.js')>()), removeEngine: async (id: string) => { steps.push(`engine ${id}`); } }));
vi.mock('../src/computer.js', async (orig) => ({
  ...(await orig<typeof import('../src/computer.js')>()),
  releaseScreen: async (id: string) => { steps.push(`screen ${id}`); },
  forgetBotFiles: async (id: string) => { steps.push(`files ${id}`); },
  forgetAllBotFiles: async () => { steps.push('all files'); },
}));
vi.mock('../src/units.js', async (orig) => ({ ...(await orig<typeof import('../src/units.js')>()), removeBotUnits: async (id: string) => { steps.push(`units ${id}`); } }));
const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

const fs = await import('node:fs');
const path = await import('node:path');
const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { json, seedBot, seedOwner } = await import('./helpers.js');

const app = createApp();
const reset = (b: unknown) => app.request('/api/reset', json(b));
const bots = () => db.prepare<[], { id: string }>('SELECT id FROM bots').all().map((b) => b.id);

test('a reset has to say so', async () => {
  const user = seedOwner();
  seedBot(user.id, { name: 'Ada', isPrimary: true });
  expect((await reset({})).status).toBe(400);
  expect((await reset({ confirm: 'yes' })).status).toBe(400);
  expect(bots()).toHaveLength(1);
  expect(steps).toEqual([]);
});

test('a reset takes every bot down, then erases the data and exits for a fresh start', async () => {
  const user = seedOwner();
  const [ada] = bots();
  const bea = seedBot(user.id, { name: 'Bea' });
  const team = seedBot(user.id, { kind: 'room', name: 'Team', members: [ada, bea.id] });
  const data = (name: string) => path.join(env.dataDir, name);
  // The Hermes homes are in the bots' account's home, apart from the server's data.
  fs.mkdirSync(path.join(env.enginesDir, 'old'), { recursive: true });
  fs.writeFileSync(data('dispatch.db.before-something'), '');
  fs.writeFileSync(data('notes.txt'), 'not ours');

  fs.writeFileSync(data('setup-code'), 'OLDC-ODE0\n');
  const res = await reset({ confirm: 'reset' });
  expect(res.status).toBe(200);
  const { setupCode } = (await res.json()) as { setupCode: string };
  // By the reply every bot is down, the group first; nothing is erased yet.
  expect(bots()).toEqual([]);
  expect(steps).toEqual([`files ${team.id}`, ...[ada, bea.id].flatMap((id) => [`engine ${id}`, `screen ${id}`, `units ${id}`, `files ${id}`])]);
  expect(fs.existsSync(env.dbPath)).toBe(true);
  expect(exit).not.toHaveBeenCalled();

  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  expect(steps.at(-1)).toBe('all files');
  expect(db.open).toBe(false);
  // The fresh install's account takes the code the reply gave the browser.
  expect(fs.readdirSync(env.dataDir).sort()).toEqual(['notes.txt', 'setup-code']);
  expect(fs.existsSync(env.enginesDir)).toBe(false);
  expect(fs.readFileSync(data('setup-code'), 'utf8').trim()).toBe(setupCode);
  expect(setupCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});
