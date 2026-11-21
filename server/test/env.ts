// Runs before every test file (vitest.config.ts setupFiles).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

// A throwaway data directory and the settings env.ts requires, so importing server modules opens a
// fresh database and touches nothing real.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-'));
process.env.TZ ??= 'UTC';
process.env.DISPATCH_NO_SCHEDULER = '1';

// Tests run on a developer's machine, which must never get a bot's display, Chrome or gateway. Any
// child process other than Node itself fails the test; mock the module that wanted one instead.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const guard = <F extends (...a: never[]) => unknown>(fn: F) =>
    ((cmd: string, ...rest: unknown[]) => {
      if (cmd !== process.execPath) throw new Error(`a test tried to run "${cmd}"; mock the module that starts it`);
      return (fn as unknown as (...a: unknown[]) => unknown)(cmd, ...rest);
    }) as unknown as F;
  const guarded = { ...real, spawn: guard(real.spawn), execFile: guard(real.execFile), execFileSync: guard(real.execFileSync), exec: guard(real.exec), execSync: guard(real.execSync) };
  return { ...guarded, default: guarded };
});
