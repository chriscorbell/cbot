import fs from 'node:fs';
import { z } from 'zod';

/**
 * The computer the bots share (the machine Dispatch runs on): where things live on it, and how a bot's
 * screen maps to an X display and ports. Code that needs one of these imports it from here.
 *
 * The values the box scripts need too are in server/box/machine.json, which this file and
 * server/box/dispatchlib.py both read, so the two can't drift apart. desk.ts installs it beside the
 * scripts. scripts/provision.sh creates BOTS_ROOT, BOX_ROOT and HERMES_ROOT.
 */

const Machine = z.object({
  botsRoot: z.string(),
  boxRoot: z.string(),
  hermesRoot: z.string(),
  logs: z.string(),
  run: z.string(),
  homePort: z.number().int(),
  enginePortBase: z.number().int(),
  cdpPortBase: z.number().int(),
  vncPortBase: z.number().int(),
  primaryDisplay: z.number().int(),
  firstBotDisplay: z.number().int(),
});
/** server/box/ sits next to both src/ (tsx, vitest) and dist/ (after tsc), as desk.ts relies on too. */
export const MACHINE_FILE = new URL('../box/machine.json', import.meta.url);
const machine = Machine.parse(JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8')));

/** The bots' own files: Chrome profiles and Libraries. */
export const BOTS_ROOT = machine.botsRoot;
/** Each bot's Library: files it saves for the user, and uploads. */
export const LIBRARY_ROOT = `${BOTS_ROOT}/files`;
/** Each bot's Chrome profile (its sign-ins). */
export const PROFILES_ROOT = `${BOTS_ROOT}/profiles`;
export const libraryDir = (botId: string) => `${LIBRARY_ROOT}/${botId}`;
export const profileDir = (botId: string) => `${PROFILES_ROOT}/${botId}`;

/** Where desk.ts installs the box scripts. */
export const BOX_ROOT = machine.boxRoot;
/** The Hermes install every bot's home links to (scripts/provision.sh). */
export const HERMES_ROOT = machine.hermesRoot;
/** The logs of what the box scripts start on the screens (apps, terminals, the desk's jobs); the systemd units log to the journal. */
export const LOGS_ROOT = machine.logs;
/**
 * What the systemd units read when they start (each display's and each gateway's environment file) and
 * each display's session bus. On tmpfs: the server writes it again before it starts a unit. The unit
 * files in deploy/ name the same folder.
 */
export const RUN_ROOT = machine.run;
/** The first bot's Hermes API port; each bot takes the next free one (engine.ts). */
export const ENGINE_PORT_BASE = machine.enginePortBase;
/** The home screen server on the computer (server/box/dispatch-home.py), which every bot's new tab frames. */
export const HOME_PORT = machine.homePort;
/** The primary bot's display ('default'). */
export const PRIMARY_DISPLAY = machine.primaryDisplay;
/** Every other bot gets the lowest free display from this one up (computer.ts). */
export const FIRST_BOT_DISPLAY = machine.firstBotDisplay;

/**
 * A screen id names a display: 'default' is the primary bot's (:99), 'screen-<n>' is :<n> (every
 * other bot gets the lowest free one from FIRST_BOT_DISPLAY up, see computer.ts).
 */
export const displayFor = (screenId?: string | null) => (!screenId || screenId === 'default' ? `:${PRIMARY_DISPLAY}` : `:${screenId.replace('screen-', '')}`);
export const displayNumber = (screenId: string) => Number(displayFor(screenId).slice(1));

/** DevTools port of the Chrome we run on a screen: the base + display number (default screen → 9299). */
export const cdpPortFor = (screenId: string) => machine.cdpPortBase + displayNumber(screenId);
/** Xvnc's VNC port for display :n. It listens on 127.0.0.1 only, and only the relay in vnc.ts connects. */
export const vncPortFor = (n: number) => machine.vncPortBase + n;

/** Where scripts/install.sh and scripts/deploy.sh unpack each release, named by its commit; /srv/dispatch/current points at the running one. */
export const RELEASES_ROOT = '/srv/dispatch/releases';
/** The repository and branch scripts/install.sh installed from, which updates.ts checks for a newer commit. */
export const INSTALL_SOURCE = '/etc/dispatch/source';
/** What release.sh writes when an update didn't start and it went back to the release before; updates.ts reads it once at startup. */
export const UPDATE_RESULT = '/etc/dispatch/last-update';
/** The installer's log: release.sh and provision.sh name each step there. */
export const INSTALL_LOG = '/var/log/dispatch/install.log';
