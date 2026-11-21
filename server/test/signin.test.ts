// Signing in to a subscription with a link and a code, with nothing on a bot's screen: Hermes signs a
// bot's home in to ChatGPT or Grok in the background, and GitHub's device flow gives the Copilot token
// every bot shares.
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';

/** A `hermes auth add` that prints and exits when the test says so. */
class FakeHermes extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  print(text: string) { this.stdout.emit('data', Buffer.from(text)); }
  exit(code: number) { this.exitCode = code; this.emit('close', code, null); }
  kill(signal: NodeJS.Signals = 'SIGTERM') { this.signalCode = signal; this.emit('close', null, signal); return true; }
}

const spawned: { cmd: string; args: string[]; opts: SpawnOptions; child: FakeHermes }[] = [];
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const spawn = (cmd: string, args: string[], opts: SpawnOptions) => { const child = new FakeHermes(); spawned.push({ cmd, args, opts, child }); return child; };
  return { ...real, spawn, default: { ...real, spawn } };
});

const forgotten: string[] = [];
vi.mock('../src/engine.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine.js')>()),
  engineHome: (botId: string) => `/homes/${botId}`,
  forgetEngineOptions: (botId: string) => { forgotten.push(botId); },
}));

const saved: unknown[] = [];
vi.mock('../src/providers.js', () => ({ saveProviderSettings: (patch: unknown) => { saved.push(patch); return true; } }));

const { cancelBotSignIns, cancelSignIn, deviceCode, getSignIn, startSignIn } = await import('../src/signin.js');

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const CHATGPT = 'Signing in to OpenAI Codex...\n(Hermes creates its own session — won\'t affect Codex CLI or VS Code)\n\nTo continue, follow these steps:\n\n'
  + '  1. Open this URL in your browser:\n     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n  2. Enter this code:\n     \x1b[94mSJ18-ITJ1B\x1b[0m\n\nWaiting for sign-in... (press Ctrl+C to cancel)\n';
const GROK = '\nTo continue:\n  1. Open: https://accounts.x.ai/oauth2/device?user_code=GSFD-VAWQ\n  2. If prompted, enter code: GSFD-VAWQ\n  (Opened browser for verification)\nWaiting for approval (polling every 5s)...\n';

test('the link and code are read from what Hermes prints, once whole lines hold both', () => {
  expect(deviceCode(`hermes: preparing dependencies, see https://hermes.example/docs\n${CHATGPT}`)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'SJ18-ITJ1B' });
  expect(deviceCode(GROK)).toEqual({ url: 'https://accounts.x.ai/oauth2/device?user_code=GSFD-VAWQ', code: 'GSFD-VAWQ' });
  // Half a line could be half a code.
  expect(deviceCode(CHATGPT.slice(0, CHATGPT.indexOf('SJ18-ITJ1B') + 7))).toBeNull();
  expect(deviceCode('Waiting...\n')).toBeNull();
});

test("a ChatGPT sign-in runs Hermes for the bot's home with no terminal, answers with the code, and finishes when Hermes does", async () => {
  const started = startSignIn('u1', 'openai-codex', 'bot1');
  const { cmd, args, opts, child } = spawned.at(-1)!;
  expect([cmd, ...args]).toEqual(['hermes', 'auth', 'add', 'openai-codex']);
  expect(opts.stdio?.[0]).toBe('ignore');
  expect(opts.env).toMatchObject({ HERMES_HOME: '/homes/bot1', BROWSER: 'true' });
  expect(opts.env?.DISPLAY).toBeUndefined();

  child.print(CHATGPT);
  const s = await started;
  expect(s).toMatchObject({ provider: 'openai-codex', name: 'ChatGPT', status: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'SJ18-ITJ1B', error: null });

  child.exit(0);
  expect(getSignIn('u1', s.id)?.status).toBe('done');
  expect(forgotten).toContain('bot1');
});

test('asking again while it waits gives the same code; asking for another provider cancels it', async () => {
  const first = startSignIn('u1', 'openai-codex', 'bot2');
  const codex = spawned.at(-1)!.child;
  codex.print(CHATGPT);
  const a = await first;
  const again = await startSignIn('u1', 'openai-codex', 'bot2');
  expect(again.id).toBe(a.id);
  expect(spawned.at(-1)!.child).toBe(codex);

  const next = startSignIn('u1', 'xai-oauth', 'bot2');
  expect(codex.signalCode).toBe('SIGTERM');
  expect(getSignIn('u1', a.id)?.status).toBe('cancelled');
  const grok = spawned.at(-1)!.child;
  grok.print(GROK);
  expect(await next).toMatchObject({ name: 'Grok', status: 'waiting', code: 'GSFD-VAWQ' });
});

test("a sign-in is its starter's: no one else can see or cancel it, and a deleted bot's is cancelled", async () => {
  const started = startSignIn('u1', 'xai-oauth', 'bot3');
  const child = spawned.at(-1)!.child;
  child.print(GROK);
  const s = await started;
  expect(getSignIn('u2', s.id)).toBeNull();
  expect(cancelSignIn('u2', s.id)).toBe(false);
  expect(getSignIn('u1', s.id)?.status).toBe('waiting');

  cancelBotSignIns('bot3');
  expect(child.signalCode).toBe('SIGTERM');
  expect(getSignIn('u1', s.id)?.status).toBe('cancelled');
});

test('Hermes stopping before the approval fails the sign-in with the last thing it printed', async () => {
  const started = startSignIn('u1', 'openai-codex', 'bot4');
  const child = spawned.at(-1)!.child;
  child.print('hermes: preparing dependencies for this data root...\n');
  child.print('hermes_cli.auth.AuthError: Device code request returned status 403.\n');
  child.exit(1);
  expect(await started).toMatchObject({ status: 'failed', error: 'hermes_cli.auth.AuthError: Device code request returned status 403.' });
});

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('Copilot signs in to GitHub with a code and saves the token in Settings > Providers', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn()
    .mockResolvedValueOnce(reply({ device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }))
    .mockResolvedValueOnce(reply({ error: 'authorization_pending' }))
    .mockResolvedValueOnce(reply({ access_token: 'gho_token' }));
  vi.stubGlobal('fetch', fetch);

  const s = await startSignIn('u1', 'copilot', null);
  expect(s).toMatchObject({ provider: 'copilot', status: 'waiting', url: 'https://github.com/login/device', code: 'ABCD-1234' });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://github.com/login/device/code');
  expect(new URLSearchParams(init.body).get('client_id')).toBe('Iv1.b507a08c87ecfe98');

  await vi.advanceTimersByTimeAsync(6000);
  expect(getSignIn('u1', s.id)?.status).toBe('waiting');
  expect(saved).toEqual([]);
  await vi.advanceTimersByTimeAsync(6000);
  expect(new URLSearchParams(fetch.mock.calls[2][1].body).get('device_code')).toBe('dev-1');
  expect(saved).toEqual([{ 'copilot-token': 'gho_token' }]);
  expect(getSignIn('u1', s.id)?.status).toBe('done');
});

test('a Copilot sign-in turned down on GitHub fails, and saves nothing', async () => {
  vi.useFakeTimers();
  saved.length = 0;
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(reply({ device_code: 'dev-2', user_code: 'WXYZ-9876', verification_uri: 'https://github.com/login/device', interval: 5 }))
    .mockResolvedValueOnce(reply({ error: 'access_denied' })));
  const s = await startSignIn('u1', 'copilot', null);
  await vi.advanceTimersByTimeAsync(6000);
  expect(getSignIn('u1', s.id)).toMatchObject({ status: 'failed', error: 'The sign-in was turned down on GitHub.' });
  expect(saved).toEqual([]);
});

test('a Copilot poll GitHub refuses ends the sign-in, and one GitHub has trouble with is tried again', async () => {
  vi.useFakeTimers();
  saved.length = 0;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(reply({ device_code: 'dev-3', user_code: 'QRST-5555', verification_uri: 'https://github.com/login/device', interval: 5 }))
    .mockResolvedValueOnce(new Response('{}', { status: 502 }))
    .mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 })));
  const s = await startSignIn('u1', 'copilot', null);
  await vi.advanceTimersByTimeAsync(6000);
  expect(getSignIn('u1', s.id)?.status).toBe('waiting');
  await vi.advanceTimersByTimeAsync(6000);
  expect(getSignIn('u1', s.id)).toMatchObject({ status: 'failed', error: 'GitHub refused the sign-in (GitHub answered HTTP 404).' });
  expect(saved).toEqual([]);
  warn.mockRestore();
});
