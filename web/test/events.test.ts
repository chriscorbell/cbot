import { beforeEach, expect, test, vi } from 'vitest';
import type { Bot, LiveState } from '@shared/types';

vi.mock('../src/lib/api', async (orig) => ({
  ...(await orig<typeof import('../src/lib/api')>()),
  api: { patchRow: vi.fn(), rows: vi.fn(), markRead: vi.fn(async () => ({ ok: true })), markUnread: vi.fn(async () => ({ ok: true })), routines: vi.fn(async () => ({ routines: [] })), bots: vi.fn(async () => ({ bots: [], live: [] })) },
}));

const { applyServerEvent } = await import('../src/lib/events');
const { useStore } = await import('../src/store');
const { useConfigUI } = await import('../src/configStore');
const { api } = await import('../src/lib/api');

const bot = (id: string, p: Partial<Bot> = {}): Bot => ({
  id, name: id, label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue', isPrimary: false,
  kind: 'agent', effort: 'medium', voice: 'v', voiceSpeed: 1, model: null, provider: null, generation: 1, unread: 0,
  lastPreview: null, lastActivityAt: 0, createdAt: 0, ...p,
});

beforeEach(() => {
  useStore.setState({ bots: [bot('bot_1')], live: {}, transcripts: {}, routines: {}, selectedBotId: 'bot_1' });
  useConfigUI.setState({ versions: {} });
});

test('live, bot and computer events update the store', () => {
  const running: LiveState = { botId: 'bot_1', isRunning: true, activity: { kind: 'thinking', since: 1 }, startedAt: 1, caption: null };
  applyServerEvent({ type: 'live', state: running });
  expect(useStore.getState().live.bot_1).toEqual(running);
  applyServerEvent({ type: 'bot', bot: bot('bot_2', { name: 'Two' }) });
  expect(useStore.getState().bots.map((b) => b.id)).toEqual(['bot_1', 'bot_2']);
  applyServerEvent({ type: 'bot', bot: bot('bot_1', { name: 'Renamed' }) });
  expect(useStore.getState().bots[0].name).toBe('Renamed');
  applyServerEvent({ type: 'computer', state: { status: 'running', error: null, screens: [] } });
  expect(useStore.getState().computer?.status).toBe('running');
});

test('memories events move the version open views watch', () => {
  applyServerEvent({ type: 'memories', botId: 'bot_1' });
  expect(useConfigUI.getState().versions).toEqual({ 'memories:bot_1': 1 });
});

test('a reaction shows at once and is rolled back if the server refuses it', async () => {
  const row = { botId: 'bot_1', generation: 1, seq: 3, updatedSeq: 3, kind: 'message' as const, createdAt: 0, body: { type: 'message' as const, role: 'assistant' as const, text: 'hi' } };
  useStore.getState().upsertRows('bot_1', 1, [row]);
  let fail!: (e: Error) => void;
  vi.mocked(api.patchRow).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  const pending = useStore.getState().patchRow('bot_1', 3, { reaction: '👍' });
  expect(useStore.getState().transcripts.bot_1.bySeq[3].body).toMatchObject({ reaction: '👍' });
  fail(new Error('nope'));
  await expect(pending).rejects.toThrow('nope');
  expect(useStore.getState().transcripts.bot_1.bySeq[3].body).not.toHaveProperty('reaction');
});

test('a refused reaction is not rolled back over a newer version of the row', async () => {
  const row = { botId: 'bot_1', generation: 1, seq: 3, updatedSeq: 3, kind: 'message' as const, createdAt: 0, body: { type: 'message' as const, role: 'assistant' as const, text: 'hi' } };
  useStore.getState().upsertRows('bot_1', 1, [row]);
  let fail!: (e: Error) => void;
  vi.mocked(api.patchRow).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  const pending = useStore.getState().patchRow('bot_1', 3, { reaction: '👍' });
  // The server rewrote the row meanwhile (say, the bot finished streaming it).
  useStore.getState().upsertRows('bot_1', 1, [{ ...row, updatedSeq: 9, body: { ...row.body, text: 'hi there' } }]);
  fail(new Error('nope'));
  await expect(pending).rejects.toThrow();
  expect(useStore.getState().transcripts.bot_1.bySeq[3].body).toMatchObject({ text: 'hi there' });
});

test('two refused reactions in a row end on what the server has, not on the first one', async () => {
  const row = { botId: 'bot_1', generation: 1, seq: 4, updatedSeq: 4, kind: 'message' as const, createdAt: 0, body: { type: 'message' as const, role: 'assistant' as const, text: 'hi' } };
  useStore.getState().upsertRows('bot_1', 1, [row]);
  vi.mocked(api.rows).mockResolvedValue({ generation: 1, rows: [row] });
  const fails: ((e: Error) => void)[] = [];
  vi.mocked(api.patchRow).mockImplementation(() => new Promise((_, reject) => { fails.push(reject); }));
  const a = useStore.getState().patchRow('bot_1', 4, { reaction: '👍' });
  const b = useStore.getState().patchRow('bot_1', 4, { reaction: '🎉' });
  expect(useStore.getState().transcripts.bot_1.bySeq[4].body).toMatchObject({ reaction: '🎉' });
  fails[0](new Error('no'));
  await expect(a).rejects.toThrow();
  fails[1](new Error('no'));
  await expect(b).rejects.toThrow();
  await vi.waitFor(() => expect(useStore.getState().transcripts.bot_1.bySeq[4].body).not.toHaveProperty('reaction'));
});

test('a bot marked unread while open stays unread until a bot is picked again, like an inbox', () => {
  const doc = document as unknown as { visibilityState: string };
  doc.visibilityState = 'visible';
  try {
    const loaded = { generation: 1, bySeq: {}, loaded: true };
    useStore.setState({ bots: [bot('bot_1'), bot('bot_2')], selectedBotId: 'bot_1', keptUnread: null, transcripts: { bot_1: loaded, bot_2: loaded } });
    vi.mocked(api.markRead).mockClear();

    // Without a mark, the open bot is read as messages come in.
    applyServerEvent({ type: 'bot', bot: bot('bot_1', { unread: 1 }) });
    expect(api.markRead).toHaveBeenCalledWith('bot_1');
    vi.mocked(api.markRead).mockClear();

    useStore.getState().markUnread('bot_1');
    expect(api.markUnread).toHaveBeenCalledWith('bot_1');
    expect(useStore.getState().bots.find((b) => b.id === 'bot_1')?.unread).toBe(1);
    // The server's echo of the mark, and a message after it, leave it unread.
    applyServerEvent({ type: 'bot', bot: bot('bot_1', { unread: 1 }) });
    applyServerEvent({ type: 'bot', bot: bot('bot_1', { unread: 2 }) });
    expect(api.markRead).not.toHaveBeenCalled();

    // Moving to another bot leaves it unread; coming back to it reads it.
    useStore.getState().selectBot('bot_2');
    expect(api.markRead).not.toHaveBeenCalled();
    useStore.getState().selectBot('bot_1');
    expect(api.markRead).toHaveBeenCalledWith('bot_1');
    expect(useStore.getState().keptUnread).toBeNull();
  } finally {
    doc.visibilityState = 'hidden';
  }
});
