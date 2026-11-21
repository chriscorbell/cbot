import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mkdirOwnedAsync, ownAsync } from './account.js';
import { BOTS_ROOT } from './machine.js';
import { errorField } from './lib/errors.js';

/**
 * The box: the computer every bot works on, which is the machine this server runs on. The box scripts
 * run straight from the release, and files go straight to disk.
 */

/**
 * Only what a box script needs; none of this server's secrets. The scripts find the bots' account the
 * way account.ts does, so they get DISPATCH_USER (and DISPATCH_HOME, set in tests). They set DISPLAY
 * themselves, for the screen they work on.
 */
function scriptEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    USER: process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    ...(process.env.DISPATCH_USER ? { DISPATCH_USER: process.env.DISPATCH_USER } : {}),
    ...(process.env.DISPATCH_HOME ? { DISPATCH_HOME: process.env.DISPATCH_HOME } : {}),
  };
}

/** A file in the bots' folders (a Library, say) belongs to their account, so every bot can change it. */
const forBots = (file: string) => path.resolve(file).startsWith(`${path.resolve(BOTS_ROOT)}/`);

/**
 * Why a box script gave no answer. `missing`: the script isn't where the release put it, or there is
 * no python3, so the install is broken. `crashed`: it ran and failed (a traceback, a non-zero exit or
 * a timeout), which is a bug to report, never a reason to set anything up again. `garbled`: it exited
 * 0 but didn't print the one JSON object it answers with.
 */
export class BoxScriptError extends Error {
  constructor(readonly kind: 'missing' | 'crashed' | 'garbled', message: string) {
    super(message);
    this.name = 'BoxScriptError';
  }
}

/** The last lines of what a script printed, which is where a Python traceback says what went wrong. */
const tail = (text: string, lines = 12) => text.trim().split('\n').slice(-lines).join('\n');

export const box = {
  /**
   * Run one of the Python box scripts (server/box/) with its arguments, as the server's own user, and
   * return the JSON object it prints. Anything else throws a BoxScriptError that says which way it failed.
   */
  script(file: string, args: string[], timeoutSec: number): Promise<unknown> {
    const name = `${path.basename(file)} ${args[0] ?? ''}`.trim();
    if (!existsSync(file)) return Promise.reject(new BoxScriptError('missing', `${file} is missing: this install of Dispatch is incomplete`));
    return new Promise((resolve, reject) => {
      execFile('python3', [file, ...args], { timeout: timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024, env: scriptEnv() }, (err, stdout, stderr) => {
        if (err) {
          const code = errorField(err, 'code');
          if (code === 'ENOENT') { reject(new BoxScriptError('missing', `python3 is not installed, so ${name} cannot run`)); return; }
          const how = errorField(err, 'killed') ? `was stopped after ${timeoutSec}s` : `crashed (exit ${String(code ?? errorField(err, 'signal'))})`;
          reject(new BoxScriptError('crashed', `${name} ${how}:\n${tail(`${stderr}`) || '(no output)'}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          reject(new BoxScriptError('garbled', `${name} didn't answer with JSON: ${stdout.trim().slice(0, 200) || '(nothing)'}`));
        }
      });
    });
  },

  async writeFile(file: string, content: string | Buffer, mode = '0644'): Promise<void> {
    if (forBots(file)) await mkdirOwnedAsync(path.dirname(file));
    else await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    await fs.chmod(file, parseInt(mode, 8));
    if (forBots(file)) await ownAsync(file);
  },
};
