import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { ByteQueue, rfbHandshake } from './lib/rfb.js';
import { vncPortFor } from './machine.js';

/**
 * The bots' screens. Each one is an X display of its own on this machine: TigerVNC's Xvnc (the X
 * server and its VNC server in one process), a D-Bus session bus and the xfwm4 window manager. Making
 * a screen look like a bot's computer is the desk's job (desk.ts); this file only brings displays up
 * and down.
 *
 * Everything is started detached, the way engine.ts starts the Hermes gateways, and carries
 * CBOT_DISPLAY=<n> in its environment. That tag is how a display that already runs is found again
 * and used as it is, and how stopping a display finds its pieces.
 */

/** Every screen's size. The dock, the wallpaper and the home page are laid out for about this much room. */
export const SCREEN_SIZE = { width: 1440, height: 900 };


const LOGS = '/var/log/cbot';
const busDir = (n: number) => `/run/cbot/display-${n}`;
const busAddress = (n: number) => `unix:path=${busDir(n)}/bus`;
const xLock = (n: number) => `/tmp/.X${n}-lock`;
const X_SOCKETS = '/tmp/.X11-unix';
const xSocket = (n: number) => `${X_SOCKETS}/X${n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- processes

function environ(pid: number): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const item of fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0')) {
      const i = item.indexOf('=');
      if (i > 0) out.set(item.slice(0, i), item.slice(i + 1));
    }
  } catch { /* gone, or not ours to read */ }
  return out;
}

function comm(pid: number): string {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; }
}

function alive(pid: number): boolean {
  try {
    // A zombie still answers kill(0); its state letter says it is gone.
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').pop()!.trim()[0] !== 'Z';
  } catch { return false; }
}

const allPids = () => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number).filter((p) => p !== process.pid);

/** Everything we run for display :n (and what its bus started for it), as pid -> program name. */
function pieces(n: number): Map<number, string> {
  const found = new Map<number, string>();
  for (const pid of allPids()) {
    if (environ(pid).get('CBOT_DISPLAY') === String(n) && alive(pid)) found.set(pid, comm(pid));
  }
  return found;
}

const running = (mine: Map<number, string>, name: string) => [...mine.values()].includes(name);

async function stopPids(pids: number[], graceMs = 3000) {
  const live = pids.filter(alive);
  for (const p of live) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  const end = Date.now() + graceMs;
  while (Date.now() < end && live.some(alive)) await sleep(100);
  for (const p of live.filter(alive)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
}

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

// ---------------------------------------------------------------- starting pieces

function logFile(name: string): number {
  fs.mkdirSync(LOGS, { recursive: true });
  const file = `${LOGS}/${name}.log`;
  try { if (fs.statSync(file).size > 4 * 1024 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* new file */ }
  return fs.openSync(file, 'a');
}

/** Only what a display piece needs; none of this server's secrets. */
function displayEnv(n: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    USER: process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    DISPLAY: `:${n}`,
  };
}

/** The pieces of display :n carry its tag. */
const pieceEnv = (n: number): NodeJS.ProcessEnv => ({ ...displayEnv(n), CBOT_DISPLAY: String(n) });

/** Start a long-lived piece of display :n, detached. `exited` says why it stopped, once it has. */
function start(n: number, name: string, argv: string[], env: NodeJS.ProcessEnv): { exited: () => string | null } {
  const log = logFile(`${name}-${n}`);
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', log, log], env });
  fs.closeSync(log);
  let exited: string | null = null;
  child.once('error', (e) => { exited = `could not run ${argv[0]}: ${e.message}`; });
  child.once('exit', (code, signal) => { exited = `${argv[0]} stopped (${signal ?? `exit ${code}`}); see ${LOGS}/${name}-${n}.log`; });
  child.unref();
  return { exited: () => exited };
}

/** An X lock whose server is gone (after a reboot or a crash) would stop a new Xvnc from taking the display. */
function clearStaleLock(n: number) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(xLock(n), 'utf8').trim()); } catch { return; }
  if (pid > 1 && alive(pid) && comm(pid) === 'Xvnc') {
    throw new Error(`display :${n} belongs to an X server this app did not start (pid ${pid})`);
  }
  for (const f of [xLock(n), xSocket(n)]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
}

async function startXvnc(n: number) {
  clearStaleLock(n);
  // Two servers starting at once race to create the socket folder, and the loser runs without a socket.
  fs.mkdirSync(X_SOCKETS, { recursive: true, mode: 0o1777 });
  const { width, height } = SCREEN_SIZE;
  const x = start(n, 'xvnc', [
    'Xvnc', `:${n}`,
    '-geometry', `${width}x${height}`, '-depth', '24', '-dpi', '96',
    '-rfbport', String(vncPortFor(n)), '-localhost',
    // Only the relay connects, over loopback; it does its own sign-in check. Every connection comes
    // from 127.0.0.1, so a blacklist of hosts that fail to sign in could only lock the relay out.
    '-SecurityTypes', 'None', '-UseBlacklist=0', '-AlwaysShared', '-AcceptSetDesktopSize=0',
    '-nolisten', 'tcp', '-s', '0', '-dpms', '-desktop', `cbot :${n}`,
  ], pieceEnv(n));
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    const gone = x.exited();
    if (gone) throw new Error(`the screen for display :${n} did not start: ${gone}`);
    if (fs.existsSync(xSocket(n)) && (await vncAnswers(vncPortFor(n), 300))) return;
  }
  throw new Error(`the screen for display :${n} did not come up within 15 seconds (see ${LOGS}/xvnc-${n}.log)`);
}

function startBus(n: number) {
  fs.mkdirSync(busDir(n), { recursive: true });
  try { fs.unlinkSync(`${busDir(n)}/bus`); } catch { /* none left over */ }
  start(n, 'bus', ['dbus-daemon', '--session', '--nofork', '--nopidfile', `--address=${busAddress(n)}`], pieceEnv(n));
}

async function startWindowManager(n: number) {
  // The bus must answer before xfwm4 asks it for its settings.
  for (let i = 0; i < 30 && !fs.existsSync(`${busDir(n)}/bus`); i++) await sleep(100);
  // No compositor: nothing on these screens needs one, and it would redraw on every frame the VNC server sends.
  start(n, 'wm', ['xfwm4', '--compositor=off', '--sm-client-disable'], { ...pieceEnv(n), DBUS_SESSION_BUS_ADDRESS: busAddress(n) });
}

// ---------------------------------------------------------------- the API

const starting = new Map<number, Promise<void>>();

async function bringUp(n: number) {
  let mine = pieces(n);
  if (!running(mine, 'Xvnc') || !fs.existsSync(xSocket(n)) || !(await vncAnswers(vncPortFor(n)))) {
    // A wedged server, one without its X socket, or one that turns the relay away: no window of it can be
    // trusted, so the whole display starts over.
    if (mine.size) { await stopPids([...mine.keys()]); mine = new Map(); }
    await startXvnc(n);
    console.log(`[displays] :${n} up`);
  }
  if (!running(mine, 'dbus-daemon')) startBus(n);
  if (!running(mine, 'xfwm4')) await startWindowManager(n);
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
export function displayRunning(n: number): boolean {
  return running(pieces(n), 'Xvnc') && fs.existsSync(xSocket(n));
}

/** Stop display :n: whatever else still runs on it first, then the display's own pieces. */
export async function stopDisplay(n: number): Promise<void> {
  await starting.get(n)?.catch(() => {});
  const mine = pieces(n);
  // A bot's Hermes gateway also has this DISPLAY; it is engine.ts's to stop, not ours.
  const others = allPids().filter((pid) => {
    const e = environ(pid);
    return !mine.has(pid) && e.get('DISPLAY') === `:${n}` && !e.has('HERMES_HOME');
  });
  await stopPids(others, 2000);
  await stopPids([...mine.keys()]);
  for (const f of [xLock(n), xSocket(n), `${busDir(n)}/bus`]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  console.log(`[displays] :${n} stopped`);
}

/** A JPEG of what display :n shows right now. */
export function screenshot(n: number, quality = 75): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('import', ['-silent', '-window', 'root', '-quality', String(quality), 'jpeg:-'], {
      env: displayEnv(n), encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 15_000,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
