import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { ServerEvent, UpdateState } from '../src/types.js';

// systemctl and systemd-run, answered here: `unit` is what `systemctl is-active cbot-update` says.
const sys = vi.hoisted(() => ({ calls: [] as string[][], unit: 'active', fail: null as string | null }));
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], cb: (e: unknown, r?: { stdout: string; stderr: string }) => void) => {
    sys.calls.push([cmd, ...args]);
    if (cmd === 'systemd-run' && sys.fail) return cb(Object.assign(new Error('failed'), { stderr: sys.fail }));
    if (args[0] === 'is-active' && sys.unit !== 'active') return cb(Object.assign(new Error('exit 3'), { stdout: `${sys.unit}\n` }));
    cb(null, { stdout: args[0] === 'is-active' ? 'active\n' : '', stderr: '' });
  },
}));

const { checkForUpdate, initUpdates, parseSource, releaseCommit, startUpdate, stepFrom, updateState } = await import('../src/updates.js');
const { hub } = await import('../src/lib/hub.js');

const RUNNING = '7fb35aa1c2d3';
const NEWER = 'a1b2c3d4e5f6';
const events: UpdateState[] = [];
hub.subscribe('usr_any', (ev: ServerEvent) => { if (ev.type === 'update') events.push(ev.update); });

/** GitHub's answer for the branch's newest commit, and how many times it was asked. */
let github: () => Response;
const fetches = vi.fn(async (_url: string) => github());
const commitAnswer = (short: string) => () => Response.json({ sha: `${short}${'0'.repeat(28)}`, commit: { message: 'x' } });

beforeAll(() => {
  vi.stubGlobal('fetch', fetches);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbot-source-')), 'source');
  fs.writeFileSync(file, '# Where scripts/install.sh installed cbot from.\nCBOT_REPO=chriscorbell/cbot\nCBOT_REF=main\n');
  initUpdates(file, RUNNING);
});
afterEach(() => { vi.useRealTimers(); fetches.mockClear(); sys.calls = []; });

test('the source names a repository and a branch, and nothing that could reach a shell', () => {
  expect(parseSource('CBOT_REPO=chriscorbell/cbot\nCBOT_REF=main\n')).toEqual({ repo: 'chriscorbell/cbot', ref: 'main' });
  expect(parseSource('CBOT_REPO="me/cbot-fork"\nCBOT_REF=feature/voice\n')).toEqual({ repo: 'me/cbot-fork', ref: 'feature/voice' });
  expect(parseSource('CBOT_REPO=chriscorbell/cbot\n')).toBeNull();
  expect(parseSource('')).toBeNull();
  expect(parseSource('CBOT_REPO=a/b;reboot\nCBOT_REF=main\n')).toBeNull();
  expect(parseSource('CBOT_REPO=a/b\nCBOT_REF=$(reboot)\n')).toBeNull();
  expect(parseSource('CBOT_REPO=a/b\nCBOT_REF=../../x\n')).toBeNull();
});

test('only a release directory names a commit', () => {
  expect(releaseCommit(`/srv/cbot/releases/${RUNNING}`)).toBe(RUNNING);
  expect(releaseCommit(`/srv/cbot/releases/${RUNNING}.new`)).toBeNull();
  expect(releaseCommit('/app')).toBeNull();
  expect(releaseCommit(`/elsewhere/${RUNNING}`)).toBeNull();
});

test("the installer's log says what the update is doing", () => {
  expect(stepFrom('')).toBeNull();
  expect(stepFrom('[release] provisioning the host\n[provision] packages\n')).toBe('Installing packages');
  expect(stepFrom('[provision] Hermes Agent 0.9.1\n[provision] done\n')).toBe('Installing Hermes Agent 0.9.1');
  expect(stepFrom(`[release] building ${NEWER}\nadded 306 packages\n`)).toBe('Building cbot');
  expect(stepFrom(`[release] building ${NEWER}\n[release] building cbot-speech:0123456789ab (the first build takes about ten minutes)\n`))
    .toBe('Building the speech service, which takes about ten minutes');
});

test('a check finds a newer commit on the branch, and none when GitHub names the running one', async () => {
  expect(updateState()).toMatchObject({ current: RUNNING, available: null, checkedAt: null, status: 'idle' });
  github = commitAnswer(RUNNING);
  expect(await checkForUpdate()).toMatchObject({ available: null, error: null });
  expect(fetches.mock.calls[0][0]).toBe('https://api.github.com/repos/chriscorbell/cbot/commits/main');

  github = commitAnswer(NEWER);
  const [a, b] = await Promise.all([checkForUpdate(), checkForUpdate()]);
  expect(fetches).toHaveBeenCalledTimes(2);
  expect(a).toBe(b);
  expect(a).toMatchObject({ status: 'idle', error: null, available: { commit: NEWER, url: `https://github.com/chriscorbell/cbot/compare/${RUNNING}...${NEWER}` } });
  expect(events.at(-1)).toEqual(a);
});

test('a check GitHub refuses says why and keeps the update it found before', async () => {
  github = () => new Response('{}', { status: 403 });
  expect(await checkForUpdate()).toMatchObject({ available: { commit: NEWER }, error: 'GitHub is limiting requests for now. cbot asks again later.' });
  github = () => Response.json({ message: 'Not Found' }, { status: 404 });
  expect(await checkForUpdate()).toMatchObject({ available: { commit: NEWER }, error: 'GitHub has no main in chriscorbell/cbot.' });
});

test('Update runs the installer in a unit of its own once, and a failed run leaves this release running', async () => {
  vi.useFakeTimers();
  sys.unit = 'active';
  const [first, second] = await Promise.all([startUpdate(), startUpdate()]);
  expect([first, second]).toEqual([null, null]);
  const runs = sys.calls.filter((c) => c[0] === 'systemd-run');
  expect(runs).toHaveLength(1);
  // The repository and branch reach the installer as its environment, never inside the script.
  expect(runs[0]).toContain('--setenv=CBOT_REPO=chriscorbell/cbot');
  expect(runs[0]).toContain('--setenv=CBOT_REF=main');
  expect(runs[0]).toContain('--setenv=CBOT_YES=1');
  expect(runs[0].at(-1)).toBe('set -o pipefail; curl -fsSL "https://raw.githubusercontent.com/$CBOT_REPO/$CBOT_REF/scripts/install.sh" | bash');
  expect(updateState()).toMatchObject({ status: 'updating', step: null });

  await vi.advanceTimersByTimeAsync(2_000);
  expect(updateState()?.status).toBe('updating');
  sys.unit = 'failed';
  await vi.advanceTimersByTimeAsync(2_000);
  expect(updateState()).toMatchObject({ status: 'failed', current: RUNNING, available: { commit: NEWER } });
  expect(events.at(-1)?.status).toBe('failed');
});

test('an update that cannot start says so, and one that finds nothing newer goes back to idle', async () => {
  vi.useFakeTimers();
  sys.fail = 'Failed to start transient service unit: Unit cbot-update.service was already loaded or has a fragment file.';
  await startUpdate();
  expect(updateState()).toMatchObject({ status: 'failed', error: `It couldn’t start: ${sys.fail}` });

  sys.fail = null;
  sys.unit = 'active';
  github = commitAnswer(RUNNING);
  await startUpdate();
  sys.unit = 'inactive';
  await vi.advanceTimersByTimeAsync(2_000);
  expect(updateState()).toMatchObject({ status: 'idle', available: null });
  expect(await startUpdate()).toBe('cbot is up to date.');
});
