// What a voice call is told of the text chat, run by run (agent/catchup.ts).
import { beforeAll, expect, test } from 'vitest';
import { chatCursor, chatNews } from '../src/agent/catchup.js';
import { appendRow, clearConversation, updateRow } from '../src/store.js';
import type { MessageBody } from '../src/types.js';
import { seedBot, seedOwner } from './helpers.js';

let userId: string;
beforeAll(() => { userId = seedOwner().id; });

const say = (botId: string, body: Omit<MessageBody, 'type'>) => appendRow(botId, 'message', { type: 'message', ...body });
/** The note's lines, without the header and the time each line ends with. */
const lines = (note: string | null) => note?.slice(1, -1).split('\n').slice(1).map((l) => l.replace(/ \([^)]*\)$/, ''));

test('a call hears what is new in the chat once, and nothing it already had', () => {
  const bot = seedBot(userId);
  say(bot.id, { role: 'user', text: 'Before the call' });
  const cursor = chatCursor(bot.id);
  expect(chatNews(bot.id, 'call_1', cursor, 'Chris')).toBeNull();

  say(bot.id, { role: 'user', text: 'Find flights to Tokyo' });
  appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which airport?', options: ['HND', 'NRT'], status: 'pending' });
  expect(lines(chatNews(bot.id, 'call_1', cursor, 'Chris'))).toEqual(['- Chris: Find flights to Tokyo', "- Your question, waiting for Chris's answer: Which airport?"]);
  expect(chatNews(bot.id, 'call_1', cursor, 'Chris')).toBeNull();
});

test('a reply is told when it is finished, not while it streams or is a note', () => {
  const bot = seedBot(userId);
  const cursor = chatCursor(bot.id);
  const row = say(bot.id, { role: 'assistant', text: 'Looking', streaming: true });
  const note = say(bot.id, { role: 'assistant', text: 'Checking the airline site', note: true });
  expect(chatNews(bot.id, 'call_1', cursor, 'Chris')).toBeNull();

  updateRow(row, { type: 'message', role: 'assistant', text: 'Three flights found.', streaming: false });
  // The turn's last note becomes its answer.
  updateRow(note, { type: 'message', role: 'assistant', text: 'Checking the airline site' });
  expect(lines(chatNews(bot.id, 'call_1', cursor, 'Chris'))).toEqual(['- You: Three flights found.', '- You: Checking the airline site']);

  // A reaction rewrites the row; it isn't news again.
  updateRow(row, { type: 'message', role: 'assistant', text: 'Three flights found.', streaming: false, reaction: '👍' });
  expect(chatNews(bot.id, 'call_1', cursor, 'Chris')).toBeNull();
});

test("the call's own posts are left out; another call's, other bots' and the app's notices are told", () => {
  const bot = seedBot(userId);
  const cursor = chatCursor(bot.id);
  say(bot.id, { role: 'assistant', text: 'https://example.com', call: 'call_1' });
  say(bot.id, { role: 'user', text: 'Done with the report', from: { kind: 'bot', id: 'bot_x', name: 'Ada' } });
  appendRow(bot.id, 'notice', { type: 'notice', text: 'Stopped.', tone: 'info' });
  expect(lines(chatNews(bot.id, 'call_1', cursor, 'Chris'))).toEqual(['- Ada, another Bot: Done with the report', '- Notice from the app: Stopped.']);
});

test('after New chat, the call hears the new chat', () => {
  const bot = seedBot(userId);
  const cursor = chatCursor(bot.id);
  say(bot.id, { role: 'user', text: 'Old chat' });
  clearConversation(bot.id);
  say(bot.id, { role: 'user', text: 'New chat' });
  expect(lines(chatNews(bot.id, 'call_1', cursor, 'Chris'))).toEqual(['- Chris: New chat']);
});

test('a long stretch of chat is cut to its newest lines', () => {
  const bot = seedBot(userId);
  const cursor = chatCursor(bot.id);
  for (let i = 1; i <= 15; i++) say(bot.id, { role: 'user', text: `Message ${i}` });
  const told = lines(chatNews(bot.id, 'call_1', cursor, 'Chris'))!;
  expect(told[0]).toBe('(3 earlier left out)');
  expect(told.slice(1)).toEqual(Array.from({ length: 12 }, (_, i) => `- Chris: Message ${i + 4}`));
});
