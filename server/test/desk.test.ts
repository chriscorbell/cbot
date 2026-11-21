// How the server runs the screen scripts (box.script) and follows their jobs (desk.ts): a script
// that is missing or crashed is an error that says so, never a reason to set the computer up again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

// python3's answers, by the command the server gives dispatch-screen.py.
type Reply = { err?: unknown; out?: string; stderr?: string };
const py = vi.hoisted(() => ({ calls: [] as string[][], replies: {} as Record<string, Reply | (() => Reply)> }));
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
    py.calls.push([cmd, ...args]);
    const r = py.replies[args[1]];
    const reply = typeof r === 'function' ? r() : r ?? { out: '{"done": {"ok": true}}' };
    setImmediate(() => cb(reply.err ?? null, reply.out ?? '', reply.stderr ?? ''));
  },
}));

const { box, BoxScriptError } = await import('../src/box.js');
const { dressScreen, undressScreen } = await import('../src/desk.js');

const bot = { id: 'bot_a', name: 'Ada', label: '', avatarShape: 'blob', avatarColor: 'blue' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-desk-'));
const script = path.join(tmp, 'dispatch-screen.py');
fs.writeFileSync(script, '');
const crash = (code: number, stderr: string): Reply => ({ err: Object.assign(new Error('Command failed'), { code }), stderr });
const commands = () => py.calls.map((c) => c[2]);

afterEach(() => { py.calls = []; py.replies = {}; vi.restoreAllMocks(); });

test('a script answers with its JSON, and each way it can fail is told apart', async () => {
  py.replies.base = { out: '{"done": {"ok": true}}\n' };
  await expect(box.script(script, ['base'], 5)).resolves.toEqual({ done: { ok: true } });

  const missing = await box.script(path.join(tmp, 'gone.py'), ['base'], 5).catch((e: unknown) => e);
  expect(missing).toBeInstanceOf(BoxScriptError);
  expect(missing).toMatchObject({ kind: 'missing' });
  expect(py.calls).toHaveLength(1);           // nothing was run for a script that isn't there

  py.replies.base = { err: Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }) };
  await expect(box.script(script, ['base'], 5)).rejects.toMatchObject({ kind: 'missing', message: expect.stringContaining('python3') });

  py.replies.base = crash(1, 'Traceback (most recent call last):\n  File "dispatch-screen.py", line 9\nKeyError: \'bot\'\n');
  await expect(box.script(script, ['base'], 5)).rejects.toMatchObject({ kind: 'crashed', message: expect.stringContaining("KeyError: 'bot'") });

  py.replies.base = { err: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) };
  await expect(box.script(script, ['base'], 5)).rejects.toMatchObject({ kind: 'crashed', message: expect.stringContaining('stopped after 5s') });

  py.replies.base = { out: 'DISPATCH_DONE {}' };
  await expect(box.script(script, ['base'], 5)).rejects.toMatchObject({ kind: 'garbled' });
});

test('dressing sets the computer up first, then dresses, and follows a job to the result it writes', async () => {
  const result = path.join(tmp, 'dress-job.json');
  py.replies.dress = () => {
    setTimeout(() => fs.writeFileSync(result, JSON.stringify({ ok: true, warnings: ['the dock was slow'] })), 300);
    return { out: JSON.stringify({ job: 'dress-100-1', pid: process.pid, result }) };
  };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await dressScreen(bot, 'screen-100');
  expect(commands()).toEqual(['base', 'dress']);
  const dress = py.calls[1];
  expect(dress.slice(3, 5)).toEqual(['100', '-']);
  expect(warn).toHaveBeenCalledWith('[desk] the dock was slow');

  // The setup ran once for this process; the next dressing goes straight to work.
  py.calls = [];
  await dressScreen(bot, 'screen-100', { restartChrome: true });
  expect(commands()).toEqual(['dress']);
  expect(py.calls[0][4]).toBe('r');
});

test('a crash is reported with its traceback, and nothing is set up again', async () => {
  py.replies.dress = crash(1, 'Traceback (most recent call last):\nZeroDivisionError: division by zero\n');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(dressScreen(bot, 'screen-101')).rejects.toThrow(/dressing screen screen-101 failed: dispatch-screen\.py dress crashed \(exit 1\)/);
  expect(commands()).toEqual(['dress']);
  expect(error.mock.calls[0][0]).toContain('ZeroDivisionError');

  // A job that crashed says so in its result, with the trace.
  const result = path.join(tmp, 'crashed-job.json');
  fs.writeFileSync(result, JSON.stringify({ ok: false, error: 'KeyError: x', crashed: true, trace: 'Traceback ...\nKeyError: x', warnings: [] }));
  py.replies.dress = { out: JSON.stringify({ job: 'dress-101-2', pid: process.pid, result }) };
  error.mockClear();
  await expect(dressScreen(bot, 'screen-101')).rejects.toThrow('dressing screen screen-101 failed: KeyError: x');
  expect(error.mock.calls[0][0]).toContain('Traceback ...');
});

test('a job that ends without writing its result fails instead of waiting out its time', async () => {
  py.replies.dress = { out: JSON.stringify({ job: 'dress-102-3', pid: 2 ** 22 + 12345, result: path.join(tmp, 'never.json') }) };
  const started = Date.now();
  await expect(dressScreen(bot, 'screen-102')).rejects.toThrow(/job dress-102-3 ended without a result/);
  expect(Date.now() - started).toBeLessThan(10_000);
});

test('undressing a screen whose scripts are missing fails loudly', async () => {
  py.replies.undress = { err: Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }) };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(undressScreen('bot_a', 'screen-100')).rejects.toThrow(/undressing screen screen-100 failed: python3 is not installed/);
  py.replies.undress = { out: '{"done": {"ok": true, "warnings": []}}' };
  await undressScreen('bot_a', 'screen-100');
  expect(py.calls.at(-1)?.slice(2)).toEqual(['undress', '100', 'bot_a']);
});
