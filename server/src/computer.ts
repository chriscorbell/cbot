import { db, now, type BotRecord, type ScreenRecord } from './db.js';
import { hub } from './lib/hub.js';
import { dressScreen, resetScreen, undressScreen, type DeskBot } from './desk.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cdpPortFor, displayNumber, FIRST_BOT_DISPLAY, libraryDir, LIBRARY_ROOT, profileDir, PROFILES_ROOT } from './machine.js';
import { ensureDisplay, SCREEN_SIZE, stopDisplay } from './displays.js';
import type { ComputerState } from './types.js';
import { errorText } from './lib/errors.js';

/**
 * The computer every bot works on is the machine this server runs on. Each bot has a screen of its
 * own on it (an X display, see displays.ts) dressed in its colour (see desk.ts): the primary bot the default screen
 * (:99), every other bot the lowest free display from :100 up. A lease is a row in `screens`. It
 * outlives this server; the display behind it is started again whenever the lease is used.
 *
 * A bot's screen goes through these layers, each with its own record:
 *
 *   lease      `screens` row (claim, synchronous so two bots never get one display; freed last by releaseScreen)
 *   display    Xvnc + bus + window manager, systemd units (displays.ts); checked at most every 15 s (`verified`),
 *              with one start in flight per bot (`leasing`)
 *   dressed    wallpaper, dock, the bot's Chrome on its home page (desk.ts); once per server run, again
 *              on a rename or new colour, or when its Chrome stops answering (`dressing`, a failed
 *              attempt is forgotten so the next use tries again)
 *
 * `failure` is the last display that would not start, shown in the app until one starts again.
 */

export interface BotScreen { screenId: string; width: number; height: number }


/** Why the last screen could not be started, shown in the app until a screen starts again. */
let failure: string | null = null;

export function computerState(userId: string): ComputerState {
  const screens = db.prepare<[string], Pick<ScreenRecord, 'bot_id' | 'screen_id'>>('SELECT bot_id, screen_id FROM screens WHERE user_id=?').all(userId)
    .map((s) => ({ botId: s.bot_id, screenId: s.screen_id, ...SCREEN_SIZE }));
  return { status: failure ? 'error' : 'running', error: failure, screens };
}

function setFailure(userId: string, error: string | null) {
  if (failure === error) return;
  failure = error;
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
}

function deskBot(botId: string): DeskBot | null {
  const b = db.prepare<[string], Pick<BotRecord, 'id' | 'name' | 'label' | 'avatar_shape' | 'avatar_color'>>('SELECT id, name, label, avatar_shape, avatar_color FROM bots WHERE id=?').get(botId);
  return b ? { id: b.id, name: b.name, label: b.label ?? '', avatarShape: b.avatar_shape, avatarColor: b.avatar_color } : null;
}

const isPrimaryBot = (botId: string) => !!db.prepare<[string], Pick<BotRecord, 'is_primary'>>('SELECT is_primary FROM bots WHERE id=?').get(botId)?.is_primary;

/** This bot's screen id, claiming one the first time. Synchronous, so two bots can never claim the same display. */
function claim(userId: string, botId: string): { screenId: string; fresh: boolean } {
  // A bot deleted while something was still getting its screen ready must not lease a new one.
  if (!db.prepare('SELECT 1 FROM bots WHERE id=?').get(botId)) throw new Error(`no bot ${botId}`);
  const mine = db.prepare<[string], Pick<ScreenRecord, 'screen_id'>>('SELECT screen_id FROM screens WHERE bot_id=?').get(botId);
  if (mine) return { screenId: mine.screen_id, fresh: false };
  const taken = new Set(db.prepare<[], Pick<ScreenRecord, 'screen_id'>>('SELECT screen_id FROM screens').all().map((r) => r.screen_id));
  let screenId = 'default';
  if (!isPrimaryBot(botId) || taken.has(screenId)) {
    let n = FIRST_BOT_DISPLAY;
    while (taken.has(`screen-${n}`)) n++;
    screenId = `screen-${n}`;
  }
  db.prepare('INSERT INTO screens(bot_id,user_id,screen_id,last_used_at) VALUES (?,?,?,?)').run(botId, userId, screenId, now());
  return { screenId, fresh: true };
}

/** When each bot's display was last seen running, so a busy bot does not ask systemd and the VNC server on every turn. */
const verified = new Map<string, number>();
const leasing = new Map<string, Promise<BotScreen>>();
const dressing = new Map<string, Promise<void>>();

/** This bot's screen, running. Leases one the first time. */
export function screenFor(userId: string, botId: string): Promise<BotScreen> {
  const running = leasing.get(botId);
  if (running) return running;
  const p = lease(userId, botId).finally(() => leasing.delete(botId));
  leasing.set(botId, p);
  return p;
}

async function lease(userId: string, botId: string): Promise<BotScreen> {
  const { screenId, fresh } = claim(userId, botId);
  if (fresh || Date.now() - (verified.get(botId) ?? 0) > 15_000) {
    try {
      await ensureDisplay(displayNumber(screenId));
    } catch (e) {
      setFailure(userId, errorText(e));
      throw e;
    }
    verified.set(botId, Date.now());
    setFailure(userId, null);
  }
  db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
  if (fresh) hub.emit(userId, { type: 'computer', state: computerState(userId) });
  return { screenId, ...SCREEN_SIZE };
}

/**
 * The bot's screen, dressed as its own computer (wallpaper, dock, its Chrome on its home screen).
 * Dressing happens once per server run per bot, and again when `redress` is set (rename, new colour).
 */
export async function readyScreen(userId: string, botId: string, opts: { redress?: boolean } = {}): Promise<BotScreen> {
  const s = await screenFor(userId, botId);
  if (opts.redress) dressing.delete(botId);
  let d = dressing.get(botId);
  if (!d) {
    const bot = deskBot(botId);
    const attempt: Promise<void> = bot
      ? dressScreen(bot, s.screenId).catch((e) => {
          console.warn(`[computer] could not dress ${s.screenId} for ${botId}: ${e?.message ?? e}`);
          // Try again next time, unless a redress has replaced this attempt meanwhile.
          if (dressing.get(botId) === attempt) dressing.delete(botId);
        })
      : Promise.resolve();
    d = attempt;
    dressing.set(botId, d);
  }
  await d;
  return s;
}

/** DevTools address of the Chrome on this screen (for Hermes' browser tools). */
export function cdpUrlFor(screenId: string): string {
  return `http://127.0.0.1:${cdpPortFor(screenId)}`;
}

/**
 * Called before a bot starts working: its screen is leased and dressed, and the browser we run for it
 * answers. Without this a bot's first turn finds no browser and goes off to start one of its own.
 */
export async function screenForWork(userId: string, botId: string): Promise<void> {
  // A Chrome being started again on a new version (restartChrome) is waited for, not worked in.
  await chromeRestarts.get(botId)?.catch(() => {});
  const s = await readyScreen(userId, botId);
  const alive = await fetch(`${cdpUrlFor(s.screenId)}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  if (!alive) await readyScreen(userId, botId, { redress: true });
}

/** Every bot's leased screen. */
export function leasedScreens(): { userId: string; botId: string; screenId: string }[] {
  return db.prepare<[], Pick<ScreenRecord, 'bot_id' | 'user_id' | 'screen_id'>>('SELECT s.bot_id, s.user_id, s.screen_id FROM screens s JOIN bots b ON b.id = s.bot_id ORDER BY s.screen_id')
    .all().map((s) => ({ userId: s.user_id, botId: s.bot_id, screenId: s.screen_id }));
}

/** Chrome restarts under way, by bot; screenForWork waits for them. */
const chromeRestarts = new Map<string, Promise<void>>();

/**
 * Start the bot's Chrome again, on its home screen, so it runs the version installed now. Logins stay;
 * open tabs go. Only while `quiet()` holds, asked last with no await between it and the restart being
 * in chromeRestarts: work that starts after that waits for the restart instead of losing its browser
 * halfway. False when it didn't restart.
 */
export async function restartChrome(userId: string, botId: string, quiet: () => boolean): Promise<boolean> {
  const s = await screenFor(userId, botId);
  const bot = deskBot(botId);
  if (!bot || !quiet() || chromeRestarts.has(botId)) return false;
  const restart = dressScreen(bot, s.screenId, { restartChrome: true }).finally(() => chromeRestarts.delete(botId));
  chromeRestarts.set(botId, restart);
  await restart;
  return true;
}

/** Close everything on the bot's screen and bring its browser back to the home screen. Logins stay. */
export async function resetBotScreen(userId: string, botId: string): Promise<void> {
  const s = await screenFor(userId, botId);
  const bot = deskBot(botId);
  if (bot) await resetScreen(bot, s.screenId);
}

/**
 * The bot is gone: stop what we ran on its screen, then the display, and free it for the next bot.
 * The lease goes last, so no other bot can claim the display while it is being taken down.
 */
export async function releaseScreen(botId: string): Promise<void> {
  await leasing.get(botId)?.catch(() => {});
  const mine = db.prepare<[string], Pick<ScreenRecord, 'screen_id' | 'user_id'>>('SELECT screen_id, user_id FROM screens WHERE bot_id=?').get(botId);
  if (!mine) return;
  dressing.delete(botId);
  verified.delete(botId);
  try {
    try { await undressScreen(botId, mine.screen_id); } catch (e) { console.warn(`[computer] undress failed: ${errorText(e)}`); }
    await stopDisplay(displayNumber(mine.screen_id));
  } finally {
    db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
    hub.emit(mine.user_id, { type: 'computer', state: computerState(mine.user_id) });
  }
}

/**
 * A deleted bot leaves nothing behind on the computer: its browser profile and its Library folder go.
 * A group has only a folder, of the files attached in it.
 */
export async function forgetBotFiles(botId: string): Promise<void> {
  if (!/^(bot|room)_[\w-]+$/.test(botId)) return;
  await remove([profileDir(botId), libraryDir(botId)]);
}

/** Resetting Dispatch (reset.ts): every browser profile and Library folder, including any a bot left behind. */
export async function forgetAllBotFiles(): Promise<void> {
  const inside = async (dir: string) => (await fs.readdir(dir).catch(() => [] as string[])).map((name) => path.join(dir, name));
  await remove([...await inside(PROFILES_ROOT), ...await inside(LIBRARY_ROOT)]);
}

/** Delete each of these, every one tried; what could not be deleted is an error that names it. Gone already is fine. */
async function remove(paths: string[]): Promise<void> {
  const results = await Promise.allSettled(paths.map((p) => fs.rm(p, { recursive: true, force: true, maxRetries: 2 })));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${paths[i]} (${errorText(r.reason)})`] : []));
  if (failed.length) throw new Error(`could not delete ${failed.join(', ')}`);
}

/**
 * On server start (after a reboot, or in a new dev container, no displays run yet): bring back every leased
 * screen with its dressing, one at a time, so the bots' browsers answer before their first turn.
 */
export function initScreens() {
  const leases = db.prepare<[], Pick<ScreenRecord, 'bot_id' | 'user_id'>>('SELECT s.bot_id, s.user_id FROM screens s JOIN bots b ON b.id = s.bot_id ORDER BY s.screen_id').all();
  void (async () => {
    for (const l of leases) {
      await readyScreen(l.user_id, l.bot_id).catch((e) => console.warn(`[computer] screen for ${l.bot_id} did not come back: ${e?.message ?? e}`));
    }
  })();
}
