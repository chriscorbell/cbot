import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { hub } from './lib/hub.js';
import { INSTALL_LOG, INSTALL_SOURCE, RELEASES_ROOT } from './machine.js';
import type { UpdateState } from './types.js';

/**
 * Updating cbot from GitHub: the sidebar's "Update available" and Settings > General > Updates.
 *
 * Only a machine the installer set up updates itself. It runs a release under /srv/cbot/releases,
 * named by its commit, and has /etc/cbot/source, where scripts/install.sh writes the repository and
 * branch it installed from. A host that scripts/deploy.sh looks after has no such file, and the dev
 * container runs no release, so neither checks or offers anything (updateState() is null).
 *
 * The update's states, one per machine and in memory:
 *   idle      A check asks GitHub for the branch's newest commit, a minute after starting, every six
 *             hours after that, and when Settings asks. `available` is that commit when it isn't the
 *             running one.
 *   updating  startUpdate runs the installer again, unattended, in a systemd unit of its own
 *             (cbot-update), so it outlives this process. The installer builds the new release beside
 *             this one, and its release.sh restarts the cbot service on it: this process ends there,
 *             and the new one starts idle. A page that saw `updating` reloads when the server it
 *             reconnects to names another commit (the `hello` event).
 *   failed    The unit failed while this process still runs, so this release goes on. Update tries
 *             again.
 * The installer takes a lock, so an update and someone running it in a terminal can't both build.
 */

const run = promisify(execFile);

/** The installer's unit while it runs. systemd keeps a failed one until reset-failed. */
const UNIT = 'cbot-update.service';
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** How often a running update is looked in on. */
const WATCH_MS = 2_000;
/** Under Settings' "The update didn’t finish". */
const FAILED = 'cbot stays on this version. On the machine, journalctl -u cbot-update says why.';

export interface Source { repo: string; ref: string }

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/** /etc/cbot/source, as the installer writes it (KEY=value lines). Null unless it names a repository and a branch. */
export function parseSource(text: string): Source | null {
  const v = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(CBOT_REPO|CBOT_REF)=(.*)$/.exec(line);
    if (m) v.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  const repo = v.get('CBOT_REPO') ?? '';
  const ref = v.get('CBOT_REF') ?? '';
  return REPO.test(repo) && REF.test(ref) && !ref.includes('..') ? { repo, ref } : null;
}

/** The commit a release directory is named for (twelve characters, as release.sh names them), or null for any other directory. */
export function releaseCommit(dir: string): string | null {
  const name = path.basename(dir);
  return path.dirname(dir) === RELEASES_ROOT && /^[0-9a-f]{12}$/.test(name) ? name : null;
}

let running: string | null | undefined;
/** The running release's commit. The service starts in /srv/cbot/current, the link to it, so the working directory is the release. */
export function runningCommit(): string | null {
  if (running === undefined) {
    try { running = releaseCommit(fs.realpathSync(process.cwd())); } catch { running = null; }
  }
  return running;
}

/**
 * What an update is doing, from the lines release.sh and provision.sh write to the installer's log
 * (the installer's `describe` words them for a terminal the same way). Null before the first.
 */
export function stepFrom(log: string): string | null {
  let step: string | null = null;
  for (const [, line] of log.matchAll(/^\[(?:release|provision)\] (.*)$/gm)) {
    if (line === 'provisioning the host') step = 'Setting up the machine';
    else if (line === 'packages') step = 'Installing packages';
    else if (line.startsWith('Hermes Agent ')) step = `Installing ${line}`;
    else if (line.startsWith('building cbot-speech')) step = 'Building the speech service, which takes about ten minutes';
    else if (line.startsWith('building ')) step = 'Building cbot';
  }
  return step;
}

// What GitHub answers for GET /repos/{repo}/commits/{ref}; only the commit's id is used.
const GitHubCommit = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });

/** The newest commit on the branch, as twelve characters. Throws a sentence to show. */
async function latestCommit({ repo, ref }: Source): Promise<string> {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'cbot' },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error('Couldn’t reach GitHub.'); });
  if (r.status === 404 || r.status === 422) throw new Error(`GitHub has no ${ref} in ${repo}.`);
  if (r.status === 403 || r.status === 429) throw new Error('GitHub is limiting requests for now. cbot asks again later.');
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  const body = GitHubCommit.safeParse(await r.json().catch(() => null));
  if (!body.success) throw new Error('GitHub’s answer didn’t name a commit.');
  return body.data.sha.slice(0, 12);
}

let source: Source | null = null;
let state: UpdateState | null = null;
let checking: Promise<UpdateState | null> | null = null;
let checkTimer: NodeJS.Timeout | undefined;
let watchTimer: NodeJS.Timeout | undefined;

/** Null when this cbot can't update itself (see the header). */
export function updateState(): UpdateState | null {
  return state;
}

function publish(next: UpdateState) {
  state = next;
  hub.emitAll({ type: 'update', update: next });
}

function nextCheck(ms: number) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => void checkForUpdate(), ms);
  checkTimer.unref();
}

/** From index.ts. The arguments are for tests. */
export function initUpdates(sourceFile = INSTALL_SOURCE, current = runningCommit()): void {
  let text = '';
  try { text = fs.readFileSync(sourceFile, 'utf8'); } catch { /* not installed by the installer */ }
  source = parseSource(text);
  if (!current || !source) {
    console.log('[updates] off: cbot was not installed by scripts/install.sh');
    return;
  }
  state = { current, available: null, checkedAt: null, status: 'idle', error: null };
  nextCheck(FIRST_CHECK_MS);
}

/** Asks GitHub now. Calls while one is out share its answer. */
export function checkForUpdate(): Promise<UpdateState | null> {
  const from = source;
  if (!state || !from) return Promise.resolve(state);
  checking ??= (async () => {
    let latest: string | null = null;
    let error: string | null = null;
    try { latest = await latestCommit(from); } catch (e) { error = (e as Error).message; }
    nextCheck(CHECK_EVERY_MS);
    const s = state!;
    // A failed check keeps what the last one found; an update that started meanwhile keeps its status.
    const available = latest === null ? s.available
      : latest === s.current ? null
      : { commit: latest, url: `https://github.com/${from.repo}/compare/${s.current}...${latest}` };
    const checkedAt = latest === null ? s.checkedAt : Date.now();
    publish(s.status === 'idle' ? { ...s, available, checkedAt, error } : { ...s, available, checkedAt });
    return state;
  })().finally(() => { checking = null; });
  return checking;
}

/**
 * Runs the installer again (see the header). Answers why it won't, or null once it runs. The checks
 * and the switch to `updating` come before the first await, so two clicks start one update.
 */
export async function startUpdate(): Promise<string | null> {
  const s = state;
  const from = source;
  if (!s || !from) return 'This cbot can’t update itself. Run the installer again on its machine.';
  if (s.status === 'updating') return null;
  if (!s.available) return 'cbot is up to date.';
  const startedAt = Date.now();
  publish({ current: s.current, available: s.available, checkedAt: s.checkedAt, status: 'updating', step: null, startedAt });
  try {
    await run('systemctl', ['reset-failed', UNIT]).catch(() => { /* none failed before */ });
    // The repository and branch go in as the unit's environment, never into the command line itself.
    await run('systemd-run', [
      `--unit=${UNIT}`, '--description=cbot update', '--setenv=HOME=/root', '--setenv=LANG=C.UTF-8', '--setenv=CBOT_YES=1',
      `--setenv=CBOT_REPO=${from.repo}`, `--setenv=CBOT_REF=${from.ref}`,
      '/bin/bash', '-c', 'set -o pipefail; curl -fsSL "https://raw.githubusercontent.com/$CBOT_REPO/$CBOT_REF/scripts/install.sh" | bash',
    ]);
  } catch (e: any) {
    console.error('[updates] could not start the installer:', e?.stderr || e?.message || e);
    publish({ current: s.current, available: s.available, checkedAt: s.checkedAt, status: 'failed', error: `It couldn’t start: ${String(e?.stderr || e?.message || e).trim().split('\n')[0]}` });
    return null;
  }
  console.log(`[updates] updating from ${s.current} to ${s.available.commit} (${from.repo} ${from.ref})`);
  watch(startedAt);
  return null;
}

function watch(startedAt: number) {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    lookIn(startedAt).catch((e) => { console.warn('[updates] watch:', e?.message ?? e); watch(startedAt); });
  }, WATCH_MS);
}

/** systemctl is-active exits non-zero for anything but active, with the state still on stdout. */
const unitState = () => run('systemctl', ['is-active', UNIT]).then((r) => r.stdout.trim(), (e: any) => String(e?.stdout ?? '').trim() || 'inactive');

/** The installer's step, from its log once it has started this run's (it empties the log when it starts). */
function currentStep(startedAt: number): string | null {
  try {
    if (fs.statSync(INSTALL_LOG).mtimeMs < startedAt) return null;
    return stepFrom(fs.readFileSync(INSTALL_LOG, 'utf8'));
  } catch {
    return null;
  }
}

async function lookIn(startedAt: number) {
  const unit = await unitState();
  const s = state;
  if (s?.status !== 'updating' || s.startedAt !== startedAt) return;
  const base = { current: s.current, available: s.available, checkedAt: s.checkedAt };
  if (unit === 'failed') {
    console.warn('[updates] the installer failed');
    publish({ ...base, status: 'failed', error: FAILED });
  } else if (unit === 'inactive') {
    // Finished, and this process still runs: the installer found this commit was the newest after all.
    publish({ ...base, status: 'idle', error: null });
    void checkForUpdate();
  } else {
    const step = currentStep(startedAt);
    if (step !== s.step) publish({ ...s, step });
    watch(startedAt);
  }
}
