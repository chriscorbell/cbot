import fs from 'node:fs';
import { z } from 'zod';
import { getLive } from './agent/live.js';
import { cdpUrlFor, leasedScreens, restartChrome } from './computer.js';
import { errorText } from './lib/errors.js';
import { liveCallOf } from './voice.js';
import { watched } from './vnc.js';

/**
 * Each bot's Chrome on the version apt installed. Chrome opens whatever pages the bots visit, so its
 * security fixes matter, and scripts/provision.sh lets unattended-upgrades install them. But a Chrome
 * that is running keeps the version it started with, and a bot's Chrome runs for as long as the
 * machine does. So now and then the version dpkg installed is compared with the one each bot's Chrome
 * reports over DevTools, and a Chrome that is behind is started again once its bot is quiet: no turn
 * running, no call, and nobody looking at its screen. A bot that is busy is tried again at the next
 * check. Its sign-ins are in its profile and stay; its open tabs go, as when its look changes.
 */

const DPKG_STATUS = '/var/lib/dpkg/status';
const PACKAGE = 'google-chrome-stable';
const FIRST_CHECK_MS = 10 * 60_000;
const CHECK_EVERY_MS = 60 * 60_000;

/** The version of `pkg` in dpkg's status file, without its epoch or Debian revision (158.0.8127.36-1 is 158.0.8127.36), or null when it isn't installed. */
export function installedVersion(status: string, pkg = PACKAGE): string | null {
  for (const stanza of status.split(/\n\s*\n/)) {
    if (!stanza.split('\n').includes(`Package: ${pkg}`)) continue;
    if (!/^Status: install ok installed$/m.test(stanza)) return null;
    return /^Version: (?:\d+:)?([^\s-]+)/m.exec(stanza)?.[1] ?? null;
  }
  return null;
}

const DevToolsVersion = z.object({ Browser: z.string() });

/** The version in what a Chrome's DevTools answers at /json/version ("Chrome/158.0.8127.36"), or null. */
export function reportedVersion(body: unknown): string | null {
  const r = DevToolsVersion.safeParse(body);
  return r.success ? (/^(?:Headless)?Chrome\/(\S+)$/.exec(r.data.Browser)?.[1] ?? null) : null;
}

async function runningVersion(screenId: string): Promise<string | null> {
  try {
    const r = await fetch(`${cdpUrlFor(screenId)}/json/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? reportedVersion(await r.json() as unknown) : null;
  } catch {
    return null; // not running: it starts on the installed version anyway
  }
}

/** Whether restarting the bot's Chrome would interrupt anything: a turn, a call, or someone on its screen. */
const busy = (botId: string) => getLive(botId).isRunning || liveCallOf(botId) !== null || watched(botId);

/** One check of every bot's Chrome. */
export async function checkChromes(): Promise<void> {
  let installed: string | null;
  try {
    installed = installedVersion(fs.readFileSync(DPKG_STATUS, 'utf8'));
  } catch {
    return; // no dpkg here
  }
  if (!installed) return;
  for (const s of leasedScreens()) {
    const running = await runningVersion(s.screenId);
    if (!running || running === installed || busy(s.botId)) continue;
    console.log(`[chrome] ${s.botId} runs Chrome ${running} and ${installed} is installed; starting it again`);
    await restartChrome(s.userId, s.botId).catch((e) => console.warn(`[chrome] ${s.botId}: Chrome didn't start again: ${errorText(e)}`));
  }
}

/** From index.ts. */
export function initChromeUpdates(): void {
  const check = () => void checkChromes().catch((e) => console.warn(`[chrome] check failed: ${errorText(e)}`));
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
}
