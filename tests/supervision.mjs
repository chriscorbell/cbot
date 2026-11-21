// Checks that systemd runs the bots the way server/src/units.ts says, against a fresh dev container
// (compose.yaml: systemd is its first process). A bot runs on tests/fake-llm.mjs, started in the
// container, so nothing needs a key or the network. It makes the account, two bots and one chat turn,
// then restarts the server, kills a gateway, checks the bots run as one ordinary account with Chrome's
// sandbox on, runs one bot out of memory and deletes the other.
//
//   DISPATCH_PORT=8792 docker compose -p dispatch-supervision up -d --build dispatch
//   node tests/supervision.mjs [baseUrl] [container]   # http://127.0.0.1:8792, dispatch-supervision-dispatch-1
//   docker compose -p dispatch-supervision down -v
//
// The container must be new (no account yet): the script makes the account with the setup code it
// reads from the container. Node's standard library only. Exits 1 when a check fails.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8792';
const CONTAINER = process.argv[3] ?? 'dispatch-supervision-dispatch-1';
const LLM_PORT = 8799;
const REPLY = 'Hello from the fake model.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inside = (...args) => execFileSync('docker', ['exec', CONTAINER, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const insideOk = (...args) => { try { return inside(...args); } catch (e) { return String(e.stdout ?? '').trim(); } };
/** A bot id as units.ts names its units (systemd-escape). */
const key = (id) => [...id].map((ch, i) => (/[A-Za-z0-9_]/.test(ch) || (ch === '.' && i > 0) ? ch : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)).join('');
const state = (unit) => insideOk('systemctl', 'is-active', unit);
const prop = (unit, name) => insideOk('systemctl', 'show', '-p', name, '--value', unit);

async function until(what, check, ms = 120_000, every = 1000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await check(); if (last) return last; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`${what} didn't happen within ${ms / 1000}s${last instanceof Error ? ` (${last.message})` : ''}`);
}

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(true);
    console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}
const expect = (ok, said) => { if (!ok) throw new Error(said); };

let cookie = '';
async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${out.error ?? ''}`);
  return out;
}
const engineReady = (id) => until(`bot ${id}'s agent getting ready`, async () => {
  const { engine } = await api('GET', `/api/bots/${id}/engine`);
  if (engine.status === 'error') throw new Error(engine.error);
  return engine.status === 'ready';
}, 240_000, 2000);

// ---------------------------------------------------------------- a fresh install with a fake model

await until('the server answering', async () => (await fetch(`${BASE}/api/health`)).ok, 180_000);
const code = inside('cat', '/data/setup-code');
const setup = await fetch(`${BASE}/api/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'supervision', password: 'supervision-test-password', code }),
});
expect(setup.ok, `making the account failed: ${setup.status}`);
cookie = setup.headers.get('set-cookie').split(';')[0];

// Not in /tmp: systemd mounts a tmpfs there in the container, over what `docker cp` would write.
execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', 'cat > /usr/local/lib/fake-llm.mjs'], { input: fs.readFileSync(new URL('./fake-llm.mjs', import.meta.url)) });
insideOk('systemctl', 'stop', 'dispatch-test-llm.service');
inside('systemd-run', '--unit=dispatch-test-llm', '--collect', 'node', '/usr/local/lib/fake-llm.mjs', String(LLM_PORT));
await until('the fake model answering', () => insideOk('curl', '-fsS', `http://127.0.0.1:${LLM_PORT}/v1/models`).includes('fake-model'), 20_000);
await api('PUT', '/api/providers', { selfHostedUrl: `http://127.0.0.1:${LLM_PORT}/v1` });

const ada = (await api('POST', '/api/bots', { name: 'Ada' })).bot;
await api('PATCH', `/api/bots/${ada.id}/engine`, { provider: 'self-hosted', model: 'fake-model' });
await api('POST', '/api/setup/finish', { greet: false });
const A = { gateway: `dispatch-gateway@${key(ada.id)}.service`, slice: `dispatch-bot-${key(ada.id)}.slice`, chrome: `dispatch-chrome-${key(ada.id)}.service` };

// ---------------------------------------------------------------- the checks

await check("a bot's display and gateway run as units, the gateway in the bot's slice under a memory limit", async () => {
  await engineReady(ada.id);
  for (const unit of ['dispatch-display@99.target', 'dispatch-xvnc@99.service', 'dispatch-bus@99.service', 'dispatch-wm@99.service', A.gateway]) {
    expect(state(unit) === 'active', `${unit} is ${state(unit)}`);
  }
  expect(prop(A.gateway, 'Slice') === A.slice, `the gateway is in ${prop(A.gateway, 'Slice')}`);
  expect(/^\d+$/.test(prop(A.slice, 'MemoryMax')), `the slice's MemoryMax is ${prop(A.slice, 'MemoryMax')}`);
  // Nothing of the bot's is in the server's own control group any more.
  const group = prop('dispatch.service', 'ControlGroup');
  const procs = insideOk('sh', '-c', `for p in $(cat /sys/fs/cgroup${group}/cgroup.procs); do cat /proc/$p/comm; done`);
  expect(!/Xvnc|hermes|chrome/i.test(procs), `the server's control group holds: ${procs.split('\n').join(', ')}`);
});

await check('a chat message gets the fake model\'s reply, and the bot\'s Chrome runs in its slice', async () => {
  await api('POST', `/api/bots/${ada.id}/messages`, { text: 'Say hello.' });
  await until('the reply in the chat', async () => {
    const { rows } = await api('GET', `/api/bots/${ada.id}/rows`);
    return rows.some((r) => r.body?.type === 'message' && r.body.role === 'assistant' && !r.body.streaming && r.body.text?.includes(REPLY));
  }, 180_000, 2000);
  expect(state(A.chrome) === 'active', `${A.chrome} is ${state(A.chrome)}`);
  expect(prop(A.chrome, 'Slice') === A.slice, `Chrome is in ${prop(A.chrome, 'Slice')}`);
});

await check('restarting the server leaves the display and the gateway running, and it uses them as they are', async () => {
  const before = { gateway: prop(A.gateway, 'MainPID'), xvnc: prop('dispatch-xvnc@99.service', 'MainPID'), chrome: prop(A.chrome, 'MainPID') };
  inside('systemctl', 'restart', 'dispatch.service');
  await until('the server answering again', async () => (await fetch(`${BASE}/api/health`)).ok, 120_000);
  await engineReady(ada.id);
  await sleep(5000);
  const after = { gateway: prop(A.gateway, 'MainPID'), xvnc: prop('dispatch-xvnc@99.service', 'MainPID'), chrome: prop(A.chrome, 'MainPID') };
  expect(Object.values(before).every((pid) => Number(pid) > 1), `not everything ran before the restart: ${JSON.stringify(before)}`);
  expect(JSON.stringify(after) === JSON.stringify(before), `main pids were ${JSON.stringify(before)}, now ${JSON.stringify(after)}`);
});

await check('a gateway that is killed comes back by itself', async () => {
  const pid = prop(A.gateway, 'MainPID');
  inside('kill', '-9', pid);
  await until('systemd restarting the gateway', () => state(A.gateway) === 'active' && prop(A.gateway, 'MainPID') !== pid && prop(A.gateway, 'MainPID') !== '0', 60_000);
  await engineReady(ada.id);
});

const bea = (await api('POST', '/api/bots', { name: 'Bea' })).bot;
const B = { gateway: `dispatch-gateway@${key(bea.id)}.service`, slice: `dispatch-bot-${key(bea.id)}.slice` };

// ---------------------------------------------------------------- the bots' account (server/src/account.ts)

// The Dockerfile makes it, as the installer's account is on a machine.
const ACCOUNT = insideOk('sh', '-c', 'echo "$DISPATCH_USER"') || 'root';
const HOME = insideOk('sh', '-c', `getent passwd ${ACCOUNT} | cut -d: -f6`);
const asAccount = (...cmd) => inside('runuser', '-u', ACCOUNT, '--', ...cmd);
const userOf = (pid) => insideOk('ps', '-o', 'user=', '-p', String(pid));
const argsOf = (pid) => insideOk('sh', '-c', `tr '\\0' ' ' < /proc/${pid}/cmdline`);
/** Every process in a unit's or slice's control group, its sub-groups too. */
const procsIn = (unit) => insideOk('sh', '-c', `cat $(find /sys/fs/cgroup${prop(unit, 'ControlGroup')} -name cgroup.procs) 2>/dev/null`).split('\n').filter(Boolean);

await check('every bot runs as one ordinary account: its gateway, Chrome and display, and all it starts but the dock', async () => {
  expect(ACCOUNT !== 'root', 'the container names no account for the bots (DISPATCH_USER)');
  await engineReady(bea.id);
  for (const unit of [A.gateway, A.chrome, B.gateway, 'dispatch-xvnc@99.service', 'dispatch-bus@99.service', 'dispatch-wm@99.service']) {
    const pid = prop(unit, 'MainPID');
    expect(userOf(pid) === ACCOUNT, `${unit} (pid ${pid}) runs as ${userOf(pid) || 'nobody'}`);
  }
  // The dock (with the image loaders GTK starts for it) is Dispatch's own and stays root: it asks
  // systemd to open apps, which only root may.
  const dock = new Set(procsIn('dispatch-shell-99.service'));
  expect(dock.size, 'the dock of screen 99 isn\'t running');
  const root = procsIn(A.slice).filter((pid) => !dock.has(pid) && userOf(pid) === 'root');
  expect(!root.length, `in ${A.slice}, root runs: ${root.map(argsOf).join('; ')}`);
});

await check("a file in one bot's Library is the other bot's to change", async () => {
  const form = new FormData();
  form.append('file', new Blob(['written by the app\n'], { type: 'text/plain' }), 'shared-note.txt');
  const r = await fetch(`${BASE}/api/bots/${ada.id}/files/upload`, { method: 'POST', headers: { cookie }, body: form });
  expect(r.ok, `the upload failed: ${r.status}`);
  const file = `${HOME}/dispatch/files/${ada.id}/${(await r.json()).files[0].path}`;
  expect(insideOk('stat', '-c', '%U', file) === ACCOUNT, `${file} belongs to ${insideOk('stat', '-c', '%U', file)}`);
  // Bea, in her own slice, as the account she runs as, adds a line to Ada's file.
  inside('systemd-run', '--wait', '--collect', '--quiet', `--uid=${ACCOUNT}`, `--slice=${B.slice}`, 'sh', '-c', `echo 'and by Bea' >> '${file}'`);
  expect(inside('cat', file).includes('and by Bea'), "Bea's line isn't in the file");
  const config = `${HOME}/dispatch/engines/${ada.id}/config.yaml`;
  expect(insideOk('stat', '-c', '%U', config) === ACCOUNT, `${config} belongs to ${insideOk('stat', '-c', '%U', config)}`);
});

await check("the bots' account can't read the server's data without sudo, and can sudo", async () => {
  for (const file of ['/data/secret', '/data/dispatch.db']) {
    let read = true;
    try { asAccount('cat', file); } catch { read = false; }
    expect(!read, `${ACCOUNT} can read ${file}`);
  }
  asAccount('sudo', '-n', 'true');
});

await check('Chrome keeps its sandbox: no --no-sandbox, and its renderers are sandboxed', async () => {
  const main = prop(A.chrome, 'MainPID');
  expect(!argsOf(main).includes('--no-sandbox'), 'Chrome runs with --no-sandbox');
  const renderers = procsIn(A.chrome).filter((pid) => argsOf(pid).includes('--type=renderer'));
  expect(renderers.length, 'Chrome has no renderer');
  const ns = (pid) => insideOk('readlink', `/proc/${pid}/ns/pid`);
  let seen = 0;
  for (const pid of renderers) {
    // Chrome ends spare renderers as it goes; one gone since the list was made is skipped.
    const seccomp = insideOk('sh', '-c', `grep '^Seccomp:' /proc/${pid}/status 2>/dev/null`).split(/\s+/)[1];
    if (seccomp === undefined) continue;
    seen++;
    expect(seccomp === '2', `renderer ${pid} has Seccomp ${seccomp}, not filtered (2)`);
    expect(ns(pid) !== ns(main), `renderer ${pid} shares the browser's pid namespace`);
  }
  expect(seen, 'every renderer was gone before it could be looked at');
});

await check("a process that goes over one bot's memory limit is killed, and the other bot runs on", async () => {
  await engineReady(bea.id);
  const was = { MemoryMax: prop(A.slice, 'MemoryMax'), MemoryHigh: prop(A.slice, 'MemoryHigh'), MemorySwapMax: prop(A.slice, 'MemorySwapMax') };
  // Room for what the bot already runs and 256 MiB more, and no swap to spill into, then a process
  // that wants 1 GiB. (The real limit is the machine's memory split between the bots, units.ts.)
  const using = Number(prop(A.slice, 'MemoryCurrent'));
  const limit = using + 256 * 1024 * 1024;
  inside('systemctl', 'set-property', '--runtime', A.slice, `MemoryMax=${limit}`, 'MemoryHigh=infinity', 'MemorySwapMax=0');
  try {
    let said = '';
    try {
      inside('systemd-run', '--wait', '--collect', `--slice=${A.slice}`, '--unit=dispatch-test-hog', '--property=OOMScoreAdjust=1000',
        'python3', '-c', 'import time\nx = []\nfor _ in range(64):\n    x.append(bytearray(16 * 1024 * 1024))\n    time.sleep(0.02)\ntime.sleep(5)');
    } catch (e) { said = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
    expect(/oom/i.test(said), `the process wasn't killed for memory: ${said.trim() || 'it finished'}`);
  } finally {
    inside('systemctl', 'set-property', '--runtime', A.slice, `MemoryMax=${was.MemoryMax}`, `MemoryHigh=${was.MemoryHigh}`, `MemorySwapMax=${was.MemorySwapMax}`);
  }
  for (const unit of [B.gateway, 'dispatch-display@100.target', 'dispatch.service']) expect(state(unit) === 'active', `${unit} is ${state(unit)}`);
  await engineReady(bea.id);
});

await check("deleting a bot stops its gateway, display and slice", async () => {
  await api('DELETE', `/api/bots/${bea.id}`);
  await until('its units stopping', () => [B.gateway, B.slice, 'dispatch-display@100.target', 'dispatch-xvnc@100.service'].every((u) => state(u) !== 'active'), 60_000);
  expect(insideOk('sh', '-c', `test -e '/run/dispatch/gateway-${bea.id}.env' && echo there`) === '', 'its environment file is still there');
  // The other bot is untouched.
  expect(state(A.gateway) === 'active', `${A.gateway} is ${state(A.gateway)}`);
});

insideOk('systemctl', 'stop', 'dispatch-test-llm.service');
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
