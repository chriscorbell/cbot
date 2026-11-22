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

const { checkForUpdate, initUpdates, laterRelease, parseSource, releaseCommit, releaseVersion, startUpdate, stepFrom, updateState } = await import('../src/updates.js');
const { hub } = await import('../src/lib/hub.js');

const RUNNING = '7fb35aa1c2d3';
const NEWER = 'a1b2c3d4e5f6';
const events: UpdateState[] = [];
hub.subscribe('usr_any', (ev: ServerEvent) => { if (ev.type === 'update') events.push(ev.update); });

/** GitHub's answer, and how many times it was asked. */
let github: () => Response;
const fetches = vi.fn(async (_url: string) => github());
const commitAnswer = (short: string) => () => Response.json({ sha: `${short}${'0'.repeat(28)}`, commit: { message: 'x' } });
/** GitHub's list of releases: each tag published with its signed checksums, unless `draft` or `unsigned` names it. */
const releasesAnswer = (tags: string[], { draft = [] as string[], unsigned = [] as string[] } = {}) => () => Response.json(tags.map((t) => ({
  tag_name: t, draft: draft.includes(t), prerelease: false,
  assets: unsigned.includes(t) ? [] : [{ name: `dispatch-${t}-linux-amd64.tar.gz` }, { name: 'SHA256SUMS' }, { name: 'SHA256SUMS.sig' }],
})));
const tagsAnswer = (...tags: string[]) => releasesAnswer(tags);

/**
 * Starts over as a machine the installer set up from `source`, running RUNNING, which is `release`
 * when it is a signed release. `lastUpdate` is what release.sh left in /etc/dispatch/last-update.
 */
function installedFrom(source: string, release: string | null = null, lastUpdate?: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-source-'));
  const file = path.join(dir, 'source');
  fs.writeFileSync(file, `# Where scripts/install.sh installed Dispatch from.\n${source}`);
  const result = path.join(dir, 'last-update');
  if (lastUpdate) fs.writeFileSync(result, JSON.stringify(lastUpdate));
  initUpdates(file, RUNNING, release, result);
  return result;
}

beforeAll(() => {
  vi.stubGlobal('fetch', fetches);
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=main\n');
});
afterEach(() => { vi.useRealTimers(); fetches.mockClear(); sys.calls = []; });

test('the source names a repository and maybe a branch, and nothing that could reach a shell', () => {
  expect(parseSource('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\n')).toEqual({ repo: 'chriscorbell/dispatch', ref: null });
  expect(parseSource('DISPATCH_REPO=chriscorbell/dispatch\n')).toEqual({ repo: 'chriscorbell/dispatch', ref: null });
  expect(parseSource('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=main\n')).toEqual({ repo: 'chriscorbell/dispatch', ref: 'main' });
  expect(parseSource('DISPATCH_REPO="me/dispatch-fork"\nDISPATCH_REF=feature/voice\n')).toEqual({ repo: 'me/dispatch-fork', ref: 'feature/voice' });
  expect(parseSource('')).toBeNull();
  expect(parseSource('DISPATCH_REPO=a/b;reboot\nDISPATCH_REF=main\n')).toBeNull();
  expect(parseSource('DISPATCH_REPO=a/b\nDISPATCH_REF=$(reboot)\n')).toBeNull();
  expect(parseSource('DISPATCH_REPO=a/b\nDISPATCH_REF=../../x\n')).toBeNull();
});

test('a release says its version in its own VERSION file, and nothing else counts as one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-release-'));
  expect(releaseVersion(dir)).toBeNull();
  fs.writeFileSync(path.join(dir, 'VERSION'), 'v0.10.2\n');
  expect(releaseVersion(dir)).toBe('v0.10.2');
  fs.writeFileSync(path.join(dir, 'VERSION'), 'v1.0.0-rc1\n');
  expect(releaseVersion(dir)).toBeNull();
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
  // A release comes built, with its speech image pulled by digest.
  expect(stepFrom('[release] pulling the speech service\n')).toBe('Downloading the speech service');
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
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\n', 'v0.9.0');
  expect(updateState()).toMatchObject({ current: 'v0.9.0', available: null, status: 'idle' });

  github = tagsAnswer('v0.8.0', 'v0.9.0', 'v1.0.0-rc1', 'vnext');
  expect(await checkForUpdate()).toMatchObject({ available: null, error: null });
  expect(fetches.mock.calls[0][0]).toBe('https://api.github.com/repos/chriscorbell/dispatch/releases?per_page=30');

  github = tagsAnswer('v0.9.0', 'v0.10.0', 'v0.9.5');
  expect(await checkForUpdate()).toMatchObject({
    error: null, available: { version: 'v0.10.0', url: 'https://github.com/chriscorbell/dispatch/releases/tag/v0.10.0' },
  });
  // The newest release going away (or back a version) offers nothing.
  github = tagsAnswer('v0.8.0');
  expect(await checkForUpdate()).toMatchObject({ available: null, error: null });
  github = tagsAnswer();
  expect(await checkForUpdate()).toMatchObject({ available: null, error: 'chriscorbell/dispatch has no published release yet.' });
});

test('a release still being built, or with no signed checksums, is not offered', async () => {
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\n', 'v0.9.0');
  // publish.sh pushed v0.11.0 and GitHub Actions is building it: a draft, which the installer can't download.
  github = releasesAnswer(['v0.11.0', 'v0.10.0', 'v0.9.0'], { draft: ['v0.11.0'] });
  expect(await checkForUpdate()).toMatchObject({ error: null, available: { version: 'v0.10.0' } });
  github = releasesAnswer(['v0.12.0', 'v0.9.0'], { unsigned: ['v0.12.0'] });
  expect(await checkForUpdate()).toMatchObject({ available: null, error: null });
  // Marked a prerelease on GitHub, which the installer can't see: offered, since it would install it.
  github = () => Response.json([{ tag_name: 'v0.13.0', draft: false, prerelease: true, assets: [{ name: 'SHA256SUMS.sig' }] }]);
  expect(await checkForUpdate()).toMatchObject({ error: null, available: { version: 'v0.13.0' } });
});

test('updating to a release runs the installer with no branch, so it installs the newest signed one', async () => {
  vi.useFakeTimers();
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\n', 'v0.9.0');
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

test('a release with no VERSION on a machine that follows the releases offers nothing', () => {
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\n');
  expect(updateState()).toBeNull();
});

test('an update that release.sh rolled back shows as failed once, on the release it went back to', async () => {
  vi.useFakeTimers();
  github = tagsAnswer('v0.10.0');
  const lastUpdate = { result: 'rolled-back', from: RUNNING, to: NEWER, version: 'v0.10.0', at: '2026-11-21T12:00:00Z' };
  const file = installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\n', 'v0.9.0', lastUpdate);
  expect(updateState()).toMatchObject({
    current: 'v0.9.0', status: 'failed',
    error: 'v0.10.0 didn’t start, so Dispatch went back to this version. On the machine, journalctl -u dispatch-update says why.',
  });
  expect(fs.existsSync(file)).toBe(false);
  // It asks GitHub straight away, so Try Again has the release to try.
  await vi.advanceTimersByTimeAsync(0);
  expect(updateState()).toMatchObject({ status: 'failed', available: { version: 'v0.10.0' } });

  // A notice about another release (an older rollback) is dropped.
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=\n', 'v0.9.0', { ...lastUpdate, from: NEWER });
  expect(updateState()).toMatchObject({ status: 'idle', error: null });
  // On a branch the notice names the commit.
  installedFrom('DISPATCH_REPO=chriscorbell/dispatch\nDISPATCH_REF=main\n', null, { ...lastUpdate, version: '' });
  expect(updateState()).toMatchObject({ current: RUNNING.slice(0, 7), status: 'failed', error: expect.stringMatching(/^a1b2c3d didn’t start/) });
});
