import { beforeEach, expect, test } from 'vitest';
import type { Row } from '@shared/types';
import { sortedRows, useStore } from '../src/store';

const row = (seq: number, updatedSeq: number, text: string, generation = 1): Row => ({
  botId: 'bot_1', generation, seq, updatedSeq, kind: 'message', createdAt: seq,
  body: { type: 'message', role: 'assistant', text },
});
const texts = () => sortedRows(useStore.getState().transcripts.bot_1).map((r) => (r.body.type === 'message' ? r.body.text : ''));

beforeEach(() => useStore.setState({ transcripts: {} }));

test('a newer revision of a row replaces it; an older one does not', () => {
  const { upsertRows } = useStore.getState();
  upsertRows('bot_1', 1, [row(1, 1, 'Hel')]);
  upsertRows('bot_1', 1, [row(1, 3, 'Hello there')]);
  upsertRows('bot_1', 1, [row(1, 2, 'Hello')]);
  expect(texts()).toEqual(['Hello there']);
});

test('rows of an older conversation are ignored, and a newer one starts empty', () => {
  const { upsertRows } = useStore.getState();
  upsertRows('bot_1', 2, [row(1, 5, 'new chat')]);
  upsertRows('bot_1', 1, [row(2, 9, 'stale')]);
  expect(texts()).toEqual(['new chat']);
  upsertRows('bot_1', 3, [row(1, 1, 'newer chat', 3)]);
  expect(texts()).toEqual(['newer chat']);
});

test('"New chat" empties the transcript at the new generation', () => {
  const s = useStore.getState();
  s.upsertRows('bot_1', 1, [row(1, 1, 'old')]);
  s.clearTranscript('bot_1', 2);
  expect(useStore.getState().transcripts.bot_1).toMatchObject({ generation: 2, loaded: true });
  expect(texts()).toEqual([]);
});

test('after a reconnect, transcripts other than the open one are refetched when opened', () => {
  const s = useStore.getState();
  useStore.setState({ selectedBotId: 'bot_1', transcripts: {
    bot_1: { generation: 1, bySeq: {}, loaded: true },
    bot_2: { generation: 1, bySeq: {}, loaded: true },
  } });
  s.markTranscriptsStale();
  expect(useStore.getState().transcripts.bot_1.loaded).toBe(true);
  expect(useStore.getState().transcripts.bot_2.loaded).toBe(false);
});
