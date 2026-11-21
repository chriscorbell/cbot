// When a bot's gateway restarts for new Settings > Providers: never under a run that uses it, and
// always on the settings as they are once it starts, even when they changed while it was starting.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { gate } from './hermes.js';

// systemd and the screen, recorded instead of done: a restart brings the gateway up once `held` lets it.
const restarts: string[] = [];
let state = 'active';
let up = true;
let held: Promise<void> = Promise.resolve();
vi.mock('../src/units.js', async (orig) => ({
  ...(await orig<typeof import('../src/units.js')>()),
  unitState: async () => state,
  restart: async (unit: string) => {
    restarts.push(unit);
    state = 'active';
    await held;
    up = true;
  },
  stop: async () => {},
  setSliceLimits: async () => {},
  writeEnvFile: () => {},
  mainPid: async () => 4242,
}));
vi.mock('../src/computer.js', async (orig) => ({
  ...(await orig<typeof import('../src/computer.js')>()),
  screenFor: async () => ({ screenId: 'screen-100', width: 1440, height: 900 }),
}));

const { engineFor } = await import('../src/engine.js');
const { gatewayUnit } = await import('../src/units.js');
const { HermesRun } = await import('../src/agent/runs.js');
const { saveProviderSettings } = await import('../src/providers.js');
const { db } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { seedBot, seedOwner } = await import('./helpers.js');

let userId: string;
beforeAll(() => {
  userId = seedOwner().id;
  // The gateway: up or not, and it takes any key.
  vi.stubGlobal('fetch', async (url: string) => {
    const p = new URL(url).pathname;
    if (up && p === '/health') return Response.json({ status: 'ok', version: 'test' });
    if (up && p === '/v1/models') return Response.json({ data: [] });
    throw new Error('connection refused');
  });
});
afterEach(() => { state = 'active'; up = true; held = Promise.resolve(); });

/** A bot with an agent on its own port. */
function agentBot(port: number) {
  const bot = seedBot(userId);
  db.prepare("UPDATE bots SET engine='managed', engine_port=? WHERE id=?").run(port, bot.id);
  return bot;
}
/** The restarts of this bot's gateway (a settings change restarts every bot's). */
const restartsOf = (botId: string) => restarts.filter((u) => u === gatewayUnit(botId)).length;
const dotenv = (botId: string) => fs.readFileSync(path.join(env.enginesDir, botId, '.env'), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 50));

test('new provider settings restart a gateway only once no run is using it', async () => {
  const bot = agentBot(8701);
  await engineFor(bot.id);
  const before = restartsOf(bot.id);

  // A voice reply has the gateway when the settings change: it isn't cut short.
  const call = new HermesRun(bot.id, 'voice');
  await call.gateway();
  saveProviderSettings({ deepseek: 'sk-while-a-call-runs' });
  await settle();
  expect(restartsOf(bot.id)).toBe(before);
  // A call's summary that starts meanwhile uses the gateway as it is, and so leaves the reply alone.
  const summary = new HermesRun(bot.id, 'summary');
  await summary.gateway();
  call.close();
  await settle();
  expect(restartsOf(bot.id)).toBe(before);
  // The last run to let go of it restarts it.
  summary.close();
  await vi.waitFor(() => expect(restartsOf(bot.id)).toBe(before + 1));
  expect(dotenv(bot.id)).toContain('sk-while-a-call-runs');
});

test('settings that change while the gateway is starting get a start of their own', async () => {
  // A new bot's gateway is starting (the setup wizard made the bot) when its provider key is saved.
  const bot = agentBot(8702);
  state = 'inactive';
  up = false;
  const start = gate();
  held = start.opened;
  const first = engineFor(bot.id);
  await vi.waitFor(() => expect(restartsOf(bot.id)).toBe(1));
  expect(dotenv(bot.id)).not.toContain('sk-saved-during-start');

  saveProviderSettings({ deepseek: 'sk-saved-during-start' });
  start.open();
  await first;
  await vi.waitFor(() => expect(restartsOf(bot.id)).toBe(2));
  expect(dotenv(bot.id)).toContain('sk-saved-during-start');
});
