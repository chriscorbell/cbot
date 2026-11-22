import { beforeEach, expect, test, vi } from 'vitest';
import { seedBot, seedOwner } from './helpers.js';

// Screens without displays or scripts: a Chrome restart waits on `dressed`, other dressings are done at once.
let dressed: { resolve: () => void; promise: Promise<void> };
const dresses: { restartChrome?: boolean }[] = [];
vi.mock('../src/displays.js', async (orig) => ({ ...(await orig<typeof import('../src/displays.js')>()), ensureDisplay: async () => {} }));
vi.mock('../src/desk.js', async (orig) => ({
  ...(await orig<typeof import('../src/desk.js')>()),
  dressScreen: async (_bot: unknown, _screen: string, opts?: { restartChrome?: boolean }) => { dresses.push(opts ?? {}); if (opts?.restartChrome) await dressed.promise; },
}));

const { restartChrome, screenForWork } = await import('../src/computer.js');

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { resolve, promise };
}

beforeEach(() => { dressed = gate(); dresses.length = 0; });

test("a bot that turns busy before its Chrome restarts keeps its Chrome", async () => {
  const user = seedOwner();
  const bot = seedBot(user.id);
  expect(await restartChrome(user.id, bot.id, () => false)).toBe(false);
  expect(dresses).toEqual([]);
});

test('work that starts while Chrome restarts waits for it, rather than losing its browser halfway', async () => {
  vi.stubGlobal('fetch', async () => new Response('{}'));
  const user = seedOwner();
  const bot = seedBot(user.id);
  const restarting = restartChrome(user.id, bot.id, () => true);
  await vi.waitFor(() => expect(dresses).toContainEqual({ restartChrome: true }));
  let ready = false;
  const work = screenForWork(user.id, bot.id).then(() => { ready = true; });
  await new Promise((r) => setTimeout(r, 20));
  expect(ready).toBe(false);
  dressed.resolve();
  expect(await restarting).toBe(true);
  await work;
  expect(ready).toBe(true);
  vi.unstubAllGlobals();
});
