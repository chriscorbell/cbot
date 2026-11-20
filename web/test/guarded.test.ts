import { expect, test, vi } from 'vitest';


const { guarded } = await import('../src/lib/guarded');
const { botSettingsOpenFor, useConfigUI } = await import('../src/configStore');

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('an answer that comes back while the panel still shows its bot is handed on', async () => {
  const done = vi.fn(); const settled = vi.fn();
  await guarded(() => true, async () => 'ok', { done, settled });
  expect(done).toHaveBeenCalledWith('ok');
  expect(settled).toHaveBeenCalled();
});

test('a sign-in that finishes after the panel closed or moved on opens nothing', async () => {
  let shown = 'bot_a';
  const req = deferred<void>();
  const openViewer = vi.fn(); const settled = vi.fn();
  const running = guarded(() => shown === 'bot_a', () => req.promise, { done: openViewer, settled });
  shown = 'bot_b'; // switched bots (or closed the panel) while the request was out
  req.resolve();
  await running;
  expect(openViewer).not.toHaveBeenCalled();
  expect(settled).not.toHaveBeenCalled();
});

test("a failed save that comes back after switching bots doesn't show its error on the new bot", async () => {
  let shown = 'bot_a';
  const req = deferred<void>();
  const failed = vi.fn();
  const running = guarded(() => shown === 'bot_a', () => req.promise, { failed });
  shown = 'bot_b';
  req.reject(new Error('nope'));
  await running;
  expect(failed).not.toHaveBeenCalled();
});

test('closing bot settings drops a sign-in still out, even while the dialog animates away', async () => {
  // EngineSettings asks this (plus mounted and same bot); the dialog stays mounted 160 ms after closing.
  useConfigUI.getState().openBotSettings('bot_a', 'engine');
  const req = deferred<void>();
  const openViewer = vi.fn();
  const running = guarded(() => botSettingsOpenFor('bot_a'), () => req.promise, { done: openViewer });
  useConfigUI.getState().closeBotSettings();
  req.resolve();
  await running;
  expect(openViewer).not.toHaveBeenCalled();
});

test('a retried load that fails after settings moved to another bot leaves that bot alone', async () => {
  useConfigUI.getState().openBotSettings('bot_a', 'engine');
  const req = deferred<void>();
  const markUnavailable = vi.fn();
  const running = guarded(() => botSettingsOpenFor('bot_a'), () => req.promise, { failed: markUnavailable });
  useConfigUI.getState().openBotSettings('bot_b', 'engine');
  req.reject(new Error('down'));
  await running;
  expect(markUnavailable).not.toHaveBeenCalled();
});

test('actions out on two bots at once each keep their own busy state', async () => {
  const { PendingActions } = await import('../src/lib/guarded');
  const pending = new PendingActions<'save' | 'restart'>();
  const a = pending.start('bot_a', 'save');
  const b = pending.start('bot_b', 'restart');
  // Back on A while both are out: A shows its own save, not idle.
  expect(pending.kindFor('bot_a')).toBe('save');
  expect(pending.kindFor('bot_b')).toBe('restart');
  expect(pending.end('bot_a', a)).toBe(true);
  expect(pending.kindFor('bot_a')).toBeNull();
  // An older action on B ending after a newer one started doesn't clear the newer one's busy state.
  const b2 = pending.start('bot_b', 'save');
  expect(pending.end('bot_b', b)).toBe(false);
  expect(pending.kindFor('bot_b')).toBe('save');
  expect(pending.end('bot_b', b2)).toBe(true);
});
