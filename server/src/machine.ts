/**
 * The computer the bots share (the machine Dispatch runs on): where things live on it, and how a bot's
 * screen maps to an X display and ports. Code that needs one of these imports it from here.
 *
 * The box scripts (server/box/*.py) run on the same machine and keep their own copies in
 * dispatchlib.py (PROFILES, LIBRARY, cdp_port, display_number); test/machine.test.ts checks they agree.
 * scripts/provision.sh creates BOTS_ROOT, BOX_ROOT and HERMES_ROOT.
 */

/** The bots' own files: Chrome profiles and Libraries. */
export const BOTS_ROOT = '/root/dispatch';
/** Each bot's Library: files it saves for the user, and uploads. */
export const LIBRARY_ROOT = `${BOTS_ROOT}/files`;
/** Each bot's Chrome profile (its sign-ins). */
export const PROFILES_ROOT = `${BOTS_ROOT}/profiles`;
export const libraryDir = (botId: string) => `${LIBRARY_ROOT}/${botId}`;
export const profileDir = (botId: string) => `${PROFILES_ROOT}/${botId}`;

/** Where desk.ts installs the box scripts. */
export const BOX_ROOT = '/opt/dispatch';
/** The Hermes install every bot's home links to (scripts/provision.sh). */
export const HERMES_ROOT = '/opt/hermes';
/** The first bot's Hermes API port; each bot takes the next free one (engine.ts). */
export const ENGINE_PORT_BASE = 8650;

/**
 * A screen id names a display: 'default' is :99 (the primary bot's), 'screen-<n>' is :<n> (every
 * other bot gets the lowest free one from :100 up, see computer.ts).
 */
export const displayFor = (screenId?: string | null) => (!screenId || screenId === 'default' ? ':99' : `:${screenId.replace('screen-', '')}`);
export const displayNumber = (screenId: string) => Number(displayFor(screenId).slice(1));

/** DevTools port of the Chrome we run on a screen: 9200 + display number (default screen → 9299). */
export const cdpPortFor = (screenId: string) => 9200 + displayNumber(screenId);
/** Xvnc's VNC port for display :n. It listens on 127.0.0.1 only, and only the relay in vnc.ts connects. */
export const vncPortFor = (n: number) => 5900 + n;

/** Where scripts/install.sh and scripts/deploy.sh unpack each release, named by its commit; /srv/dispatch/current points at the running one. */
export const RELEASES_ROOT = '/srv/dispatch/releases';
/** The repository and branch scripts/install.sh installed from, which updates.ts checks for a newer commit. */
export const INSTALL_SOURCE = '/etc/dispatch/source';
/** What release.sh writes when an update didn't start and it went back to the release before; updates.ts reads it once at startup. */
export const UPDATE_RESULT = '/etc/dispatch/last-update';
/** The installer's log: release.sh and provision.sh name each step there. */
export const INSTALL_LOG = '/var/log/dispatch/install.log';
