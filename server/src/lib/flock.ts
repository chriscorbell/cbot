import { spawn } from 'node:child_process';

/**
 * Run `fn` while holding an exclusive flock(2) on `lockPath`: the lock Python's fcntl.flock takes, which
 * is how Hermes' memory tool guards its files. Node has no flock of its own, so util-linux's flock holds
 * it for us: it takes the lock, prints "held", and keeps it until its input closes. If this process dies,
 * the pipe closes and the lock goes with it. Rejects when the lock isn't free within `waitSec`.
 */
export async function withFileLock<T>(lockPath: string, waitSec: number, fn: () => T | Promise<T>): Promise<T> {
  const child = spawn('flock', ['-x', '-w', String(waitSec), lockPath, 'sh', '-c', 'echo held; exec cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let failure = '';
  child.stderr.on('data', (d) => { failure += String(d); });
  const exited = new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', (e) => { failure ||= e.message; resolve(); });
  });
  const held = await new Promise<boolean>((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); if (out.includes('held')) resolve(true); });
    void exited.then(() => resolve(false));
  });
  if (!held) throw new Error(failure.trim() || `${lockPath} stayed locked for ${waitSec}s`);
  try {
    return await fn();
  } finally {
    child.stdin.end();
    await exited;
  }
}
