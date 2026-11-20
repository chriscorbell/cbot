import { beforeAll, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../src/routines.js', async (orig) => ({ ...(await orig<typeof import('../src/routines.js')>()), scheduleRoutine: () => {}, unscheduleRoutine: vi.fn() }));

const { TOOLS, inputSchema, runTool, toolMap } = await import('../src/agent/tools.js');
const routines = await import('../src/routines.js');
const { db, now } = await import('../src/db.js');
const { seedBot, seedOwner } = await import('./helpers.js');
const { conversation } = await import('../src/store.js');

let userId: string;
beforeAll(() => { userId = seedOwner().id; });
const ctx = (botId: string) => ({ userId, botId, convo: conversation(botId), depth: 0, enqueueBotMessage: () => {} });

test('the tools Hermes is offered are exactly the ones recorded in fixtures/mcp-tools.json', () => {
  // Hermes reads these when it connects; changing one changes what every bot's model sees.
  // Update the fixture on purpose, never to make this pass by accident.
  // UPDATE_FIXTURES=1 npm test -w server rewrites the file from the code; review the diff.
  const file = path.join(import.meta.dirname, 'fixtures/mcp-tools.json');
  const offered = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) }));
  if (process.env.UPDATE_FIXTURES === '1') fs.writeFileSync(file, `${JSON.stringify(offered, null, 2)}\n`);
  expect(offered).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('a call whose arguments do not fit is refused before the tool runs', async () => {
  const bot = seedBot(userId);
  const r = await runTool(toolMap.get('delete_routine')!, { routine_id: 5 }, ctx(bot.id));
  expect(r.invalid).toBe(true);
  expect(r.output).toMatch(/Invalid arguments for delete_routine/);
});

test('unknown extra arguments are ignored, as before', async () => {
  const bot = seedBot(userId);
  const r = await runTool(toolMap.get('list_routines')!, { verbose: true }, ctx(bot.id));
  expect(r.invalid).toBeUndefined();
  expect(JSON.parse(r.output)).toEqual([]);
});

test("a bot cannot delete or unschedule another bot's routine", async () => {
  const a = seedBot(userId, { name: 'A' });
  const b = seedBot(userId, { name: 'B' });
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at) VALUES ('rt_a',?,'r','p','0 8 * * *',?)").run(a.id, now());
  const r = await runTool(toolMap.get('delete_routine')!, { routine_id: 'rt_a' }, ctx(b.id));
  expect(r.output).toBe('No such routine.');
  expect(routines.unscheduleRoutine).not.toHaveBeenCalled();
  expect(db.prepare("SELECT 1 FROM routines WHERE id='rt_a'").get()).toBeTruthy();
});

test("a tool's rows go to the conversation of the turn that called it", async () => {
  const bot = seedBot(userId);
  const { clearConversation, listRows } = await import('../src/store.js');
  const old = conversation(bot.id);
  clearConversation(bot.id);
  await runTool(toolMap.get('ask_user')!, { question: 'Which?', options: ['A'] }, { ...ctx(bot.id), convo: old });
  expect(listRows(bot.id)).toEqual([]);
});
