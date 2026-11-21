import { expect, test } from 'vitest';
import { cutSentences, isAck, isEcho, planAnswer, speakable } from '../src/voice-relay.js';

test('sentences are cut at a stop and a space, or a line break, and the rest waits', () => {
  expect(cutSentences('Hi there. How are you? I am')).toEqual([['Hi there.', 'How are you?'], 'I am']);
  expect(cutSentences('One\nTwo')).toEqual([['One'], 'Two']);
  expect(cutSentences('"Done." Next')).toEqual([['"Done."'], 'Next']);
});

test('an abbreviation does not end a sentence', () => {
  expect(cutSentences('Ask Dr. Smith at 3 p.m. today. Then')).toEqual([['Ask Dr. Smith at 3 p.m. today.'], 'Then']);
});

test('speech gets no markdown, links or bullets', () => {
  expect(speakable('- **Bold** and [a link](https://x.y) `code`\n2. next')).toBe('Bold and a link code next');
});

const reply = (p: { state?: 'active' | 'done' | 'cancelled'; modelDone?: boolean; tools?: number; runId?: string | null }) =>
  ({ state: p.state ?? 'active', modelDone: p.modelDone ?? false, tools: new Set(Array.from({ length: p.tools ?? 0 }, (_, i) => String(i))), run: { id: 'runId' in p ? p.runId ?? null : 'run_1' } });

test('what the user saying something does to the reply in progress', () => {
  expect(planAnswer(null)).toBe('new');
  expect(planAnswer(reply({ state: 'done' }))).toBe('new');
  expect(planAnswer(reply({ tools: 1 }))).toBe('steer');
  expect(planAnswer(reply({ tools: 1, runId: null }))).toBe('stop-thinking');
  expect(planAnswer(reply({}))).toBe('stop-thinking');
  expect(planAnswer(reply({ modelDone: true }))).toBe('stop-speaking');
});

test('isAck: up to three words that only acknowledge', () => {
  expect(isAck('Yeah.')).toBe(true);
  expect(isAck('Mm-hmm')).toBe(true);
  expect(isAck('Okay, okay, cool.')).toBe(true);
  expect(isAck('Uh-huh')).toBe(true);
  expect(isAck('Yeah, but wait')).toBe(false);
  expect(isAck('No.')).toBe(false);
  expect(isAck('Stop.')).toBe(false);
  expect(isAck('yeah yeah yeah yeah')).toBe(false);
  expect(isAck('')).toBe(false);
});

test('isEcho: the bot heard back is its words in order, one in four misheard', () => {
  const saying = 'Yeah, loud and clear. How about me? I’ll check the 3 calendars now.';
  expect(isEcho('loud and clear', saying)).toBe(true);
  expect(isEcho('How about me.', saying)).toBe(true);
  expect(isEcho('Ill check the three calendars', saying)).toBe(true); // "3" read aloud
  expect(isEcho('clear loud', saying)).toBe(false); // out of order
  expect(isEcho('Wait, check the calendars', saying)).toBe(true); // three of four
  expect(isEcho('Wait, stop, check calendars', saying)).toBe(false);
  expect(isEcho('Can you hear me', 'I can hear you clearly.')).toBe(false);
  expect(isEcho('No', saying)).toBe(false);
  expect(isEcho('', saying)).toBe(false);
});
