// Settings > Providers: keys, tokens and addresses kept in the database for every bot, never sent back
// to the browser, and taken out of the bots' Hermes homes when they are removed.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

// A change restarts every bot's gateway before its next run; idle ones now, through engineFor.
const restarted: string[] = [];
vi.mock('../src/engine.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine.js')>()),
  engineFor: async (botId: string) => { restarted.push(botId); return { url: 'http://engine.test', key: 'k', home: '/nonexistent' }; },
}));

const { createApp } = await import('../src/app.js');
const { auth, json, seedBot, seedOwner } = await import('./helpers.js');
const { db } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { getSetting, importEnvironment, putSettings } = await import('../src/settings.js');
const { syncModel } = await import('../src/engine.js');

const app = createApp();
let userId: string;
beforeAll(() => { userId = seedOwner().id; });
beforeEach(() => { restarted.length = 0; });

const put = (body: unknown) => app.request('/api/providers', { ...json(body), method: 'PUT' });
const get = async () => (await app.request('/api/providers', { headers: auth() })).json();

/** A bot with a Hermes home holding these .env lines and this config. */
function botWithHome(envLines: string[], cfg: Record<string, unknown> = {}) {
  const bot = seedBot(userId);
  db.prepare("UPDATE bots SET engine='managed', engine_port=8650 WHERE id=?").run(bot.id);
  const home = path.join(env.enginesDir, bot.id);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.env'), envLines.map((l) => `${l}\n`).join(''));
  fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify(cfg));
  return {
    bot,
    env: () => fs.readFileSync(path.join(home, '.env'), 'utf8').trim().split('\n'),
    cfg: () => YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')),
  };
}

test('a key is stored but never sent back: only whether it is set and, for a long one, its last four characters', async () => {
  const res = await put({ secrets: { gemini: '  AIzaSyExample0000000000000wxyz ', xai: 'short' } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.secrets.gemini).toEqual({ set: true, ending: 'wxyz' });
  expect(body.secrets.xai).toEqual({ set: true, ending: '' });
  expect(body.secrets.openrouter).toEqual({ set: false, ending: '' });
  expect(JSON.stringify(body)).not.toContain('AIzaSy');
  expect(getSetting('gemini')).toBe('AIzaSyExample0000000000000wxyz');

  expect((await put({ secrets: { xai: '' } })).status).toBe(200);
  expect((await get()).secrets.xai).toEqual({ set: false, ending: '' });
});

test('a key that would break a .env line, or an address that is not http(s), is refused', async () => {
  const spaced = await put({ secrets: { 'openai-api': 'sk-one two' } });
  expect(spaced.status).toBe(400);
  expect((await put({ secrets: { 'openai-api': 'sk-x\nEVIL=1' } })).status).toBe(400);
  expect((await put({ searxngUrl: 'ftp://search.test' })).status).toBe(400);
  expect((await put({ secrets: { 'not-a-provider': 'k' } })).status).toBe(400);
  expect(getSetting('openai-api')).toBe('');
});

test('addresses lose a trailing slash and fragment; clearing one unsets it', async () => {
  const body = await (await put({ searxngUrl: 'https://search.test/#x', selfHostedUrl: '' })).json();
  expect(body.searxngUrl).toBe('https://search.test');
  expect(body.selfHosted).toEqual({ url: '', models: [], error: null });
  expect((await (await put({ searxngUrl: '' })).json()).searxngUrl).toBe('');
});

test('removing a credential takes it out of every home that holds that value, and every gateway restarts', async () => {
  putSettings({ 'copilot-token': 'gho_shared_token_123456' });
  const a = botWithHome(['API_SERVER_KEY=a', 'COPILOT_GITHUB_TOKEN=gho_shared_token_123456', 'MY_OWN=1']);
  // This bot signed in on its own screen; its token is not the one being removed.
  const b = botWithHome(['API_SERVER_KEY=b', 'COPILOT_GITHUB_TOKEN=gho_own_sign_in']);

  expect((await put({ secrets: { 'copilot-token': '' } })).status).toBe(200);
  expect(a.env()).toEqual(['API_SERVER_KEY=a', 'MY_OWN=1']);
  expect(b.env()).toEqual(['API_SERVER_KEY=b', 'COPILOT_GITHUB_TOKEN=gho_own_sign_in']);
  await vi.waitFor(() => expect(restarted).toEqual(expect.arrayContaining([a.bot.id, b.bot.id])));

  // Saving what is already set changes nothing and restarts nothing.
  putSettings({ deepseek: 'sk-same' });
  restarted.length = 0;
  await put({ secrets: { deepseek: 'sk-same' } });
  await new Promise((r) => setTimeout(r, 20));
  expect(restarted).toEqual([]);
});

test('a bot’s chosen provider and model become its Hermes default; with none chosen, DeepSeek when its key is set', () => {
  const chosen = botWithHome([], { model: { default: 'old', base_url: 'http://stale' }, agent: { reasoning_effort: 'medium' } });
  db.prepare("UPDATE bots SET provider='self-hosted', model='qwen38' WHERE id=?").run(chosen.bot.id);
  syncModel(chosen.bot.id);
  expect(chosen.cfg()).toEqual({ model: { provider: 'self-hosted', default: 'qwen38' }, agent: { reasoning_effort: 'medium' } });

  putSettings({ deepseek: 'sk-deepseek' });
  const none = botWithHome([], {});
  syncModel(none.bot.id);
  expect(none.cfg().model).toEqual({ provider: 'deepseek', default: 'deepseek-flash' });
  // A model chosen in Hermes itself stays.
  const own = botWithHome([], { model: { provider: 'gemini', default: 'gemini-2.5-pro' } });
  syncModel(own.bot.id);
  expect(own.cfg().model).toEqual({ provider: 'gemini', default: 'gemini-2.5-pro' });
});

test('the environment is copied in once; a later start leaves settings as the app set them', () => {
  putSettings({ 'openrouter': '', 'searxng-url': '' });
  db.prepare("DELETE FROM settings WHERE key='env-imported'").run();
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
  process.env.SEARXNG_URL = 'http://searx.test';
  try {
    importEnvironment();
    expect(getSetting('openrouter')).toBe('sk-or-v1-from-env');
    expect(getSetting('searxng-url')).toBe('http://searx.test');

    putSettings({ openrouter: '' });
    importEnvironment();
    expect(getSetting('openrouter')).toBe('');
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SEARXNG_URL;
  }
});
