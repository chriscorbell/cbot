import { beforeAll, expect, test, vi } from 'vitest';

// What deleting a bot takes down, recorded instead of done, with whether the bot's row was still there.
const steps: string[] = [];
const rowGone = (id: string) => db.prepare('SELECT 1 FROM bots WHERE id=?').get(id) === undefined;
vi.mock('../src/engine.js', async (orig) => ({ ...(await orig<typeof import('../src/engine.js')>()), removeEngine: async (id: string) => { steps.push(`engine ${rowGone(id)}`); } }));
const tombstone = (id: string) => db.prepare('SELECT 1 FROM deleted_bots WHERE id=?').get(id) !== undefined;
vi.mock('../src/computer.js', async (orig) => ({
  ...(await orig<typeof import('../src/computer.js')>()),
  releaseScreen: async (id: string) => { steps.push(`screen ${rowGone(id)}`); },
  forgetBotFiles: async (id: string) => { steps.push(`files ${rowGone(id)}`); },
}));
vi.mock('../src/units.js', async (orig) => ({
  ...(await orig<typeof import('../src/units.js')>()),
  removeBotUnits: async (id: string) => { steps.push(`units ${rowGone(id)}`); },
}));
vi.mock('../src/routines.js', async (orig) => ({ ...(await orig<typeof import('../src/routines.js')>()), unscheduleRoutine: (id: string) => { steps.push(`unschedule ${id}`); } }));

const { deleteBot, finishDeletions } = await import('../src/bots.js');
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
  expect(steps).toEqual(['unschedule rt_x', 'engine true', 'screen true', 'units true', 'files true']);
  expect(db.prepare('SELECT 1 FROM routines WHERE id=?').get('rt_x')).toBeUndefined();
  expect(tombstone(bot.id)).toBe(false);
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

test("a deletion a restart cut short is finished at startup, and its gateway's port goes to no other bot until then", async () => {
  const engine = await vi.importActual<typeof import('../src/engine.js')>('../src/engine.js');
  const { requireBot } = await import('../src/store.js');
  const old = seedBot(userId, { name: 'Old' });
  db.prepare("UPDATE bots SET engine='managed', engine_port=8650 WHERE id=?").run(old.id);
  // What a server that stopped mid-deletion leaves: the record of the deletion, and no row.
  db.prepare("INSERT INTO deleted_bots(id,kind,engine_port,deleted_at) VALUES (?,'agent',8650,?)").run(old.id, now());
  db.prepare('DELETE FROM bots WHERE id=?').run(old.id);

  const fresh = seedBot(userId, { name: 'Fresh' });
  engine.assignEngine(fresh.id);
  expect(requireBot(fresh.id).engine_port).not.toBe(8650);
  steps.length = 0;
  await finishDeletions();
  expect(steps).toEqual(['engine true', 'screen true', 'units true', 'files true']);
  expect(tombstone(old.id)).toBe(false);
  const later = seedBot(userId, { name: 'Later' });
  engine.assignEngine(later.id);
  expect(requireBot(later.id).engine_port).toBe(8650);
});

test('a screen lease whose bot is gone with no record of its deletion is taken down too', async () => {
  db.prepare("INSERT INTO screens(bot_id,user_id,screen_id,last_used_at) VALUES ('bot_ghost',?,'screen-140',?)").run(userId, now());
  steps.length = 0;
  await finishDeletions();
  expect(steps).toEqual(['engine true', 'screen true', 'units true', 'files true']);
  expect(tombstone('bot_ghost')).toBe(false);
  db.prepare("DELETE FROM screens WHERE bot_id='bot_ghost'").run(); // releaseScreen is only recorded here
});
