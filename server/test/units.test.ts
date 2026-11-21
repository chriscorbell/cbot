// How the server asks systemd to run a bot's units (units.ts), with systemctl answered here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

// systemctl's answers: `states` is what is-active says per unit; `fail` makes a verb exit 1.
const sys = vi.hoisted(() => ({ calls: [] as string[][], states: {} as Record<string, string>, fail: {} as Record<string, string> }));
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, out?: string, err?: string) => void) => {
    sys.calls.push([cmd, ...args]);
    if (sys.fail[args[0]]) return cb(Object.assign(new Error('failed'), { code: 1 }), '', sys.fail[args[0]]);
    if (args[0] === 'is-active') {
      const state = sys.states[args[1]] ?? 'inactive';
      return state === 'active' ? cb(null, 'active\n', '') : cb(Object.assign(new Error('exit 3'), { code: 3 }), `${state}\n`, '');
    }
    if (args[0] === 'show') return cb(null, '4242\n', '');
    cb(null, '', '');
  },
}));

// What the units read goes to a folder of the test's own instead of /run/dispatch.
vi.mock('../src/machine.js', async (orig) => ({
  ...(await orig<typeof import('../src/machine.js')>()),
  RUN_ROOT: (await import('node:fs')).mkdtempSync(`${(await import('node:os')).tmpdir()}/dispatch-run-`),
}));

const units = await import('../src/units.js');
const { stopDisplay, ensureDisplay } = await import('../src/displays.js');

afterEach(() => { sys.calls = []; sys.states = {}; sys.fail = {}; });

test('a bot id becomes a unit name the way systemd-escape does it, so a slice never nests', () => {
  expect(units.unitKey('bot_Ab9_x')).toBe('bot_Ab9_x');
  // base64url ids can hold `-`, which in a slice's name would mean a slice inside a slice.
  expect(units.unitKey('bot_ab-cd')).toBe('bot_ab\\x2dcd');
  expect(units.gatewayUnit('bot_ab-cd')).toBe('dispatch-gateway@bot_ab\\x2dcd.service');
  expect(units.botSlice('bot_ab-cd')).toBe('dispatch-bot-bot_ab\\x2dcd.slice');
  expect(units.displayTarget(101)).toBe('dispatch-display@101.target');
  // The box scripts escape the same way (server/box/test_dispatchlib.py checks the same ids).
});

test("a bot's share of the machine: memory less 2 GiB, split by MAX_BOTS, at least 768 MiB, and half that in swap", () => {
  const GiB = 1024 ** 3;
  expect(units.botLimits(8 * GiB, 4)).toEqual({ MemoryHigh: '1305M', MemoryMax: '1536M', MemorySwapMax: '768M', CPUWeight: '50' });
  expect(units.botLimits(4 * GiB, 1)).toEqual({ MemoryHigh: '1740M', MemoryMax: '2048M', MemorySwapMax: '1024M', CPUWeight: '50' });
  // A machine asked to run more bots than it has room for still gives each one enough to start.
  expect(units.botLimits(4 * GiB, 8).MemoryMax).toBe('768M');
});

test("a unit's environment file has one quoted value per line and refuses a line break", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-units-')), 'run', 'x.env');
  units.writeEnvFile(file, { HERMES_HOME: '/data/engines/bot_1', DISPLAY: ':101', SKIPPED: undefined });
  expect(fs.readFileSync(file, 'utf8')).toBe('HERMES_HOME="/data/engines/bot_1"\nDISPLAY=":101"\n');
  expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  expect(() => units.writeEnvFile(file, { BAD: 'a\nb' })).toThrow(/line break/);
});

test('starting a unit that fails says what systemctl said and where its journal is', async () => {
  sys.fail.start = 'Job for dispatch-gateway@bot_1.service failed because the control process exited with error code.';
  await expect(units.start('dispatch-gateway@bot_1.service')).rejects.toThrow(/control process exited.*journalctl -u dispatch-gateway@bot_1\.service/);
});

test("stopping a unit that isn't there counts as stopped", async () => {
  sys.fail.stop = 'Failed to stop dispatch-bot-bot_1.slice: Unit dispatch-bot-bot_1.slice not loaded.';
  await expect(units.stop('dispatch-bot-bot_1.slice')).resolves.toBeUndefined();
});

test("a bot's limits are set on its slice until the next boot", async () => {
  await units.setSliceLimits('dispatch-bot-bot_1.slice', { MemoryMax: '1536M', CPUWeight: '50' });
  expect(sys.calls).toEqual([['systemctl', 'set-property', '--runtime', 'dispatch-bot-bot_1.slice', 'MemoryMax=1536M', 'CPUWeight=50']]);
});

test("a deleted bot's gateway and slice stop, with anything else of the bot's still running in the slice", async () => {
  await units.removeBotUnits('bot_ab-cd');
  expect(sys.calls).toContainEqual(['systemctl', 'stop', 'dispatch-gateway@bot_ab\\x2dcd.service', 'dispatch-bot-bot_ab\\x2dcd.slice']);
});

test("releasing a screen stops its display's target, which takes its pieces with it", async () => {
  await stopDisplay(101);
  expect(sys.calls).toEqual([['systemctl', 'stop', 'dispatch-display@101.target']]);
});

test('a display whose X server fails restarts once, then says where to look', async () => {
  sys.states['dispatch-xvnc@103.service'] = 'failed';
  await expect(ensureDisplay(103)).rejects.toThrow(/journalctl -u dispatch-xvnc@103\.service/);
  const verbs = sys.calls.filter((c) => c[1] === 'start' || c[1] === 'restart').map((c) => `${c[1]} ${c[2]}`);
  expect(verbs).toEqual(['start dispatch-display@103.target', 'restart dispatch-display@103.target']);
  // The units read the display's port and size from the file written before the start.
  expect(fs.readFileSync(units.displayEnvFile(103), 'utf8')).toMatch(/^VNC_PORT="6003"\nGEOMETRY="1440x900"\n/);
});
