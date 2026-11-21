import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RUN_ROOT } from './machine.js';

/**
 * systemd runs everything long-lived that a bot has on the computer, and this file is how the server
 * asks it to. Nothing here keeps state of its own: systemd knows what runs.
 *
 *   dispatch-display@<n>.target       display :n (displays.ts): dispatch-xvnc@, dispatch-bus@ and
 *                                     dispatch-wm@<n>.service, in dispatch-displays.slice
 *   dispatch-gateway@<key>.service    the bot's Hermes gateway (engine.ts)
 *   dispatch-bot-<key>.slice          the bot's memory and CPU share: its gateway, and its Chrome
 *                                     (dispatch-chrome-<key>.service), dock, terminals and apps, which
 *                                     the box scripts start with systemd-run (server/box/dispatchlib.py)
 *
 * <key> is the bot id escaped as systemd-escape does it, since a slice's name is a path and `-` in it
 * would make a slice inside a slice. Bot ids are `bot_` and base64url, so only `-` needs it.
 *
 * The units live apart from dispatch.service, so restarting the server (a deploy, an update) leaves the
 * bots' screens and agents running, and the server uses them as they are when it starts again.
 * deploy/ has the unit files, which scripts/provision.sh installs.
 */

/** A bot id as a unit name's instance (systemd-escape): everything but letters, digits, `_` and `.` as \xNN. */
export function unitKey(botId: string): string {
  return [...botId].map((ch, i) => (/[A-Za-z0-9_]/.test(ch) || (ch === '.' && i > 0) ? ch : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)).join('');
}

export const gatewayUnit = (botId: string) => `dispatch-gateway@${unitKey(botId)}.service`;
export const botSlice = (botId: string) => `dispatch-bot-${unitKey(botId)}.slice`;
export const displayTarget = (n: number) => `dispatch-display@${n}.target`;
export const xvncUnit = (n: number) => `dispatch-xvnc@${n}.service`;

/** Where the gateway unit of a bot reads its environment (deploy/dispatch-gateway@.service). */
export const gatewayEnvFile = (botId: string) => path.join(RUN_ROOT, `gateway-${botId}.env`);
/** Where the units of display :n read theirs (deploy/dispatch-xvnc@.service). */
export const displayEnvFile = (n: number) => path.join(RUN_ROOT, `display-${n}.env`);

/** Write a unit's environment file: KEY=value lines, values that hold no newline. */
export function writeEnvFile(file: string, vars: Record<string, string | undefined>) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const text = Object.entries(vars)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => {
      if (/[\n\r]/.test(v)) throw new Error(`${k} can't go in ${file}: it has a line break`);
      return `${k}=${JSON.stringify(v)}`;
    })
    .join('\n');
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, `${text}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

interface Result { code: number; stdout: string; stderr: string }

function systemctl(args: string[], timeoutMs = 60_000): Promise<Result> {
  return new Promise((resolve) => {
    execFile('systemctl', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Throws a sentence with what systemctl said and where its journal is. */
async function must(args: string[], unit: string): Promise<void> {
  const r = await systemctl(args);
  if (r.code !== 0) {
    const said = r.stderr.trim().split('\n').filter(Boolean).pop() ?? `exit ${r.code}`;
    throw new Error(`systemctl ${args[0]} ${unit} failed: ${said} (journalctl -u ${unit} says more)`);
  }
}

/** What systemd says the unit is doing: active, activating, inactive, failed, … */
export async function unitState(unit: string): Promise<string> {
  const r = await systemctl(['is-active', unit], 15_000);
  return r.stdout.trim() || 'inactive';
}

export const start = (unit: string) => must(['start', unit], unit);
/** Start it, or restart it when it runs. */
export const restart = (unit: string) => must(['restart', unit], unit);

/** Stop units, waiting for them; one that isn't there counts as stopped. */
export async function stop(...units: string[]): Promise<void> {
  if (!units.length) return;
  const r = await systemctl(['stop', ...units], 120_000);
  if (r.code !== 0 && !/not loaded|does not exist/i.test(r.stderr)) {
    console.warn(`[units] stopping ${units.join(' ')}: ${r.stderr.trim()}`);
  }
}

/** The main process of a running service, or null. */
export async function mainPid(unit: string): Promise<number | null> {
  const r = await systemctl(['show', '-p', 'MainPID', '--value', unit], 15_000);
  const pid = Number(r.stdout.trim());
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

const MiB = 1024 * 1024;
/** Kept for the server, the speech service, the displays and the system before the bots share the rest. */
export const RESERVED_BYTES = 2048 * MiB;
/** A bot gets at least this much even on a machine with less to spare than its MAX_BOTS asks for. */
export const MIN_BOT_BYTES = 768 * MiB;

/**
 * A bot's share of the machine: (memory − 2 GiB) ÷ MAX_BOTS, at least 768 MiB, as its slice's
 * MemoryMax; MemoryHigh at 85% of that, where the kernel starts reclaiming its memory before anything
 * is killed; and at most half as much again in swap, so a machine with swap doesn't let a runaway bot
 * swap without end and slow every bot down. A bot that goes over loses a process of its own (Chrome
 * usually), never another bot's or the server's. CPUWeight 50 against the default 100 keeps a busy
 * bot from starving the server, the speech service and the screens.
 */
export function botLimits(totalBytes: number, maxBots: number): Record<string, string> {
  const share = Math.max(MIN_BOT_BYTES, Math.floor((totalBytes - RESERVED_BYTES) / Math.max(1, maxBots)));
  const mib = (b: number) => `${Math.floor(b / MiB)}M`;
  return { MemoryHigh: mib(share * 0.85), MemoryMax: mib(share), MemorySwapMax: mib(share / 2), CPUWeight: '50' };
}

/** Set a slice's limits until the next boot; the server sets them again before it starts the bot. */
export async function setSliceLimits(slice: string, limits: Record<string, string>): Promise<void> {
  await must(['set-property', '--runtime', slice, ...Object.entries(limits).map(([k, v]) => `${k}=${v}`)], slice);
}

/**
 * The bot is gone: stop its slice, and with it anything of the bot's still running (what its terminal
 * started, say), then forget the slice's limits and its gateway's environment.
 */
export async function removeBotUnits(botId: string): Promise<void> {
  await stop(gatewayUnit(botId), botSlice(botId));
  await systemctl(['reset-failed', gatewayUnit(botId)], 15_000);
  fs.rmSync(`/run/systemd/system.control/${botSlice(botId)}.d`, { recursive: true, force: true });
  fs.rmSync(gatewayEnvFile(botId), { force: true });
}
