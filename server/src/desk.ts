import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { box } from './box.js';
import { BOX_ROOT, displayNumber } from './machine.js';

/**
 * The desk: what makes one screen of the shared computer look like one bot's own tidy computer.
 * A soft wallpaper in the bot's colour, no taskbar, a small dock, a light maximized Chrome, and a
 * home screen (the bot's avatar, a clock, the computer's apps) as Chrome's new tab page.
 *
 * The work on the computer is done by the scripts in server/box/, which this file installs under
 * /opt/cbot and then calls with one short command per action. The display itself is started by
 * displays.ts; everything the scripts need on it is installed by scripts/provision.sh.
 */

export interface DeskBot { id: string; name: string; label: string; avatarShape: string; avatarColor: string }

const ROOT = BOX_ROOT;
const SCRIPT = `${ROOT}/cbot-screen.py`;
/** Source file under server/box/ -> where it lives under /opt/cbot on the computer. */
const BOX_FILES: Record<string, string> = {
  'cbotlib.py': 'cbotlib.py',
  'cbot-screen.py': 'cbot-screen.py',
  'cbot-shell.py': 'cbot-shell.py',
  'cbot-home.py': 'cbot-home.py',
  'home.html': 'home.html',
  'ext/manifest.json': 'ext/src/manifest.json',
  'ext/newtab.html': 'ext/src/newtab.html',
  'ext/newtab.js': 'ext/src/newtab.js',
};

const warn = (message: string) => console.warn(`[desk] ${message}`);
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');


// ---------------------------------------------------------------- the files that go on the computer

interface Bundle { files: Record<string, string>; hash: string }
let bundleCache: Bundle | null = null;

/** server/box/ sits next to both src/ (tsx) and dist/ (after tsc). */
function bundle(): Bundle {
  if (bundleCache) return bundleCache;
  const files: Record<string, string> = {};
  const h = createHash('sha256');
  for (const [src, dest] of Object.entries(BOX_FILES)) {
    const text = fs.readFileSync(new URL(`../box/${src}`, import.meta.url), 'utf8');
    files[dest] = text;
    h.update(`${dest}\0${sha(text)}\n`);
  }
  bundleCache = { files, hash: h.digest('hex').slice(0, 20) };
  return bundleCache;
}

// ---------------------------------------------------------------- talking to the box-side script

interface Reply { kind: 'OK' | 'DONE' | 'RUNNING' | 'NOBASE' | 'BASE_OK' | 'NONE'; rest: string; raw: string }

function parseReply(output: string): Reply {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^CBOT_(OK|DONE|RUNNING|NOBASE|BASE_OK)\b ?(.*)$/.exec(lines[i]);
    if (m) return { kind: m[1] as Reply['kind'], rest: m[2], raw: output };
  }
  return { kind: 'NONE', rest: '', raw: output };
}

/** One call to cbot-screen.py. A missing or failing script answers NOBASE so the caller can install it. */
async function script(args: string[], screenId?: string, timeoutSec = 60): Promise<Reply> {
  const cmd = `[ -f ${SCRIPT} ] && python3 ${SCRIPT} ${args.map(box.quote).join(' ')} 2>&1 || echo CBOT_NOBASE`;
  const r = await box.bash(cmd, timeoutSec, screenId);
  return parseReply(r.output);
}

interface JobResult { ok?: boolean; error?: string; warnings?: string[]; [k: string]: unknown }

/** Follow a detached job on the computer to its end. Its warnings are logged; a failure throws. */
async function finish(first: Reply, what: string, maxSec: number): Promise<JobResult> {
  let reply = first;
  const end = Date.now() + maxSec * 1000;
  while (reply.kind === 'RUNNING') {
    if (Date.now() > end) throw new Error(`${what} is taking too long (still running after ${maxSec}s)`);
    reply = await script(['wait', reply.rest.trim(), '25']);
  }
  if (reply.kind === 'OK') return { ok: true };
  if (reply.kind !== 'DONE') throw new Error(`${what} failed: ${reply.raw.trim().slice(-300) || 'no answer from the computer'}`);
  let result: JobResult = {};
  try { result = JSON.parse(reply.rest) as JobResult; } catch { /* treated as plain success */ }
  for (const w of result.warnings ?? []) warn(w);
  if (result.ok === false) throw new Error(`${what} failed: ${result.error ?? 'unknown error'}`);
  return result;
}

// ---------------------------------------------------------------- one-time machine setup

let basePromise: Promise<void> | null = null;

async function setupBase(): Promise<void> {
  const b = bundle();
  const check = await script(['base-check', b.hash]);
  if (check.kind === 'BASE_OK') return;
  // The scripts are missing or changed: send them over in one piece and unpack.
  const packed = gzipSync(Buffer.from(JSON.stringify({ files: b.files }), 'utf8'));
  await box.writeFile(`${ROOT}/bundle.json.gz`, packed);
  const unpack = [
    'import gzip, json, os',
    `root = ${JSON.stringify(ROOT)}`,
    "files = json.load(gzip.open(root + '/bundle.json.gz', 'rt', encoding='utf-8'))['files']",
    'for rel, text in files.items():',
    '    path = os.path.join(root, rel)',
    '    os.makedirs(os.path.dirname(path), exist_ok=True)',
    "    with open(path + '.new', 'w', encoding='utf-8') as f:",
    '        f.write(text)',
    "    os.chmod(path + '.new', 0o755 if rel.endswith('.py') else 0o644)",
    "    os.replace(path + '.new', path)",
    "src = root + '/ext/src'",
    'for name in os.listdir(src):',
    "    if 'ext/src/' + name not in files:",
    '        os.unlink(os.path.join(src, name))',
    "os.unlink(root + '/bundle.json.gz')",
    "print('CBOT_UNPACKED')",
  ].join('\n');
  const r = await box.bash(`python3 -c ${box.quote(unpack)} 2>&1`, 60);
  if (!r.output.includes('CBOT_UNPACKED')) {
    throw new Error(`could not install the desktop scripts on the computer (python3 is needed): ${r.output.trim().slice(-300)}`);
  }
  // Package installs can take a while on a fresh computer.
  await finish(await script(['base', b.hash]), 'computer setup', 900);
}

/** One-time machine setup (packages, scripts, home server, Chrome policy/extension). Idempotent, memoised per process, cheap when already done. */
export function ensureDeskBase(): Promise<void> {
  if (!basePromise) {
    basePromise = setupBase().catch((e) => { basePromise = null; throw e; });
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
    const text = fs.readFileSync(new URL('../../web/src/avatar/shapes.gen.ts', import.meta.url), 'utf8');
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

function lookFor(bot: DeskBot): { stamp: string; payload: string } {
  const hex = colorHex(bot.avatarColor);
  const p = paletteFor(hex);
  const look = {
    // Every bot's Chrome is ours to start and stop (the scripts also handle a browser that belongs to someone else).
    manageChrome: true,
    bot: { id: bot.id, name: bot.name, label: bot.label ?? '', avatarShape: bot.avatarShape, avatarColor: bot.avatarColor },
    colors: { accent: p.accent, ink: p.ink, wash: p.wash, washDeep: p.washDeep },
    avatarSvg: avatarSvg(bot.avatarShape, hex),
    wallSvg: wallpaperSvg(p),
  };
  const stamp = sha(`${bundle().hash}\n${JSON.stringify(look)}`).slice(0, 20);
  return { stamp, payload: gzipSync(Buffer.from(JSON.stringify({ stamp, ...look }), 'utf8')).toString('base64') };
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
  const { stamp, payload } = lookFor(bot);
  const args = ['go', String(n), bundle().hash, stamp, flags || '-', payload];
  let reply = await script(args, screenId);
  if (reply.kind === 'NOBASE' || reply.kind === 'NONE') {
    basePromise = null;                 // whatever we knew about the computer is out of date
    await ensureDeskBase();
    reply = await script(args, screenId);
    if (reply.kind === 'NOBASE') throw new Error(`${what} failed: the desktop scripts on the computer do not run (${reply.raw.trim().slice(-200)})`);
  }
  await finish(reply, what, 240);
}

/** Make `screenId` look like `bot`'s computer and start the bot's Chrome there (own profile, own DevTools port, maximized, on its home screen)
 *  if it isn't running. Idempotent and quick when nothing changed (a stamp on the box says what was applied, so a repeat call is ~1 bash call).
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
    const reply = await script(['undress', String(displayNumber(screenId)), botId], screenId, 90);
    // No scripts on the computer means nothing of ours runs there either.
    if (reply.kind === 'NOBASE' && !reply.raw.includes('Traceback')) return;
    if (reply.kind !== 'DONE') throw new Error(`undressing screen ${screenId} failed: ${reply.raw.trim().slice(-300)}`);
  });
}

