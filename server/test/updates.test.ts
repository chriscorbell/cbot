import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { ServerEvent, UpdateState } from '../src/types.js';

// systemctl and systemd-run, answered here: `unit` is what `systemctl is-active dispatch-update` says.
const sys = vi.hoisted(() => ({ calls: [] as string[][], unit: 'active', fail: null as string | null }));
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], cb: (e: unknown, r?: { stdout: string; stderr: string }) => void) => {
    sys.calls.push([cmd, ...args]);
    if (cmd === 'systemd-run' && sys.fail) return cb(Object.assign(new Error('failed'), { stderr: sys.fail }));
    if (args[0] === 'is-active' && sys.unit !== 'active') return cb(Object.assign(new Error('exit 3'), { stdout: `${sys.unit}\n` }));
    cb(null, { stdout: args[0] === 'is-active' ? 'active\n' : '', stderr: '' });
  },
}));

const { checkForUpdate, initUpdates, laterRelease, parseSource, releaseCommit, startUpdate, stepFrom, updateState } = await import('../src/updates.js');
const { hub } = await import('../src/lib/hub.js');

const RUNNING = '7fb35aa1c2d3';
const NEWER = 'a1b2c3d4e5f6';
const events: UpdateState[] = [];
hub.subscribe('usr_any', (ev: ServerEvent) => { if (ev.type === 'update') events.push(ev.update); });

/** GitHub's answer, and how many times it was asked. */
let github: () => Response;
const fetches = vi.fn(async (_url: string) => github());
const commitAnswer = (short: string) => () => Response.json({ sha: `${short}${'0'.repeat(28)}`, commit: { message: 'x' } });
const tagsAnswer = (...tags: string[]) => () => Response.json(tags.map((t) => ({ ref: `refs/tags/${t}`, object: { sha: '0'.repeat(40), type: 'tag' } })));

/** Starts over as a machine the installer set up from `source`, running RUNNING. */
function installedFrom(source: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-source-')), 'source');
  fs.writeFileSync(file, `# Where scripts/install.sh installed Dispatch from.\n${source}`);
  initUpdates(file, RUNNING);
}

beforeAll(() => {
  vi.stubGlobal('fetch', fetches);
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=main\nDISPATCH_VERSION=\n');
});
afterEach(() => { vi.useRealTimers(); fetches.mockClear(); sys.calls = []; });

test('the source names a repository and a release or a branch, and nothing that could reach a shell', () => {
  expect(parseSource('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\nDISPATCH_VERSION=v0.10.2\n'))
    .toEqual({ repo: 'chriscorbell/dispatch', ref: null, version: 'v0.10.2' });
  expect(parseSource('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=main\n')).toEqual({ repo: 'chriscorbell/dispatch', ref: 'main', version: null });
  expect(parseSource('DISPATCH_REPO="me/dispatch-fork"\nDISPATCH_REF=feature/voice\nDISPATCH_VERSION=\n')).toEqual({ repo: 'me/dispatch-fork', ref: 'feature/voice', version: null });
  expect(parseSource('DISPATCH_REPO=chriscorbell/dispatch\n')).toBeNull();
  expect(parseSource('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_VERSION=v1.0.0-rc1\n')).toBeNull();
  expect(parseSource('')).toBeNull();
  expect(parseSource('DISPATCH_REPO=a/b;reboot\nDISPATCH_REF=main\n')).toBeNull();
  expect(parseSource('DISPATCH_REPO=a/b\nDISPATCH_REF=$(reboot)\n')).toBeNull();
  expect(parseSource('DISPATCH_REPO=a/b\nDISPATCH_REF=../../x\n')).toBeNull();
  expect(parseSource('DISPATCH_REPO=a/b\nDISPATCH_VERSION=v1.0.0;reboot\n')).toBeNull();
});

test('releases go by number', () => {
  expect(laterRelease('v0.10.0', 'v0.9.0')).toBe(true);
  expect(laterRelease('v0.9.0', 'v0.10.0')).toBe(false);
  expect(laterRelease('v1.0.0', 'v0.99.99')).toBe(true);
  expect(laterRelease('v1.2.3', 'v1.2.3')).toBe(false);
});

test('only a release directory names a commit', () => {
  expect(releaseCommit(`/srv/dispatch/releases/${RUNNING}`)).toBe(RUNNING);
  expect(releaseCommit(`/srv/dispatch/releases/${RUNNING}.new`)).toBeNull();
  expect(releaseCommit('/app')).toBeNull();
  expect(releaseCommit(`/elsewhere/${RUNNING}`)).toBeNull();
});

test("the installer's log says what the update is doing", () => {
  expect(stepFrom('')).toBeNull();
  expect(stepFrom('[release] provisioning the host\n[provision] packages\n')).toBe('Installing packages');
  expect(stepFrom('[provision] Hermes Agent 0.9.1\n[provision] done\n')).toBe('Installing Hermes Agent 0.9.1');
  expect(stepFrom(`[release] building ${NEWER}\nadded 306 packages\n`)).toBe('Building Dispatch');
  expect(stepFrom(`[release] building ${NEWER}\n[release] building dispatch-speech:0123456789ab (the first build takes about ten minutes)\n`))
    .toBe('Building the speech service, which takes about ten minutes');
  expect(stepFrom(`[release] building ${NEWER}\n[release] starting ${NEWER}\n`)).toBe('Starting Dispatch');
});

test('a check finds a newer commit on the branch, and none when GitHub names the running one', async () => {
  expect(updateState()).toMatchObject({ current: RUNNING.slice(0, 7), available: null, checkedAt: null, status: 'idle' });
  github = commitAnswer(RUNNING);
  expect(await checkForUpdate()).toMatchObject({ available: null, error: null });
  expect(fetches.mock.calls[0][0]).toBe('https://api.github.com/repos/chriscorbell/dispatch/commits/main');

  github = commitAnswer(NEWER);
  const [a, b] = await Promise.all([checkForUpdate(), checkForUpdate()]);
  expect(fetches).toHaveBeenCalledTimes(2);
  expect(a).toBe(b);
  expect(a).toMatchObject({ status: 'idle', error: null, available: { version: NEWER.slice(0, 7), url: `https://github.com/chriscorbell/dispatch/compare/${RUNNING}...${NEWER}` } });
  expect(events.at(-1)).toEqual(a);
});

test('a check GitHub refuses says why and keeps the update it found before', async () => {
  github = () => new Response('{}', { status: 403 });
  expect(await checkForUpdate()).toMatchObject({ available: { version: NEWER.slice(0, 7) }, error: 'GitHub is limiting requests for now. Dispatch asks again later.' });
  github = () => Response.json({ message: 'Not Found' }, { status: 404 });
  expect(await checkForUpdate()).toMatchObject({ available: { version: NEWER.slice(0, 7) }, error: 'GitHub has no main in chriscorbell/dispatch.' });
});

test('Update runs this release\'s installer in a unit of its own once, and a failed run leaves this release running', async () => {
  vi.useFakeTimers();
  sys.unit = 'active';
  const [first, second] = await Promise.all([startUpdate(), startUpdate()]);
  expect([first, second]).toEqual([null, null]);
  const runs = sys.calls.filter((c) => c[0] === 'systemd-run');
  expect(runs).toHaveLength(1);
  // The repository and branch reach the installer as its environment. Nothing from GitHub runs as it starts.
  expect(runs[0]).toContain('--setenv=DISPATCH_REPO=chriscorbell/dispatch');
  expect(runs[0]).toContain('--setenv=DISPATCH_REF=main');
  expect(runs[0]).toContain('--setenv=DISPATCH_YES=1');
  expect(runs[0].slice(-2)).toEqual(['/bin/bash', `/srv/dispatch/releases/${RUNNING}/scripts/install.sh`]);
  expect(updateState()).toMatchObject({ status: 'updating', step: null });

  await vi.advanceTimersByTimeAsync(2_000);
  expect(updateState()?.status).toBe('updating');
  sys.unit = 'failed';
  await vi.advanceTimersByTimeAsync(2_000);
  expect(updateState()).toMatchObject({ status: 'failed', current: RUNNING.slice(0, 7), available: { version: NEWER.slice(0, 7) } });
  expect(events.at(-1)?.status).toBe('failed');
});

test('an update that cannot start says so, and one that finds nothing newer goes back to idle', async () => {
  vi.useFakeTimers();
  sys.fail = 'Failed to start transient service unit: Unit dispatch-update.service was already loaded or has a fragment file.';
  await startUpdate();
  expect(updateState()).toMatchObject({ status: 'failed', error: `It couldn’t start: ${sys.fail}` });

  sys.fail = null;
  sys.unit = 'active';
  github = commitAnswer(RUNNING);
  await startUpdate();
  sys.unit = 'inactive';
  await vi.advanceTimersByTimeAsync(2_000);
  expect(updateState()).toMatchObject({ status: 'idle', available: null });
  expect(await startUpdate()).toBe('Dispatch is up to date.');
});

test('a machine on the releases is offered a later release, by number, and only a release', async () => {
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\nDISPATCH_VERSION=v0.9.0\n');
  expect(updateState()).toMatchObject({ current: 'v0.9.0', available: null, status: 'idle' });

  github = tagsAnswer('v0.8.0', 'v0.9.0', 'v1.0.0-rc1', 'vnext');
  expect(await checkForUpdate()).toMatchObject({ available: null, error: null });
  expect(fetches.mock.calls[0][0]).toBe('https://api.github.com/repos/chriscorbell/dispatch/git/matching-refs/tags/v');

  github = tagsAnswer('v0.9.0', 'v0.10.0', 'v0.9.5');
  expect(await checkForUpdate()).toMatchObject({
    error: null, available: { version: 'v0.10.0', url: 'https://github.com/chriscorbell/dispatch/releases/tag/v0.10.0' },
  });
  // The newest release going away (or back a version) offers nothing.
  github = tagsAnswer('v0.8.0');
  expect(await checkForUpdate()).toMatchObject({ available: null, error: null });
  github = tagsAnswer();
  expect(await checkForUpdate()).toMatchObject({ available: null, error: 'chriscorbell/dispatch has no release yet.' });
});

test('updating to a release runs the installer with no branch, so it installs the newest signed one', async () => {
  vi.useFakeTimers();
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\nDISPATCH_VERSION=v0.9.0\n');
  github = tagsAnswer('v0.10.0');
  await checkForUpdate();
  sys.unit = 'active';
  expect(await startUpdate()).toBeNull();
  const run = sys.calls.find((c) => c[0] === 'systemd-run')!;
  expect(run).toContain('--setenv=DISPATCH_REPO=chriscorbell/dispatch');
  expect(run.some((a) => a.startsWith('--setenv=DISPATCH_REF'))).toBe(false);
  expect(run.slice(-2)).toEqual(['/bin/bash', `/srv/dispatch/releases/${RUNNING}/scripts/install.sh`]);
  expect(updateState()).toMatchObject({ status: 'updating', current: 'v0.9.0', available: { version: 'v0.10.0' } });
});
