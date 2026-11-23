import { beforeAll, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../src/routines.js', async (orig) => ({ ...(await orig<typeof import('../src/routines.js')>()), scheduleRoutine: () => {}, unscheduleRoutine: vi.fn() }));

const { TOOLS, inputSchema, runTool, toolMap } = await import('../src/agent/tools.js');
const routines = await import('../src/routines.js');
const { db, now } = await import('../src/db.js');
const { seedBot, seedOwner } = await import('./helpers.js');
const { conversation, requireBot } = await import('../src/store.js');

let userId: string;
beforeAll(() => { userId = seedOwner().id; });
const ctx = (botId: string) => ({ userId, botId, workspaceId: requireBot(botId).workspace_id, convo: conversation(botId), depth: 0, asking: 0, enqueueBotMessage: () => {}, wake: () => {}, addTeammate: () => ({ error: 'not in this test' }), updatePersona: () => [], setModel: () => [], modelOffers: async () => ({ offers: [] }) });

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

test("a routine's precheck is set with it, changed, and cleared by an empty one; the primary bot sets a teammate's", async () => {
  const lead = seedBot(userId, { name: 'Pia', isPrimary: true });
  const sol = seedBot(userId, { name: 'Sol' });
  const made = await runTool(toolMap.get('create_routine')!, { name: 'Sales', prompt: 'Tell me about new orders', schedule: '*/5 * * * *', precheck: '  ./new-orders.sh ', bot_name: 'Sol' }, ctx(lead.id));
  const { routine } = JSON.parse(made.output) as { routine: { id: string; botId: string; precheck: string } };
  expect(routine).toMatchObject({ botId: sol.id, precheck: './new-orders.sh', lastSkippedAt: null, lastSkipReason: null });

  const changed = await runTool(toolMap.get('update_routine')!, { routine_id: routine.id, precheck: 'tail -n 5 sales.log' }, ctx(lead.id));
  expect(JSON.parse(changed.output)).toMatchObject({ ok: true, routine: { precheck: 'tail -n 5 sales.log', prompt: 'Tell me about new orders' } });
  // Changing something else leaves it.
  await runTool(toolMap.get('update_routine')!, { routine_id: routine.id, name: 'Orders' }, ctx(sol.id));
  expect(db.prepare<[string], { precheck: string }>('SELECT precheck FROM routines WHERE id=?').get(routine.id)!.precheck).toBe('tail -n 5 sales.log');
  await runTool(toolMap.get('update_routine')!, { routine_id: routine.id, precheck: '' }, ctx(sol.id));
  expect(db.prepare<[string], { precheck: string }>('SELECT precheck FROM routines WHERE id=?').get(routine.id)!.precheck).toBe('');

  const mine = await runTool(toolMap.get('create_routine')!, { name: 'Digest', prompt: 'Recap', schedule: '0 8 * * *' }, ctx(sol.id));
  expect(JSON.parse(mine.output)).toMatchObject({ routine: { precheck: '' } });
});

test("a tool's rows go to the conversation of the turn that called it", async () => {
  const bot = seedBot(userId);
  const { clearConversation, listRows } = await import('../src/store.js');
  const old = conversation(bot.id);
  clearConversation(bot.id);
  await runTool(toolMap.get('ask_user')!, { question: 'Which?', options: ['A'] }, { ...ctx(bot.id), convo: old });
  expect(listRows(bot.id)).toEqual([]);
});
