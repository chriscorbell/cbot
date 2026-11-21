import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { ByteQueue, rfbHandshake } from './lib/rfb.js';
import { RUN_ROOT, vncPortFor } from './machine.js';
import { displayEnvFile, displayTarget, restart, start, stop, unitState, writeEnvFile, xvncUnit } from './units.js';

/**
 * The bots' screens. Each one is an X display of its own on this machine: TigerVNC's Xvnc (the X
 * server and its VNC server in one process), a D-Bus session bus and the xfwm4 window manager, each a
 * systemd unit under dispatch-display@<n>.target (deploy/, units.ts). Making a screen look like a
 * bot's computer is the desk's job (desk.ts); this file only brings displays up and down. systemd
 * keeps them running across restarts of the server and brings a piece that crashed back.
 */

/** Every screen's size. The dock, the wallpaper and the home page are laid out for about this much room. */
export const SCREEN_SIZE = { width: 1440, height: 900 };

/** Each display's session bus (deploy/dispatch-bus@.service). */
export const busAddress = (n: number) => `unix:path=${RUN_ROOT}/display-${n}/bus`;
const xLock = (n: number) => `/tmp/.X${n}-lock`;
const xSocket = (n: number) => `/tmp/.X11-unix/X${n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Does the VNC server on `port` take the relay? The check signs in and leaves: TigerVNC counts every
 * connection that leaves before signing in as a failed login, five of them lock 127.0.0.1 out (the
 * viewer relay with it), and a sign-in clears the count. Down means nothing listens, or the server
 * turns the connection away. A server that takes the connection but is slow to talk counts as up.
 */
function vncAnswers(port: number, connectMs = 800, talkMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const q = new ByteQueue();
    let timer = setTimeout(() => done(false), connectMs);
    function done(ok: boolean) { clearTimeout(timer); s.destroy(); resolve(ok); }
    s.on('data', (b: Buffer) => q.push(b));
    s.once('error', () => done(false));
    s.once('close', () => q.close(new Error('closed')));
    s.once('connect', () => {
      clearTimeout(timer);
      timer = setTimeout(() => done(true), talkMs);
      rfbHandshake(q, (b) => s.write(b)).then(() => done(true), () => done(false));
    });
  });
}

/**
 * An X server this app did not start holds the display (its lock names a live Xvnc while our unit is
 * down). The unit would clear its lock and break it, so the display isn't ours to start.
 */
function heldByOther(n: number): number | null {
  let pid = 0;
  try { pid = Number(fs.readFileSync(xLock(n), 'utf8').trim()); } catch { return null; }
  if (!(pid > 1)) return null;
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'Xvnc' ? pid : null; } catch { return null; }
}

/** Wait until display :n's X socket is there and its VNC server takes the relay; false after 15 s or once the unit failed. */
async function answers(n: number): Promise<boolean> {
  for (let i = 0; i < 75; i++) {
    if (fs.existsSync(xSocket(n)) && (await vncAnswers(vncPortFor(n), 300))) return true;
    if ((await unitState(xvncUnit(n))) === 'failed') return false;
    await sleep(200);
  }
  return false;
}

// ---------------------------------------------------------------- the API

const starting = new Map<number, Promise<void>>();

async function bringUp(n: number) {
  const state = await unitState(xvncUnit(n));
  if (state !== 'active' && state !== 'activating') {
    const other = heldByOther(n);
    if (other) throw new Error(`display :${n} belongs to an X server this app did not start (pid ${other})`);
  }
  // What the units read as they start: written every time, so a changed size, port or time zone
  // reaches the display the next time it starts.
  const { width, height } = SCREEN_SIZE;
  writeEnvFile(displayEnvFile(n), { VNC_PORT: String(vncPortFor(n)), GEOMETRY: `${width}x${height}`, TZ: process.env.TZ || 'UTC' });
  // Starts whichever of the display's pieces isn't running; cheap when all of them are.
  await start(displayTarget(n));
  if (await answers(n)) {
    if (state !== 'active') console.log(`[displays] :${n} up`);
    return;
  }
  // A wedged server, one without its X socket, or one that turns the relay away: no window of it can
  // be trusted, so the whole display starts over.
  console.warn(`[displays] :${n} does not answer; restarting it`);
  await restart(displayTarget(n));
  if (await answers(n)) { console.log(`[displays] :${n} up`); return; }
  throw new Error(`the screen for display :${n} did not come up within 15 seconds (journalctl -u ${xvncUnit(n)} says why)`);
}

/** Make sure display :n runs with its session pieces. Cheap when it already does; concurrent calls share one start. */
export function ensureDisplay(n: number): Promise<void> {
  if (!Number.isInteger(n) || n < 1) return Promise.reject(new Error(`bad display number ${n}`));
  let p = starting.get(n);
  if (!p) {
    p = bringUp(n).finally(() => starting.delete(n));
    starting.set(n, p);
  }
  return p;
}

/** Is display :n's X server running? */
export async function displayRunning(n: number): Promise<boolean> {
  return (await unitState(xvncUnit(n))) === 'active' && fs.existsSync(xSocket(n));
}

/**
 * Stop display :n and its pieces. What the bot ran on it went first, with its own units (the desk's
 * undress in desk.ts, and the bot's slice when the bot is deleted).
 */
export async function stopDisplay(n: number): Promise<void> {
  await starting.get(n)?.catch(() => {});
  await stop(displayTarget(n));
  console.log(`[displays] :${n} stopped`);
}

/** Only what a screenshot needs; none of this server's secrets. */
function displayEnv(n: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    DISPLAY: `:${n}`,
  };
}

/** A JPEG of what display :n shows right now. */
export function screenshot(n: number, quality = 75): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('import', ['-silent', '-window', 'root', '-quality', String(quality), 'jpeg:-'], {
      env: displayEnv(n), encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 15_000,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
