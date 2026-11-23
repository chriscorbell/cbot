import { spawn } from 'node:child_process';
import { ACCOUNT, asAccount, mkdirOwned } from './account.js';
import { errorText } from './lib/errors.js';
import { libraryDir } from './machine.js';

/**
 * A routine's precheck: a shell command run before the routine, so a routine that watches something
 * (a sales log, a mailbox, a feed) costs a model turn only when there is something new. Exit 0 with
 * something on stdout and the routine runs, told what it printed; anything else skips the run without
 * waking the bot (routines.ts).
 *
 * It runs as the bots' account, never as root, in the bot's Library: where its terminal commands run
 * (engine.ts sets the terminal's folder), so a command the bot tried there behaves the same here.
 */

/** How long a precheck may take before it is stopped and the run skipped. */
export const PRECHECK_TIMEOUT_MS = 30_000;
/** How much of each of its streams is read. The rest is drained unread, so a chatty command can't stall on a full pipe. */
const READ_LIMIT = 64 * 1024;
/** How much of what it printed reaches the run: enough for a list of new items, not a whole log. */
export const OUTPUT_LIMIT = 8000;
/** How much of its errors the routine's history keeps: the end, where the reason usually is. */
const ERROR_TAIL = 300;
/** After the command exits, how long to wait for its output to close (a background child may still hold it). */
const CLOSE_GRACE_MS = 1000;

export interface Captured {
  /** Its exit code: null when a signal stopped it, it timed out or it never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why it couldn't start. */
  error: string | null;
}

/**
 * Run argv with a time limit, reading at most `limit` bytes of each stream. Never rejects. It runs in
 * a process group of its own, and the whole group is killed when it is done or out of time, so nothing
 * a precheck starts outlives it.
 */
export function capture(argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; limit?: number }): Promise<Captured> {
  const limit = o.limit ?? READ_LIMIT;
  return new Promise((resolve) => {
    const read = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const size = { stdout: 0, stderr: 0 };
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let timedOut = false;
    let done = false;
    let grace: NodeJS.Timeout | undefined;

    const child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone already */ }
    };
    const finish = (error: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      killGroup();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        code: timedOut || error ? null : exited?.code ?? null,
        signal: timedOut || error ? null : exited?.signal ?? null,
        stdout: Buffer.concat(read.stdout).toString('utf8'),
        stderr: Buffer.concat(read.stderr).toString('utf8'),
        timedOut,
        error,
      });
    };
    const keep = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const room = limit - size[stream];
      if (room <= 0) return;
      read[stream].push(room < chunk.length ? chunk.subarray(0, room) : chunk);
      size[stream] += Math.min(room, chunk.length);
    };
    child.stdout.on('data', keep('stdout'));
    child.stderr.on('data', keep('stderr'));
    const timer = setTimeout(() => { timedOut = true; finish(null); }, o.timeoutMs);
    child.on('error', (e) => finish(errorText(e)));
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      grace = setTimeout(() => finish(null), CLOSE_GRACE_MS);
    });
    child.on('close', () => finish(null));
  });
}

/** What a bot's gateway gives its commands (engine.ts hermesEnv), less its Hermes home: a precheck is a plain command. */
function precheckEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: ACCOUNT.home,
    USER: ACCOUNT.name,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
  };
}

/** Run a routine's precheck for its bot. Never rejects. */
export async function runPrecheck(botId: string, command: string): Promise<Captured> {
  const cwd = libraryDir(botId);
  try {
    mkdirOwned(cwd);
  } catch (e) {
    return { code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: `its folder ${cwd}: ${errorText(e)}` };
  }
  return capture(asAccount(['bash', '-c', command]), { cwd, env: precheckEnv(), timeoutMs: PRECHECK_TIMEOUT_MS });
}

/**
 * Whether the routine runs, with what the precheck printed; or why it doesn't: null when the precheck
 * found nothing to do (exit 0, nothing printed), else what went wrong, so a broken precheck shows in
 * the routine's history instead of skipping every run without a word.
 */
export type Verdict = { run: true; output: string } | { run: false; reason: string | null };

export function verdict(c: Captured): Verdict {
  if (c.error) return { run: false, reason: `couldn’t start: ${c.error}` };
  if (c.timedOut) return { run: false, reason: `took longer than ${PRECHECK_TIMEOUT_MS / 1000} seconds and was stopped` };
  if (c.code !== 0) {
    const errors = c.stderr.trim().replace(/\s+/g, ' ');
    const said = errors.length > ERROR_TAIL ? `…${errors.slice(-ERROR_TAIL)}` : errors;
    return { run: false, reason: `${c.code === null ? `was stopped by ${c.signal ?? 'a signal'}` : `exited with code ${c.code}`}${said ? `: ${said}` : ''}` };
  }
  const out = c.stdout.trim();
  if (!out) return { run: false, reason: null };
  return { run: true, output: out.length > OUTPUT_LIMIT ? `${out.slice(0, OUTPUT_LIMIT)}\n[… the rest was cut]` : out };
}
