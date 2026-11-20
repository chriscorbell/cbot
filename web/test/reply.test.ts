import { expect, test } from 'vitest';
import type { Row } from '@shared/types';
import { replyAction } from '../src/lib/reply';

const question = (generation: number, seq: number, status: 'pending' | 'answered' = 'pending'): Row => ({
  botId: 'bot_1', generation, seq, updatedSeq: seq, kind: 'card', createdAt: 0,
  body: { type: 'card', card: 'question', question: `Q${generation}`, options: ['A'], status },
});

test('a reply to an open question answers it', () => {
  expect(replyAction({ text: 'Q1', seq: 3, generation: 1 }, [question(1, 3)], false)).toEqual({ kind: 'answer', seq: 3, generation: 1 });
});

test('a reply to a question from a cleared chat never answers the new question at the same seq', () => {
  const action = replyAction({ text: 'Q1', seq: 3, generation: 1 }, [question(2, 3)], false);
  expect(action.kind).toBe('quote');
});

test('an answered question, or a reply with files, goes as a quoted message', () => {
  expect(replyAction({ text: 'Q1', seq: 3, generation: 1 }, [question(1, 3, 'answered')], false).kind).toBe('quote');
  const withFiles = replyAction({ text: 'line one\nline two', seq: 3, generation: 1 }, [question(1, 3)], true);
  expect(withFiles.kind === 'quote' && withFiles.message('mine')).toBe('> line one\n> line two\n\nmine');
});
