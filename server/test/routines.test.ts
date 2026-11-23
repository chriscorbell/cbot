import { expect, test, vi } from 'vitest';
import type { Captured } from '../src/precheck.js';

// A precheck is a shell command run as the bots' account, which tests can't start: each test says what
// it printed instead. What becomes of that (verdict) is the real code.
const runPrecheck = vi.fn<(botId: string, command: string) => Promise<Captured>>();
vi.mock('../src/precheck.js', async (orig) => ({ ...(await orig<typeof import('../src/precheck.js')>()), runPrecheck: (botId: string, command: string) => runPrecheck(botId, command) }));

const { db, now } = await import('../src/db.js');
const { initRoutines, runRoutine } = await import('../src/routines.js');
const { appendRow, getBotRow, getRoutine, toBot } = await import('../src/store.js');
const { seedBot, seedOwner } = await import('./helpers.js');
type Trigger = import('../src/agent/turns.js').Trigger;

const userId = seedOwner().id;
const printed = (p: Partial<Captured>): Captured => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...p });

/** A routine with a precheck, and the turns its runs queue. */
function watcher(id: string, precheck = './new-orders.sh') {
  const bot = seedBot(userId);
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,enabled,created_at,precheck) VALUES (?,?,'Sales','Tell me about new orders','*/5 * * * *',0,?,?)").run(id, bot.id, now(), precheck);
  const queued: Trigger[] = [];
  initRoutines((_, t) => { queued.push(t); return true; }, () => false);
  return { bot, queued };
}

test('a routine run starts a turn and adds nothing to the chat', async () => {
  const bot = seedBot(userId);
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,enabled,created_at) VALUES ('rt_1',?,'Paper trading','Trade','0 8 * * *',0,?)").run(bot.id, now());
  const queued: Trigger[] = [];
  initRoutines((_, t) => { queued.push(t); return true; }, () => false);
  expect(await runRoutine('rt_1')).toBe('queued');
  expect(queued).toEqual([{ type: 'routine', routineId: 'rt_1', name: 'Paper trading', prompt: 'Trade' }]);
  expect(db.prepare('SELECT 1 FROM rows WHERE bot_id=?').all(bot.id)).toEqual([]);
});

test('a run the turn queue turns down, because the last one is still going, is not counted as run', async () => {
  const bot = seedBot(userId);
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,enabled,created_at) VALUES ('rt_2',?,'Watch','Look','*/5 * * * *',1,?)").run(bot.id, now());
  initRoutines(() => false, () => false);
  expect(await runRoutine('rt_2')).toBe('busy');
  expect(db.prepare<[], { last_run_at: number | null }>("SELECT last_run_at FROM routines WHERE id='rt_2'").get()!.last_run_at).toBeNull();
  expect(await runRoutine('rt_nope')).toBe('off');
});

test("a chat's preview skips the routine-run lines older chats have", () => {
  const bot = seedBot(userId);
  appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: 'Bought 10 shares' });
  for (let i = 0; i < 10; i++) appendRow(bot.id, 'event', { type: 'event', event: 'routine-run', text: 'Running routine: Paper trading', ref: 'rt_1' });
  expect(toBot(getBotRow(bot.id)!).lastPreview).toBe('Bought 10 shares');
});

test("a chat's preview skips the bot's notes and its teammates' messages to it, which the chat doesn't show", () => {
  const bot = seedBot(userId);
  const theo = seedBot(userId, { name: 'Theo' });
  appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: 'Stripe is the one thing left for you' });
  for (let i = 0; i < 10; i++) {
    appendRow(bot.id, 'message', { type: 'message', role: 'user', text: `Task ${i} done`, from: { kind: 'bot', id: theo.id, name: 'Theo' } });
    appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: 'Noted.', note: true });
  }
  expect(toBot(getBotRow(bot.id)!).lastPreview).toBe('Stripe is the one thing left for you');
});

test("a precheck that prints something wakes the run, with what it printed after the routine's prompt", async () => {
  const { bot, queued } = watcher('rt_wake');
  runPrecheck.mockResolvedValueOnce(printed({ stdout: 'Order 41: 2 chairs\nOrder 42: 1 desk\n' }));
  expect(await runRoutine('rt_wake')).toBe('queued');
  expect(runPrecheck).toHaveBeenLastCalledWith(bot.id, './new-orders.sh');
  expect(queued).toEqual([{
    type: 'routine', routineId: 'rt_wake', name: 'Sales',
    prompt: 'Tell me about new orders\n\n[Its precheck printed this:]\nOrder 41: 2 chairs\nOrder 42: 1 desk',
  }]);
  expect(getRoutine('rt_wake')).toMatchObject({ lastRunAt: expect.any(Number), lastSkippedAt: null });
});

test("a precheck's output is clipped before it reaches the run", async () => {
  const { queued } = watcher('rt_long');
  runPrecheck.mockResolvedValueOnce(printed({ stdout: 'x'.repeat(20_000) }));
  expect(await runRoutine('rt_long')).toBe('queued');
  const prompt = queued[0].type === 'routine' ? queued[0].prompt : '';
  expect(prompt.length).toBeLessThan(8200);
  expect(prompt.endsWith('\n[… the rest was cut]')).toBe(true);
});

test('a precheck that prints nothing skips the run without a turn, as nothing to do', async () => {
  const { bot, queued } = watcher('rt_quiet');
  runPrecheck.mockResolvedValueOnce(printed({ stdout: ' \n', stderr: 'checked 3 feeds' }));
  expect(await runRoutine('rt_quiet')).toEqual({ skipped: null });
  expect(queued).toEqual([]);
  expect(getRoutine('rt_quiet')).toMatchObject({ lastRunAt: null, lastSkippedAt: expect.any(Number), lastSkipReason: null });
  expect(db.prepare('SELECT 1 FROM rows WHERE bot_id=?').all(bot.id)).toEqual([]);
});

test('a precheck that fails skips the run and keeps why, so it shows', async () => {
  const { queued } = watcher('rt_broken');
  runPrecheck.mockResolvedValueOnce(printed({ code: 2, stdout: 'half an answer', stderr: 'reading orders\ngrep: orders.csv: No such file or directory\n' }));
  expect(await runRoutine('rt_broken')).toEqual({ skipped: 'exited with code 2: reading orders grep: orders.csv: No such file or directory' });
  expect(getRoutine('rt_broken')!.lastSkipReason).toBe('exited with code 2: reading orders grep: orders.csv: No such file or directory');

  // Only the end of a long error is kept.
  runPrecheck.mockResolvedValueOnce(printed({ code: 1, stderr: `${'noise '.repeat(200)}the real reason` }));
  const long = await runRoutine('rt_broken');
  expect(typeof long === 'object' && long.skipped).toMatch(/^exited with code 1: ….*the real reason$/);
  expect(getRoutine('rt_broken')!.lastSkipReason!.length).toBeLessThan(330);

  runPrecheck.mockResolvedValueOnce(printed({ code: null, timedOut: true, stdout: 'late' }));
  expect(await runRoutine('rt_broken')).toEqual({ skipped: 'took longer than 30 seconds and was stopped' });
  runPrecheck.mockResolvedValueOnce(printed({ code: null, error: 'spawn setpriv ENOENT' }));
  expect(await runRoutine('rt_broken')).toEqual({ skipped: 'couldn’t start: spawn setpriv ENOENT' });
  runPrecheck.mockResolvedValueOnce(printed({ code: null, signal: 'SIGSEGV' }));
  expect(await runRoutine('rt_broken')).toEqual({ skipped: 'was stopped by SIGSEGV' });
  expect(queued).toEqual([]);
  expect(getRoutine('rt_broken')!.lastRunAt).toBeNull();
});

test("a precheck doesn't run while the routine's last run is still going, so what it finds isn't lost", async () => {
  watcher('rt_busy');
  initRoutines(() => true, (_, routineId) => routineId === 'rt_busy');
  runPrecheck.mockClear();
  expect(await runRoutine('rt_busy')).toBe('busy');
  expect(runPrecheck).not.toHaveBeenCalled();
});

test('a routine fired again while its precheck runs starts no second one', async () => {
  const { queued } = watcher('rt_twice');
  let answer!: (c: Captured) => void;
  runPrecheck.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  const first = runRoutine('rt_twice');
  expect(await runRoutine('rt_twice')).toBe('busy');
  answer(printed({ stdout: 'new' }));
  expect(await first).toBe('queued');
  expect(queued).toHaveLength(1);
});

test('a routine deleted while its precheck ran is not run', async () => {
  const { queued } = watcher('rt_gone');
  runPrecheck.mockImplementationOnce(async () => {
    db.prepare("DELETE FROM routines WHERE id='rt_gone'").run();
    return printed({ stdout: 'new' });
  });
  expect(await runRoutine('rt_gone')).toBe('off');
  expect(queued).toEqual([]);
});
