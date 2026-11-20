import { beforeAll, expect, test, vi } from 'vitest';

// What deleting a bot takes down, recorded instead of done, with whether the bot's row was still there.
const steps: string[] = [];
const rowGone = (id: string) => db.prepare('SELECT 1 FROM bots WHERE id=?').get(id) === undefined;
vi.mock('../src/engine.js', async (orig) => ({ ...(await orig<typeof import('../src/engine.js')>()), removeEngine: async (id: string) => { steps.push(`engine ${rowGone(id)}`); } }));
vi.mock('../src/computer.js', async (orig) => ({
  ...(await orig<typeof import('../src/computer.js')>()),
  releaseScreen: async (id: string) => { steps.push(`screen ${rowGone(id)}`); },
  forgetBotFiles: async (id: string) => { steps.push(`files ${rowGone(id)}`); },
}));
vi.mock('../src/routines.js', async (orig) => ({ ...(await orig<typeof import('../src/routines.js')>()), unscheduleRoutine: (id: string) => { steps.push(`unschedule ${id}`); } }));

const { deleteBot } = await import('../src/bots.js');
const { db, now } = await import('../src/db.js');
const { seedBot, seedOwner } = await import('./helpers.js');

let userId: string;
beforeAll(() => { userId = seedOwner().id; });

test('deleting a bot removes its row first, then takes down what runs for it', async () => {
  const bot = seedBot(userId);
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at) VALUES ('rt_x',?,'r','p','0 8 * * *',?)").run(bot.id, now());
  steps.length = 0;
  await deleteBot(bot);
  expect(rowGone(bot.id)).toBe(true);
  expect(steps).toEqual(['unschedule rt_x', 'engine true', 'screen true', 'files true']);
  expect(db.prepare('SELECT 1 FROM routines WHERE id=?').get('rt_x')).toBeUndefined();
});

test('a group chat has nothing running to take down, only its attached files', async () => {
  const room = seedBot(userId, { kind: 'room', name: 'Team' });
  steps.length = 0;
  await deleteBot(room);
  expect(rowGone(room.id)).toBe(true);
  expect(steps).toEqual(['files true']);
});

test('a deleted bot cannot lease a screen', async () => {
  const { screenFor } = await vi.importActual<typeof import('../src/computer.js')>('../src/computer.js');
  await expect(screenFor(userId, 'bot_gone')).rejects.toThrow(/no bot/);
  expect(db.prepare("SELECT 1 FROM screens WHERE bot_id='bot_gone'").get()).toBeUndefined();
});

test("a deleted bot's gateway port goes to no other bot until removeEngine has finished with it", async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { env } = await import('../src/env.js');
  const { requireBot } = await import('../src/store.js');
  const engine = await vi.importActual<typeof import('../src/engine.js')>('../src/engine.js');
  const old = seedBot(userId, { name: 'Old' });
  db.prepare("UPDATE bots SET engine='managed', engine_port=8650 WHERE id=?").run(old.id);
  fs.mkdirSync(path.join(env.enginesDir, old.id), { recursive: true });
  db.prepare('DELETE FROM bots WHERE id=?').run(old.id);

  const removal = engine.removeEngine(old.id, 8650);
  const fresh = seedBot(userId, { name: 'Fresh' });
  engine.assignEngine(fresh.id);
  expect(requireBot(fresh.id).engine_port).not.toBe(8650);
  await removal;
  const later = seedBot(userId, { name: 'Later' });
  engine.assignEngine(later.id);
  expect(requireBot(later.id).engine_port).toBe(8650);
});
