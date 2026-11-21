// Installs, updates and rolls back Dispatch on a fresh machine the way a real one does: a systemd
// container from Ubuntu's image, the installer of a signed release, and updates run as the app runs
// them (server/src/updates.ts: this release's installer again, in a systemd unit of its own). The
// releases are this checkout's build (scripts/build-release.sh), signed here with a key made here and
// served from files, so nothing comes from GitHub and no real key is needed:
//
//   v9.0.0  installed first
//   v9.1.0  an update that works: the bot keeps running through it
//   v9.2.0  a broken update, whose server never answers: release.sh goes back to v9.1.0 and its
//           speech image, and the app says so
//   v9.3.0  an update after that, which works again
//
// Each release's installer is the bundled one with only release_signers and the two GitHub
// addresses changed (the test fails if they can't be found). The speech images are two tags of a
// tiny image, pulled by digest as a release's are, so the test can tell which one runs.
//
//   node tests/update.mjs   # Linux on x86-64, with Docker that may run privileged containers
//   docker rm -f dispatch-update-test; docker volume rm dispatch-update-test-docker dispatch-update-test-containerd   # after KEEP=1
//
// It takes 10 to 20 minutes, most of it the first install setting up the machine. It talks to the
// server from inside the machine over loopback, as release.sh does: an install has HTTPS on, which
// sends plain HTTP from anywhere else to HTTPS. Node's standard library, git, ssh-keygen and Docker
// only. Exits 1 when a check fails.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NAME = 'dispatch-update-test';
const ACCOUNT = 'tester';
const LLM_PORT = 8799;
// Two images that run until stopped, a few hundred kilobytes each, in place of the speech service.
const SPEECH = {
  old: 'registry.k8s.io/pause@sha256:7031c1b283388d2c2e09b57badb803c05ebed362dc88d84b480cc47f72a21097', // 3.9
  new: 'registry.k8s.io/pause@sha256:ee6521f290b2168b6e0935a181d4cff9be1ac3f505666ef0e3c98fae8199917a', // 3.10
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) ?? '').trim();
const inside = (...args) => run('docker', ['exec', NAME, ...args]);
const insideOk = (...args) => { try { return inside(...args); } catch (e) { return String(e.stdout ?? '').trim(); } };
const state = (unit) => insideOk('systemctl', 'is-active', unit);
const prop = (unit, name) => insideOk('systemctl', 'show', '-p', name, '--value', unit);
const key = (id) => [...id].map((ch, i) => (/[A-Za-z0-9_]/.test(ch) || (ch === '.' && i > 0) ? ch : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)).join('');

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

/** A request to the server from inside the machine, signed in once the account exists (a cookie jar in root's home). */
function api(method, p, body) {
  const args = ['curl', '-sS', '-b', '/root/update-test.cookies', '-c', '/root/update-test.cookies', '-X', method,
    '-H', 'content-type: application/json', '-w', '\n%{http_code}', ...(body === undefined ? [] : ['--data-binary', JSON.stringify(body)])];
  const out = insideOk(...args, `http://127.0.0.1:8787${p}`);
  const status = Number(out.slice(out.lastIndexOf('\n') + 1));
  let json = {};
  try { json = JSON.parse(out.slice(0, out.lastIndexOf('\n'))); } catch { /* not JSON */ }
  if (status < 200 || status > 299) throw new Error(`${method} ${p}: ${status || 'no answer'} ${json.error ?? ''}`);
  return json;
}
const answers = () => insideOk('curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:8787/api/health') === '200';

// ---------------------------------------------------------------- the releases

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-update-'));
const serve = path.join(work, 'serve');
const origin = path.join(serve, 'origin');
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devnull, GIT_CONFIG_NOSYSTEM: '1', SSH_AUTH_SOCK: '' };
const git = (...args) => run('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-C', origin, ...args], { env });
const signingKey = path.join(work, 'release');

function removeMachine() {
  for (const args of [['rm', '-f', NAME], ['volume', 'rm', '-f', `${NAME}-docker`, `${NAME}-containerd`]]) {
    try { run('docker', args); } catch { /* not there */ }
  }
}
function cleanUp() {
  removeMachine();
  fs.rmSync(work, { recursive: true, force: true });
}
// KEEP=1 leaves the machine running afterwards, to look into a failure (docker exec -it dispatch-update-test bash).
process.on('exit', () => { if (process.env.KEEP) fs.rmSync(work, { recursive: true, force: true }); else cleanUp(); });
process.on('SIGINT', () => process.exit(130));

console.log('Building this checkout');
const build = path.join(work, 'build');
run('bash', [path.join(ROOT, 'scripts/build-release.sh'), build], { stdio: ['ignore', 'ignore', 'inherit'] });
run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', signingKey]);
const [kind, blob] = fs.readFileSync(`${signingKey}.pub`, 'utf8').split(' ');
fs.mkdirSync(origin, { recursive: true });
run('git', ['init', '-q', '-b', 'main', origin], { env });

/** The bundled installer, trusting the key made here and fetching from the files served here. */
function installer() {
  let text = fs.readFileSync(path.join(build, 'scripts/install.sh'), 'utf8');
  const swap = (from, to) => {
    const n = text.split(from).length - 1;
    if (n !== 1) throw new Error(`the installer has ${n} of ${JSON.stringify(from)}, not one: change tests/update.mjs with it`);
    text = text.replace(from, () => to);
  };
  swap(/^dispatch namespaces="git,dispatch-release" .*$/m.exec(text)?.[0] ?? 'release_signers key line', `dispatch namespaces="git,dispatch-release" ${kind} ${blob}`);
  swap('url="https://github.com/$repo.git"', 'url=file:///srv/test/origin');
  swap('${DISPATCH_RELEASES_URL:-https://github.com/$repo/releases/download}', '${DISPATCH_RELEASES_URL:-file:///srv/test/releases}');
  return text;
}
const testInstaller = installer();

/** Release <version>: a commit and a signed tag in origin, and its files as release.yml attaches them, with SHA256SUMS signed as publish.sh signs it. */
function release(version, { speech, broken = false }) {
  git('commit', '-q', '--allow-empty', '-m', `Dispatch ${version}`);
  const commit = git('rev-parse', 'HEAD');
  git('-c', 'gpg.format=ssh', '-c', `user.signingKey=${signingKey}`, 'tag', '-s', '-m', `Dispatch ${version}`, version, commit);
  const tree = path.join(work, version);
  run('cp', ['-a', build, tree]);
  fs.writeFileSync(path.join(tree, 'scripts/install.sh'), testInstaller);
  // A server that starts and never answers, as a release that hangs at startup would.
  if (broken) fs.writeFileSync(path.join(tree, 'server/dist/index.js'), 'setInterval(() => {}, 1 << 30);\n');
  const dir = path.join(serve, 'releases', version);
  fs.mkdirSync(dir, { recursive: true });
  const tarball = `dispatch-${version}-linux-amd64.tar.gz`;
  run('sh', ['-c', `tar --sort=name --owner=0 --group=0 --numeric-owner -C "$1" -cf - . | gzip -n >"$2"`, 'sh', tree, path.join(dir, tarball)]);
  fs.rmSync(tree, { recursive: true });
  const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ version, commit, tarball, tarballSha256: sha256(tarball), speechImage: speech }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha256(tarball)}  ${tarball}\n${sha256('manifest.json')}  manifest.json\n`);
  run('ssh-keygen', ['-q', '-Y', 'sign', '-n', 'dispatch-release', '-f', signingKey, path.join(dir, 'SHA256SUMS')]);
  return { version, commit, short: commit.slice(0, 12), speech };
}

/** Runs the running release's installer as the app's Update does, and waits for it. Its exit status. */
function update() {
  const current = inside('readlink', '/srv/dispatch/current');
  try {
    // updates.ts runs systemd-run with these settings and returns; --wait only lets this wait for it.
    inside('systemd-run', '--wait', '--collect', '--unit=dispatch-update', '--description=Dispatch update', '--setenv=HOME=/root',
      '--setenv=LANG=C.UTF-8', '--setenv=DISPATCH_YES=1', '--setenv=DISPATCH_REPO=chriscorbell/dispatch',
      '/bin/bash', `/srv/dispatch/${current}/scripts/install.sh`);
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}
const running = () => insideOk('readlink', '/srv/dispatch/current');
const speechImage = () => insideOk('docker', 'inspect', '-f', '{{.Config.Image}}', 'dispatch-speech-speech-1');

// ---------------------------------------------------------------- the machine

console.log('Starting a fresh machine');
removeMachine();
const base = /^FROM (ubuntu:\S+) AS computer$/m.exec(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'))[1];
// What a fresh Ubuntu server has that the image doesn't, and the account the bots will run as.
// safe.directory: the test's origin repository belongs to whoever runs the test, not to root.
run('docker', ['build', '-q', '-t', NAME, '-'], {
  input: `FROM ${base}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv sudo curl ca-certificates iproute2 tzdata git openssh-client \\
 && rm -rf /var/lib/apt/lists/* && useradd --create-home --shell /bin/bash ${ACCOUNT} && git config --system --add safe.directory '*'
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`,
  stdio: ['pipe', 'pipe', 'inherit'],
});
run('docker', ['run', '-d', '--name', NAME, '--hostname', NAME, '--privileged', '--cgroupns=private', '--tmpfs', '/run', '--tmpfs', '/run/lock',
  '--shm-size', '2g', '-v', `${NAME}-docker:/var/lib/docker`, '-v', `${NAME}-containerd:/var/lib/containerd`,
  '-v', `${serve}:/srv/test:ro`, NAME]);
await until('systemd starting', () => ['running', 'degraded'].includes(insideOk('systemctl', 'is-system-running')), 60_000);

const v1 = release('v9.0.0', { speech: SPEECH.old });
fs.writeFileSync(path.join(serve, 'install.sh'), testInstaller);

// ---------------------------------------------------------------- the checks

let gatewayPid = '';
let gateway = '';

await check('the installer installs the newest signed release on a fresh machine', async () => {
  console.log('  installing v9.0.0 (it sets up the machine: about ten minutes)');
  try {
    run('docker', ['exec', '-e', 'DISPATCH_YES=1', '-e', `DISPATCH_USER=${ACCOUNT}`, NAME, 'bash', '/srv/test/install.sh'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
  } catch (e) {
    throw new Error(`the installer failed:\n${String(e.stderr ?? '').slice(-3000)}\n${insideOk('tail', '-n', '40', '/var/log/dispatch/install.log')}`);
  }
  expect(running() === `releases/${v1.short}`, `current is ${running()}`);
  expect(insideOk('cat', `/srv/dispatch/releases/${v1.short}/VERSION`) === 'v9.0.0', 'its VERSION file is not v9.0.0');
  expect(answers(), 'the server does not answer');
  expect(speechImage() === SPEECH.old, `the speech service runs ${speechImage() || 'nothing'}`);
});

await check('a bot runs on the installed release', async () => {
  const code = inside('cat', '/var/lib/dispatch/setup-code');
  api('POST', '/api/auth/setup', { username: 'updates', password: 'update-test-password', code });
  // Not in /tmp: systemd mounts a tmpfs there, over what docker exec would write.
  execFileSync('docker', ['exec', '-i', NAME, 'sh', '-c', 'cat > /usr/local/lib/fake-llm.mjs'], { input: fs.readFileSync(path.join(ROOT, 'tests/fake-llm.mjs')) });
  inside('systemd-run', '--unit=dispatch-test-llm', '--collect', 'node', '/usr/local/lib/fake-llm.mjs', String(LLM_PORT));
  await until('the fake model answering', () => insideOk('curl', '-fsS', `http://127.0.0.1:${LLM_PORT}/v1/models`).includes('fake-model'), 20_000);
  api('PUT', '/api/providers', { selfHostedUrl: `http://127.0.0.1:${LLM_PORT}/v1` });
  const bot = (api('POST', '/api/bots', { name: 'Ada' })).bot;
  api('PATCH', `/api/bots/${bot.id}/engine`, { provider: 'self-hosted', model: 'fake-model' });
  api('POST', '/api/setup/finish', { greet: false });
  gateway = `dispatch-gateway@${key(bot.id)}.service`;
  await until('its agent getting ready', () => (api('GET', `/api/bots/${bot.id}/engine`)).engine.status === 'ready', 240_000, 2000);
  gatewayPid = prop(gateway, 'MainPID');
  expect(state(gateway) === 'active' && gatewayPid !== '0', `${gateway} is ${state(gateway)}`);
  expect(prop(gateway, 'User') === ACCOUNT, `${gateway} runs as ${prop(gateway, 'User') || 'root'}`);
});

const v2 = release('v9.1.0', { speech: SPEECH.old });
await check('an update installs the next release, and the bot keeps running through it', async () => {
  const status = update();
  expect(status === 0, `the update ended with ${status}: ${insideOk('tail', '-n', '30', '/var/log/dispatch/install.log')}`);
  expect(running() === `releases/${v2.short}`, `current is ${running()}`);
  expect(insideOk('cat', `/srv/dispatch/releases/${v2.short}/VERSION`) === 'v9.1.0', 'its VERSION file is not v9.1.0');
  expect(insideOk('sh', '-c', `test -d /srv/dispatch/releases/${v1.short} && echo kept`) === 'kept', 'the release before it was removed');
  await until('the server answering', answers, 60_000);
  expect(prop(gateway, 'MainPID') === gatewayPid, `the gateway restarted (${gatewayPid} is now ${prop(gateway, 'MainPID')})`);
  const { update: u } = api('GET', '/api/update');
  expect(u.current === 'v9.1.0' && u.status === 'idle', `the app says ${JSON.stringify(u)}`);
});

const v3 = release('v9.2.0', { speech: SPEECH.new, broken: true });
await check('a release that never answers is rolled back to the one before, with its speech image', async () => {
  const t0 = Date.now();
  const status = update();
  expect(status !== 0, 'the update of a broken release succeeded');
  expect(Date.now() - t0 > 60_000, 'release.sh gave the new release less than a minute');
  expect(running() === `releases/${v2.short}`, `current is ${running()}, not ${v2.short}`);
  await until('the server answering', answers, 60_000);
  expect(speechImage() === SPEECH.old, `the speech service runs ${speechImage() || 'nothing'}, not v9.1.0's`);
  const said = insideOk('journalctl', '-u', 'dispatch-update', '--no-pager');
  expect(said.includes(`on ${v3.short}, so it went back to ${v2.short}`), `the update didn't say it went back from ${v3.short} to ${v2.short}`);
  // release.sh wrote /etc/dispatch/last-update for the server it went back to, which read it as it
  // started and removed it (updates.ts, rolledBack).
  await until('the server reading what failed', () => insideOk('journalctl', '-u', 'dispatch', '--no-pager').includes('[updates] v9.2.0 didn’t start'), 30_000);
  expect(insideOk('sh', '-c', 'test -e /etc/dispatch/last-update && echo there') === '', '/etc/dispatch/last-update is still there after the server read it');
  expect(prop(gateway, 'MainPID') === gatewayPid, `the gateway restarted (${gatewayPid} is now ${prop(gateway, 'MainPID')})`);
});

await check('the app says the update failed and the release before it runs', async () => {
  const { update: u } = api('GET', '/api/update');
  expect(u.current === 'v9.1.0', `the app says it runs ${u.current}`);
  expect(u.status === 'failed' && u.error.includes('v9.2.0') && u.error.includes('went back'), `the app says ${JSON.stringify(u)}`);
});

const v4 = release('v9.3.0', { speech: SPEECH.new });
await check('the next update after a rollback works, and the app no longer says it failed', async () => {
  const status = update();
  expect(status === 0, `the update ended with ${status}: ${insideOk('tail', '-n', '30', '/var/log/dispatch/install.log')}`);
  expect(running() === `releases/${v4.short}`, `current is ${running()}`);
  await until('the server answering', answers, 60_000);
  expect(insideOk('sh', '-c', 'test -e /etc/dispatch/last-update && echo there') === '', '/etc/dispatch/last-update is still there');
  expect(speechImage() === SPEECH.new, `the speech service runs ${speechImage() || 'nothing'}, not v9.3.0's`);
  const { update: u } = api('GET', '/api/update');
  expect(u.current === 'v9.3.0' && u.status === 'idle', `the app says ${JSON.stringify(u)}`);
  expect(state(gateway) === 'active', `${gateway} is ${state(gateway)}`);
});

const failed = results.filter((ok) => !ok).length;
if (failed && process.env.CI) {
  console.log(insideOk('journalctl', '--no-pager', '-n', '200', '-u', 'dispatch', '-u', 'dispatch-update'));
}
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
