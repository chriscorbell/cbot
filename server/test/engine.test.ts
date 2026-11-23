import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { db } from '../src/db.js';
import { allowedActions, approvalSettings, runSlot, syncApprovals, syncModel } from '../src/engine.js';
import { env } from '../src/env.js';
import { seedBot, seedOwner } from './helpers.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a gateway's first run goes alone until Hermes has begun answering it", async () => {
  const first = await runSlot('bot-a');
  let second: ((event?: unknown) => void) | null = null;
  void runSlot('bot-a').then((s) => { second = s; });
  await tick();
  expect(second).toBeNull();

  // Hermes sends these before it builds the agent: the second run still waits.
  first('run.started'); first('message.started');
  await tick();
  expect(second).toBeNull();

  first('message.delta');
  await tick();
  expect(second).not.toBeNull();
  // Answered once: later runs start at once.
  let third = false;
  void runSlot('bot-a').then(() => { third = true; });
  await tick();
  expect(third).toBe(true);
});

test('a first run that ends without answering hands the turn to the next run', async () => {
  const first = await runSlot('bot-b');
  const order: string[] = [];
  const second = runSlot('bot-b').then((s) => { order.push('second'); return s; });
  const third = runSlot('bot-b').then((s) => { order.push('third'); return s; });
  first();
  const s2 = await second;
  await tick();
  // The second is now the first run, so the third waits for it.
  expect(order).toEqual(['second']);
  s2('run.completed');
  await third;
  expect(order).toEqual(['second', 'third']);
});

test("a bot's config.yaml that isn't valid YAML is left as it is, and the other bots still get their settings", () => {
  const user = seedOwner();
  const broken = seedBot(user.id, { name: 'Broken' });
  const fine = seedBot(user.id, { name: 'Fine' });
  db.prepare("UPDATE bots SET engine='managed' WHERE id IN (?,?)").run(broken.id, fine.id);
  const config = (id: string) => path.join(env.enginesDir, id, 'config.yaml');
  for (const id of [broken.id, fine.id]) fs.mkdirSync(path.dirname(config(id)), { recursive: true });
  const brokenText = 'model:\n  default: claude\n  provider: [anthropic\n';
  fs.writeFileSync(config(broken.id), brokenText);
  fs.writeFileSync(config(fine.id), 'model:\n  default: claude\ncommand_allowlist: [ls]\n');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  db.prepare("UPDATE users SET approval_mode='smart' WHERE id=?").run(user.id);
  syncApprovals(user.id);
  syncModel(broken.id);
  expect(allowedActions(user.id)).toEqual(['ls']);

  expect(fs.readFileSync(config(broken.id), 'utf8')).toBe(brokenText);
  expect(fs.readFileSync(config(fine.id), 'utf8')).toContain('mode: smart');
  expect(warn.mock.calls.some(([m]) => String(m).includes("isn't valid YAML, so Dispatch won't rewrite it"))).toBe(true);
  warn.mockRestore();
});

test("a bot's reasoning effort is its Hermes' default too, beside the agent settings already there", () => {
  const user = seedOwner();
  const bot = seedBot(user.id, { name: 'Effort' });
  db.prepare("UPDATE bots SET engine='managed', effort='high' WHERE id=?").run(bot.id);
  const file = path.join(env.enginesDir, bot.id, 'config.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'agent:\n  reasoning_effort: medium\n  disabled_toolsets: [kanban]\n');
  syncModel(bot.id);
  expect(fs.readFileSync(file, 'utf8')).toBe('agent:\n  reasoning_effort: high\n  disabled_toolsets:\n    - kanban\n');
});

test("Never Allow rules that can't be read make every action ask first, rather than none", () => {
  const user = seedOwner();
  db.prepare("UPDATE users SET approval_mode='off', approval_deny='[\"rm -rf *\"' WHERE id=?").run(user.id);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(approvalSettings(user.id)).toEqual({ mode: 'manual', deny: [] });
  expect(error).toHaveBeenCalled();
  error.mockRestore();
  db.prepare("UPDATE users SET approval_deny='[\"rm -rf *\"]' WHERE id=?").run(user.id);
  expect(approvalSettings(user.id)).toEqual({ mode: 'off', deny: ['rm -rf *'] });
});
