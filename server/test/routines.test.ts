import { expect, test } from 'vitest';
import { db, now } from '../src/db.js';
import { initRoutines, runRoutine } from '../src/routines.js';
import { appendRow, getBotRow, toBot } from '../src/store.js';
import type { Trigger } from '../src/agent/turns.js';
import { seedBot, seedOwner } from './helpers.js';

const userId = seedOwner().id;

test('a routine run starts a turn and adds nothing to the chat', () => {
  const bot = seedBot(userId);
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,enabled,created_at) VALUES ('rt_1',?,'Paper trading','Trade','0 8 * * *',0,?)").run(bot.id, now());
  const queued: Trigger[] = [];
  initRoutines((_, t) => { queued.push(t); return true; });
  expect(runRoutine('rt_1')).toBe('queued');
  expect(queued).toEqual([{ type: 'routine', routineId: 'rt_1', name: 'Paper trading', prompt: 'Trade' }]);
  expect(db.prepare('SELECT 1 FROM rows WHERE bot_id=?').all(bot.id)).toEqual([]);
});

test('a run the turn queue turns down, because the last one is still going, is not counted as run', () => {
  const bot = seedBot(userId);
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,enabled,created_at) VALUES ('rt_2',?,'Watch','Look','*/5 * * * *',1,?)").run(bot.id, now());
  initRoutines(() => false);
  expect(runRoutine('rt_2')).toBe('busy');
  expect(db.prepare<[], { last_run_at: number | null }>("SELECT last_run_at FROM routines WHERE id='rt_2'").get()!.last_run_at).toBeNull();
  expect(runRoutine('rt_nope')).toBe('off');
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
