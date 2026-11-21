import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The box: the computer every bot works on, which is the machine this server runs on. Desktop
 * commands and files go straight to the local shell and disk.
 */

export interface BashResult { output: string; exit_code: number }

import { displayFor } from './machine.js';
import { errorField } from './lib/errors.js';

/** Only what a desktop command needs; none of this server's secrets. */
function shellEnv(screenId?: string | null): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    USER: process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    DISPLAY: displayFor(screenId),
  };
}

/** A path safe to put inside single quotes in a shell command. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const box = {
  /** Run a bash command. `screenId` picks which screen's DISPLAY it sees. */
  bash(command: string, timeoutSec = 60, screenId?: string | null): Promise<BashResult> {
    return new Promise((resolve) => {
      execFile('bash', ['-c', command], { timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env: shellEnv(screenId) }, (err, stdout, stderr) => {
        // A command that ran and failed has its exit code; one that couldn't run (or timed out) counts as 1.
        const exit = errorField(err, 'code');
        const code = err ? (typeof exit === 'number' ? exit : 1) : 0;
        resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: code });
      });
    });
  },

  async writeFile(file: string, content: string | Buffer, mode = '0644'): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    await fs.chmod(file, parseInt(mode, 8));
  },

  /** Read a file, or null if it isn't there. */
  async readFile(file: string): Promise<Buffer | null> {
    try { return await fs.readFile(file); } catch { return null; }
  },

  quote: q,
};
