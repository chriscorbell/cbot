import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { box } from './box.js';
import { BOX_SCRIPTS, displayNumber, LOGS_ROOT } from './machine.js';
import { errorField, errorText } from './lib/errors.js';

/**
 * The desk: what makes one screen of the shared computer look like one bot's own tidy computer.
 * A soft wallpaper in the bot's colour, no taskbar, a small dock, a light maximized Chrome, and a
 * home screen (the bot's avatar, a clock, the computer's apps) as Chrome's new tab page.
 *
 * The work on the computer is done by the scripts in server/box/, which this file runs from where the
 * release put them, one command per action (dispatch-screen.py's docstring has the commands and what
 * they answer). The display itself is started by displays.ts; everything the scripts need on it is
 * installed by scripts/provision.sh.
 */

export interface DeskBot { id: string; name: string; label: string; avatarShape: string; avatarColor: string }

const SCRIPT = path.join(BOX_SCRIPTS, 'dispatch-screen.py');

const warn = (message: string) => console.warn(`[desk] ${message}`);
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');


// ---------------------------------------------------------------- talking to dispatch-screen.py

/**
 * What a finished piece of work reports. Its warnings are logged; ok false is a failure with its error,
 * and `crashed` a bug in the scripts, with the Python traceback in `trace`.
 */
const Result = z.object({
  ok: z.boolean(), error: z.string().optional(), warnings: z.array(z.string()).default([]),
  crashed: z.boolean().optional(), trace: z.string().optional(),
}).passthrough();
type Result = z.infer<typeof Result>;
/** Every command answers with its result, or with the detached job that will write it to `result`. */
const Answer = z.union([
  z.object({ done: Result }),
  z.object({ job: z.string(), pid: z.number().int(), result: z.string() }),
]);

/**
 * One call to dispatch-screen.py, followed to its end within maxSec: a job's result file is read where
 * the script said it would be, with no process started to ask. A script that is missing or crashed
 * throws (box.script says which), and is logged here in full, since it is a bug and not a state to
 * recover from.
 */
async function screenScript(args: string[], what: string, maxSec: number): Promise<Result> {
  let answer: z.infer<typeof Answer>;
  try {
    answer = Answer.parse(await box.script(SCRIPT, args, maxSec));
  } catch (e) {
    const message = e instanceof z.ZodError ? `the answer isn't what dispatch-screen.py sends: ${e.message}` : errorText(e);
    console.error(`[desk] ${what}: ${message}`);
    throw new Error(`${what} failed: ${message.split('\n')[0]}`);
  }
  const result = 'done' in answer ? answer.done : await jobResult(answer, what, maxSec);
  for (const w of result.warnings) warn(w);
  if (result.crashed) console.error(`[desk] ${what}: dispatch-screen.py crashed:\n${result.trace ?? result.error ?? ''}`);
  if (!result.ok) throw new Error(`${what} failed: ${result.error ?? 'unknown error'}`);
  return result;
}

/** A job's result, once its file is there. A job that ends without writing one (killed) is a failure, not a wait until maxSec. */
async function jobResult(job: { job: string; pid: number; result: string }, what: string, maxSec: number): Promise<Result> {
  const end = Date.now() + maxSec * 1000;
  for (let i = 0; ; i++) {
    const text = await fs.readFile(job.result, 'utf8').catch(() => null);
    if (text !== null) {
      try { return Result.parse(JSON.parse(text)); } catch (e) {
        throw new Error(`${what} failed: its result (${job.result}) isn't what dispatch-screen.py writes: ${errorText(e)}`);
      }
    }
    // Every two seconds, whether the job is still there; it writes its result before it exits.
    if (i % 10 === 9 && !alive(job.pid) && (await fs.access(job.result).then(() => false, () => true))) {
      throw new Error(`${what} failed: job ${job.job} ended without a result (${LOGS_ROOT}/jobs.log has its output)`);
    }
    if (Date.now() > end) throw new Error(`${what} is taking too long (job ${job.job} still running after ${maxSec}s)`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Whether a process is there. Signal 0 only asks; EPERM means it is, but isn't ours to signal. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return errorField(e, 'code') === 'EPERM'; }
}

// ---------------------------------------------------------------- one-time machine setup

let basePromise: Promise<void> | null = null;

/**
 * One-time machine setup (the home screen server, Chrome's policy and the extension, the bots' folders),
 * again whenever the scripts change. Memoised per process, and cheap when already done.
 */
export function ensureDeskBase(): Promise<void> {
  if (!basePromise) {
    basePromise = screenScript(['base'], 'computer setup', 180).then(() => undefined).catch((e: unknown) => { basePromise = null; throw e; });
  }
  return basePromise;
}

// ---------------------------------------------------------------- colours

type Rgb = [number, number, number];

const COLOR_HEX: Record<string, string> = {
  black: '#000000', brown: '#A06B39', red: '#FB2B3E', orange: '#FD690F', yellow: '#F59312', green: '#14C16F',
  cyan: '#13B7A2', blue: '#1E86FC', violet: '#8F59F9', magenta: '#F93498', gray: '#959595',
};

function colorHex(color: string): string {
  const c = (color ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join('')}`.toUpperCase();
  return COLOR_HEX[c.toLowerCase()] ?? COLOR_HEX.gray;
}

const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hexOf = (rgb: Rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, t: number) => { const x = rgbOf(a), y = rgbOf(b); return hexOf([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb); };

function hslOf(hex: string): Rgb {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return hexOf([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

interface Palette { accent: string; ink: string; wash: string; washDeep: string; washLight: string; glow: string; glow2: string; line: string }

/** Soft tints of the bot's colour. Black and gray get a calm blue-gray instead of a muddy wash. */
function paletteFor(avatarHex: string): Palette {
  const [h, s] = hslOf(avatarHex);
  const base = s < 0.15 ? '#7A869A' : avatarHex;
  const hue = s < 0.15 ? 218 : h;
  const sat = s < 0.15 ? 0.3 : Math.max(0.55, Math.min(0.9, s));
  return {
    accent: base,
    ink: mix(base, '#14171F', 0.8),
    wash: hslHex(hue, sat, 0.925),
    washLight: hslHex(hue - 12, sat * 0.9, 0.965),
    washDeep: hslHex(hue + 10, sat, 0.865),
    glow: hslHex(hue + 28, Math.min(1, sat + 0.1), 0.84),
    glow2: hslHex(hue - 30, sat, 0.84),
    line: hslHex(hue, sat * 0.85, 0.68),
  };
}

// ---------------------------------------------------------------- wallpaper

/**
 * The wallpaper as an SVG that fills whatever size it is given (__W__ and __H__ are filled in on the computer).
 * One flat wash of the bot's color: the mascot, clock and dock carry the character, so the backdrop stays quiet.
 */
function wallpaperSvg(p: Palette): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="__W__" height="__H__"><rect width="100%" height="100%" fill="${p.wash}"/></svg>`;
}

// ---------------------------------------------------------------- avatar

interface ShapeDef { viewBox: string; d: string; outline: string }
let shapesCache: Record<string, ShapeDef> | null = null;

/** The avatar art lives in the web app; read it as text so the server needs no build step for it. */
function shapes(): Record<string, ShapeDef> {
  if (shapesCache) return shapesCache;
  shapesCache = {};
  try {
    const text = readFileSync(new URL('../../web/src/avatar/shapes.gen.ts', import.meta.url), 'utf8');
    const start = text.indexOf('{', text.indexOf('SHAPES'));
    const end = text.lastIndexOf('}');
    if (start > 0 && end > start) shapesCache = JSON.parse(text.slice(start, end + 1)) as Record<string, ShapeDef>;
  } catch {
    warn('avatar shapes not found, using a plain circle');
  }
  return shapesCache;
}

function avatarSvg(shape: string, fill: string): string {
  const all = shapes();
  const def = all[shape] ?? all.blob;
  const safe = (s: string) => /^[\w\s.,\-+]*$/.test(s);
  if (!def || !safe(def.d) || !safe(def.outline) || !safe(def.viewBox)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#fff"/><circle cx="24" cy="24" r="19" fill="${fill}"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${def.viewBox}"><path d="${def.outline}" fill="#fff"/><path d="${def.d}" fill="${fill}" fill-rule="evenodd"/></svg>`;
}

// ---------------------------------------------------------------- the look of one screen

/** The look as dispatch-screen.py takes it, with a stamp that changes whenever the look does: gzipped JSON in base64. */
function lookFor(bot: DeskBot): string {
  const hex = colorHex(bot.avatarColor);
  const p = paletteFor(hex);
  const look = {
    bot: { id: bot.id, name: bot.name, label: bot.label ?? '', avatarShape: bot.avatarShape, avatarColor: bot.avatarColor },
    colors: { accent: p.accent, ink: p.ink, wash: p.wash, washDeep: p.washDeep },
    avatarSvg: avatarSvg(bot.avatarShape, hex),
    wallSvg: wallpaperSvg(p),
  };
  const stamp = sha(JSON.stringify(look)).slice(0, 20);
  return gzipSync(Buffer.from(JSON.stringify({ stamp, ...look }), 'utf8')).toString('base64');
}

/** Calls for one screen run one after another, so a rename and a reset cannot trip over each other. */
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(screenId: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(screenId) ?? Promise.resolve()).then(work, work);
  const tail = next.catch(() => undefined);
  queues.set(screenId, tail);
  void tail.then(() => { if (queues.get(screenId) === tail) queues.delete(screenId); });
  return next;
}

async function dress(bot: DeskBot, screenId: string, flags: string, what: string): Promise<void> {
  if (!/^[\w.-]+$/.test(bot.id)) throw new Error(`bot id ${JSON.stringify(bot.id)} cannot be used as a folder name`);
  const n = displayNumber(screenId);
  if (!Number.isInteger(n)) throw new Error(`unknown screen ${screenId}`);
  await ensureDeskBase();
  await screenScript(['dress', String(n), flags || '-', lookFor(bot)], what, 240);
}

/** Make `screenId` look like `bot`'s computer and start the bot's Chrome there (own profile, own DevTools port, maximized, on its home screen)
 *  if it isn't running. Idempotent and quick when nothing changed (a stamp on the box says what was applied, so a repeat call is one short script run).
 *  restartChrome restarts that Chrome so it picks up a new look. */
export function dressScreen(bot: DeskBot, screenId: string, opts?: { restartChrome?: boolean }): Promise<void> {
  return inTurn(screenId, () => dress(bot, screenId, opts?.restartChrome ? 'r' : '', `dressing screen ${screenId}`));
}

/** Back to a clean start: close every app window on the screen except the desktop pieces, then bring Chrome back on the home screen. Logins in the profile stay. */
export function resetScreen(bot: DeskBot, screenId: string): Promise<void> {
  return inTurn(screenId, () => dress(bot, screenId, 'x', `resetting screen ${screenId}`));
}

/** The bot is gone: stop its Chrome, dock and anything else we started for that screen (the display itself is displays.ts's, and the profile dir stays). */
export function undressScreen(botId: string, screenId: string): Promise<void> {
  return inTurn(screenId, async () => {
    if (botId && !/^[\w.-]+$/.test(botId)) throw new Error(`bot id ${JSON.stringify(botId)} cannot be used as a folder name`);
    await screenScript(['undress', String(displayNumber(screenId)), botId], `undressing screen ${screenId}`, 240);
  });
}
