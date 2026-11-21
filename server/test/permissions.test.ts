// Settings > Permissions: how every bot's Hermes asks before risky actions, written into each bot's
// config.yaml while its gateway runs, and the answers to approval cards.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { beforeAll, expect, test } from 'vitest';

const { createApp } = await import('../src/app.js');
const { auth, json, seedBot, seedOwner } = await import('./helpers.js');
const { db } = await import('../src/db.js');
const { env } = await import('../src/env.js');

const app = createApp();
let userId: string;
beforeAll(() => { userId = seedOwner().id; });

/** A bot with a Hermes home whose config.yaml holds `cfg`. */
function botWithHome(cfg: Record<string, unknown>) {
  const bot = seedBot(userId);
  db.prepare("UPDATE bots SET engine='managed', engine_port=8650 WHERE id=?").run(bot.id);
  const file = path.join(env.enginesDir, bot.id, 'config.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(cfg));
  return { bot, read: () => YAML.parse(fs.readFileSync(file, 'utf8')) };
}

const put = (body: unknown) => app.request('/api/permissions', { ...json(body), method: 'PUT' });

test('a change to approvals reaches every bot without touching the rest of its config', async () => {
  const a = botWithHome({ model: { default: 'm' }, approvals: { timeout: 300 }, command_allowlist: ['delete in root path'] });
  const b = botWithHome({ model: { default: 'n' } });
  // seedOwner writes its row straight in, like an account from before Smart was the default (setup.test.ts has a new one).
  const first = await (await app.request('/api/permissions', { headers: auth() })).json();
  expect(first).toEqual({ mode: 'off', allowed: ['delete in root path'], deny: [] });

  const res = await put({ mode: 'manual', deny: ['git push --force*', ' git push --force* '] });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ mode: 'manual', allowed: ['delete in root path'], deny: ['git push --force*'] });
  // An "Always allow" one bot was given counts for all of them.
  for (const bot of [a, b]) {
    expect(bot.read()).toMatchObject({ approvals: { mode: 'manual', deny: ['git push --force*'] }, command_allowlist: ['delete in root path'] });
  }
  expect(a.read()).toMatchObject({ model: { default: 'm' }, approvals: { timeout: 300 } });

  expect((await put({ mode: 'sometimes' })).status).toBe(400);
});

test('removing an allowed action takes it from every bot', async () => {
  const a = botWithHome({ command_allowlist: ['ssh_config_write', 'delete in root path'] });
  const res = await app.request(`/api/permissions/allowed/${encodeURIComponent('delete in root path')}`, { method: 'DELETE', headers: auth() });
  expect((await res.json()).allowed).toEqual(['ssh_config_write']);
  expect(a.read().command_allowlist).toEqual(['ssh_config_write']);
});

test('answering an approval nothing waits for says so', async () => {
  const bot = seedBot(userId);
  db.prepare("INSERT INTO approvals(id,bot_id,generation,row_seq,call_id,tool,status,created_at) VALUES ('ap_old',?,1,1,'p','terminal','pending',0)").run(bot.id);
  const res = await app.request('/api/approvals/ap_old', json({ choice: 'once' }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'This request expired.' });
  expect(db.prepare("SELECT status FROM approvals WHERE id='ap_old'").get()).toEqual({ status: 'expired' });
  // An old draft card sends no choice; its approval just expires.
  expect((await app.request('/api/approvals/ap_old', json({}))).status).toBe(200);
  expect((await app.request('/api/approvals/ap_nope', json({ choice: 'once' }))).status).toBe(404);
  expect((await app.request('/api/approvals/ap_old', json({ choice: 'maybe' }))).status).toBe(400);
});
