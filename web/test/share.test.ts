import { afterEach, expect, test, vi } from 'vitest';
import type { Bot, Row } from '@shared/types';

vi.mock('../src/lib/api', async (orig) => ({
  ...(await orig<typeof import('../src/lib/api')>()),
  api: { rows: vi.fn() },
}));

const { copyConversation } = await import('../src/lib/share');
const { useStore } = await import('../src/store');
const { api } = await import('../src/lib/api');

const bot = { id: 'bot_1', name: 'Nova' } as Bot;
const msg = (seq: number, role: 'user' | 'assistant', text: string): Row =>
  ({ botId: 'bot_1', generation: 1, seq, updatedSeq: seq, kind: 'message', body: { type: 'message', role, text }, createdAt: Date.UTC(2026, 10, 16, 15, seq) });

let copied: string[] = [];
const clipboard = (withItems: boolean) => {
  copied = [];
  const writeText = vi.fn(async (t: string) => { copied.push(t); });
  const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => { copied.push(await (await items[0].data['text/plain']).text()); });
  vi.stubGlobal('navigator', { clipboard: withItems ? { write, writeText } : { writeText } });
  if (withItems) vi.stubGlobal('ClipboardItem', class { constructor(public data: Record<string, Promise<Blob>>) {} });
  return { write, writeText };
};
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(api.rows).mockReset(); });

test('a bot whose chat is not loaded has its rows fetched, in order, and copied as one promise', async () => {
  useStore.setState({ transcripts: {} });
  vi.mocked(api.rows).mockResolvedValue({ generation: 1, rows: [msg(2, 'assistant', 'Hi there.'), msg(1, 'user', 'Hello?')] });
  const { write, writeText } = clipboard(true);
  await copyConversation(bot);
  expect(write).toHaveBeenCalledTimes(1);
  expect(writeText).not.toHaveBeenCalled();
  expect(copied[0]).toMatch(/^# Nova\n/);
  expect(copied[0].indexOf('Hello?')).toBeLessThan(copied[0].indexOf('Hi there.'));
});

test('an open chat is copied from what is loaded, and plain text is the fallback', async () => {
  useStore.setState({ transcripts: { bot_1: { generation: 1, loaded: true, bySeq: { 1: msg(1, 'user', 'Loaded already') } } } });
  const { writeText } = clipboard(false);
  await copyConversation(bot);
  expect(api.rows).not.toHaveBeenCalled();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(copied[0]).toContain('**You**');
  expect(copied[0]).toContain('Loaded already');
});
