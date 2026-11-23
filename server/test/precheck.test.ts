import { expect, test } from 'vitest';
import os from 'node:os';
import { capture } from '../src/precheck.js';

// capture() is what runs a precheck. These run Node itself (env.ts lets tests start only Node), which
// stands in for the shell a routine's precheck runs in.
const node = (script: string, o: { timeoutMs?: number; limit?: number; cwd?: string } = {}) =>
  capture([process.execPath, '-e', script], { cwd: o.cwd ?? os.tmpdir(), env: { PATH: process.env.PATH }, timeoutMs: o.timeoutMs ?? 10_000, limit: o.limit });

test('it hands back what the command printed and its exit code', async () => {
  expect(await node('process.stdout.write("2 new orders"); process.stderr.write("checked"); process.exitCode = 3')).toEqual({
    code: 3, signal: null, stdout: '2 new orders', stderr: 'checked', timedOut: false, error: null,
  });
});

test('it reads only so much of the output, and drains the rest so the command still finishes', async () => {
  const c = await node('for (let i = 0; i < 400; i++) process.stdout.write("y".repeat(1024))', { limit: 1000 });
  expect(c).toMatchObject({ code: 0, timedOut: false });
  expect(c.stdout).toBe('y'.repeat(1000));
});

test('a command that runs too long is stopped', async () => {
  const c = await node('process.stdout.write("started"); setTimeout(() => {}, 20_000)', { timeoutMs: 300 });
  expect(c).toMatchObject({ code: null, timedOut: true, error: null });
});

test('a command left running in the background does not hold up the answer', async () => {
  const started = Date.now();
  const c = await node('require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20_000)"], { stdio: "inherit" }).unref(); console.log("done")');
  expect(c).toMatchObject({ code: 0, stdout: 'done\n', timedOut: false });
  expect(Date.now() - started).toBeLessThan(5000);
});

test("a command that can't start says why", async () => {
  const c = await node('', { cwd: '/nonexistent/folder' });
  expect(c.code).toBeNull();
  expect(c.error).toMatch(/ENOENT/);
});
