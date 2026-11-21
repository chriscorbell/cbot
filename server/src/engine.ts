import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { cdpUrlFor, screenFor } from './computer.js';
import { db, type BotRecord, type UserRecord } from './db.js';
import { env } from './env.js';
import type { ApprovalMode, EngineInfo, EngineProvider } from './types.js';
import { TOOLS } from './agent/tools.js';
import { displayFor, ENGINE_PORT_BASE, HERMES_ROOT, libraryDir } from './machine.js';
import { requireBot } from './store.js';
import { envOf, getSetting, secretEnv } from './settings.js';

/**
 * Every bot is run by a Hermes agent of its own: a Hermes home under <DATA_DIR>/engines/<botId> with
 * its own `hermes gateway run`, started here on its own port and left running when this server exits.
 * A restarted server adopts it, unless the settings this app gives it changed in the meantime; then
 * it is restarted on the new ones. The primary bot's agent is one of these too.
 *
 * Each home is a Hermes root of its own (its default profile), so one bot's gateway never folds the
 * others into it. Hermes keeps its tools and Python environment per root; a home links tools/ and
 * installs/ to the ones installed on the machine under HERMES_ROOT instead of downloading its own.
 *
 * A bot's engine, as engineInfo reports it to the settings panel:
 *
 *   (none) ──assignEngine──► starting ──/health answers──► ready
 *                               │  ▲                         │
 *                     start fails  └── ensureManaged ◄───────┘ gateway gone (next turn or panel look)
 *                               ▼
 *                             error (until a start succeeds)
 *
 *   none      bots.engine is null: a bot from before engines, given one on first use; rooms never get one
 *   starting  a start or adoption is in flight (`starting`), or nothing answers and none has failed
 *   ready     the gateway answers /health
 *   error     nothing answers and the last start failed (`failures`)
 *
 * Starting (startGateway): rewrite the home, then if a gateway already answers on the bot's port with
 * our key, adopt it when the settings hash it started with still matches (or its screen is down, or it
 * has no pid file); otherwise stop it, spawn `hermes gateway run` detached and wait up to 90 s for
 * /health. Looking at the settings panel of a bot whose gateway is down starts it too.
 */

export interface Engine { url: string; key: string; home: string }

/** The `hermes` CLI (scripts/provision.sh installs it under HERMES_ROOT). */
export const HERMES_BIN = 'hermes';

/** The environment a `hermes` command for one home runs with: only what Hermes needs, none of this server's secrets. */
export function hermesEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    USER: process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    HERMES_HOME: home,
    ...extra,
  };
}
/** The gateways reach this server's MCP endpoint over loopback. */
const mcpBaseUrl = () => `http://127.0.0.1:${env.port}`;

const botRow = (botId: string) => db.prepare<[string], BotRecord>('SELECT * FROM bots WHERE id=?').get(botId);

// ---------- small file helpers ----------

/** KEY=value lines of a dotenv file (quotes stripped). Missing file = {}. */
function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readYaml(file: string): any {
  try { return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

function writePrivate(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Replace a file a running gateway may read at any moment: it sees the old file or the new one, never half. */
function replacePrivate(file: string, content: string) {
  const tmp = `${file}.dispatch-${process.pid}`;
  writePrivate(tmp, content);
  fs.renameSync(tmp, file);
}

// ---------- identity ----------

/** Token a bot's Hermes agent presents to this server's MCP endpoint. */
export function mcpToken(botId: string): string {
  return crypto.createHmac('sha256', env.appSecret).update(`mcp:${botId}`).digest('hex');
}

function primaryBotId(): string | null {
  return db.prepare<[], Pick<BotRecord, 'id'>>("SELECT id FROM bots WHERE is_primary=1 AND kind <> 'room' ORDER BY created_at LIMIT 1").get()?.id ?? null;
}

/** The bot has a Hermes home and gateway of its own ('managed' in bots.engine). */
export function hasEngine(botId: string): boolean {
  return botRow(botId)?.engine === 'managed';
}

const homeFor = (botId: string) => path.join(env.enginesDir, botId);

/** The primary bot's home, which a newer bot's home starts from (model settings, .env credentials), or null for the primary bot itself. */
function inheritedHome(botId: string): string | null {
  const primary = primaryBotId();
  if (!primary || primary === botId) return null;
  const home = homeFor(primary);
  return fs.existsSync(home) ? home : null;
}

// ---------- assignment ----------

/** Ports of deleted bots' gateways that are still being stopped; nobody gets one until it is free. */
const retiringPorts = new Set<number>();

function freePort(): number {
  const used = new Set(db.prepare<[], { engine_port: number }>('SELECT engine_port FROM bots WHERE engine_port IS NOT NULL').all().map((r) => r.engine_port));
  for (const p of retiringPorts) used.add(p);
  let p = ENGINE_PORT_BASE;
  while (used.has(p)) p++;
  return p;
}

/** Give a new agent bot its engine: a Hermes home and an API server port of its own. */
export function assignEngine(botId: string) {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  if (b.engine === 'managed' && b.engine_port) return;
  db.prepare("UPDATE bots SET engine='managed', engine_port=? WHERE id=?").run(b.engine_port ?? freePort(), botId);
}

// ---------- a bot's Hermes home ----------

/** Parts of the primary bot's config a newer bot starts from, so it reaches the same models. */
const SHARED_CONFIG = ['model', 'providers', 'custom_providers', 'auxiliary', 'fallback_model', 'fallback_providers'];

/** The model a bot runs on when nobody chose one and a DeepSeek key is set: DeepSeek's newest, which also reads screenshots. */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';

/** Plugins scripts/provision.sh installs under HERMES_ROOT/plugins; every home links them. GitHub Copilot left Hermes core for one. */
const SHARED_PLUGINS = ['github-copilot'];

/**
 * What a bot's agent may use, for its turns from this app (api_server) and for Hermes cron jobs it makes
 * itself. Hermes' API server bundle minus web_extract (no extract backend here: pages are read in the
 * bot's Chrome), image generation and text-to-speech (cloud services), connectors (Nous' tool gateway),
 * and kanban. `search` is web_search alone, offered only when SearXNG backs it.
 */
const TOOLSETS = ['terminal', 'file', 'browser', 'code_execution', 'vision', 'skills', 'todo', 'memory', 'session_search', 'delegation', 'cronjob'];

/** Toolsets switched off on every surface (the CLI in the bot's terminal included), because each one calls a cloud service. */
const OFF_TOOLSETS = ['image_gen', 'tts', 'connections'];

const searxngUrl = () => getSetting('searxng-url');

/** Where the Anthropic API endpoint sends a bot's requests (Hermes adds /v1/messages). */
const ANTHROPIC_API = 'https://api.anthropic.com';

/**
 * Endpoints Dispatch declares in every home's `providers:` (Hermes' named custom providers), each present
 * while Settings > Providers has what it needs. Runs name one by its key, as `provider`.
 *
 *   anthropic-api  the Anthropic API on a key, apart from the `anthropic` provider: Hermes would use an
 *                  ANTHROPIC_API_KEY for a signed-in Claude subscription too, ahead of its sign-in
 *   self-hosted    an OpenAI-compatible server at the address set there, with its key if it has one
 */
function applyEndpoints(cfg: any) {
  const providers = { ...(cfg.providers ?? {}) };
  if (getSetting('anthropic-api')) {
    providers['anthropic-api'] = { name: 'Anthropic API', api: ANTHROPIC_API, transport: 'anthropic_messages', key_env: envOf('anthropic-api'), catalog_provider: 'anthropic' };
  } else delete providers['anthropic-api'];
  const url = getSetting('self-hosted-url');
  if (url) providers['self-hosted'] = { name: 'Self-hosted', api: url, ...(getSetting('self-hosted-key') ? { key_env: envOf('self-hosted-key') } : {}) };
  else delete providers['self-hosted'];
  if (Object.keys(providers).length) cfg.providers = providers;
  else delete cfg.providers;
}

/**
 * The bot's provider and model are also its Hermes' default. Hermes resolves the default's credentials
 * before it looks at the provider a run asks for, so a default nobody has a key for fails every run;
 * and Hermes cron jobs the bot makes run on the default. A bot nobody chose a model for runs on DeepSeek
 * when its key is set; a model chosen in Hermes itself (`hermes model`) stays.
 */
function applyModel(cfg: any, b: Pick<BotRecord, 'provider' | 'model'>) {
  if (b.provider) cfg.model = { provider: b.provider, ...(b.model ? { default: b.model } : {}) };
  else if (getSetting('deepseek') && !hasModel(cfg.model)) cfg.model = { provider: 'deepseek', default: DEFAULT_DEEPSEEK_MODEL };
}

function hasModel(m: unknown): boolean {
  if (typeof m === 'string') return !!m.trim();
  return !!m && typeof m === 'object' && !!((m as any).provider || (m as any).default || (m as any).model);
}

/**
 * The settings this app owns in every bot's config.yaml, applied on each gateway start (so homes made
 * by an older version catch up). Besides the bot's own screen, MCP and model default, they keep Hermes
 * off third-party services other than the bot's model provider: no keyless web-search ring, no Nous
 * free tier or tool gateway, no cloud browser, no telemetry, update, catalog or plugin-update checks,
 * no voice transcription, and no language servers downloaded on their own.
 */
function applyManagedConfig(cfg: any, o: { bot: BotRecord; cwd: string; display: string | null; cdp: string }) {
  const searxng = !!searxngUrl();
  const toolsets = [...TOOLSETS, ...(searxng ? ['search'] : [])];
  cfg.platform_toolsets = { ...(cfg.platform_toolsets ?? {}), api_server: [...toolsets, ...(o.display ? ['computer_use'] : [])], cron: toolsets };
  const agent = cfg.agent ?? {};
  const off: unknown[] = Array.isArray(agent.disabled_toolsets) ? agent.disabled_toolsets : [];
  cfg.agent = { ...agent, disabled_toolsets: [...off, ...OFF_TOOLSETS.filter((t) => !off.includes(t))] };

  // web_search runs on SearXNG and nothing else: no keyless free-tier ring, not even as a one-off rescue.
  const web = { ...(cfg.web ?? {}), keyless_fallback: false, keyless_rescue: false };
  for (const k of ['backend', 'search_backend']) {
    if (searxng) web[k] = 'searxng';
    else if (web[k] === 'searxng') delete web[k];
  }
  cfg.web = web;

  applyEndpoints(cfg);
  applyModel(cfg, o.bot);

  // Hermes' clock (the date line in its system prompt, its cron jobs) runs on the server's time zone (TZ).
  cfg.timezone = env.timeZone;
  cfg.terminal = { ...(cfg.terminal ?? {}), cwd: o.cwd };
  cfg.browser = { ...(cfg.browser ?? {}), cloud_provider: 'local', ...(o.cdp ? { cdp_url: o.cdp } : {}) };
  cfg.mcp_servers = {
    ...(cfg.mcp_servers ?? {}),
    dispatch: { url: `${mcpBaseUrl()}/mcp/${o.bot.id}`, headers: { Authorization: `Bearer ${mcpToken(o.bot.id)}` }, timeout: 1800, connect_timeout: 30 },
  };

  cfg.nous = { ...(cfg.nous ?? {}), guest: false };
  cfg.tools = { ...(cfg.tools ?? {}), connectors: { ...(cfg.tools?.connectors ?? {}), enabled: false } };
  cfg.telemetry = { ...(cfg.telemetry ?? {}), shared_metrics: { ...(cfg.telemetry?.shared_metrics ?? {}), enabled: false, send: false } };
  cfg.updates = { ...(cfg.updates ?? {}), check: false };
  cfg.model_catalog = { ...(cfg.model_catalog ?? {}), enabled: false };
  cfg.plugins = { ...(cfg.plugins ?? {}), auto_update_check_hours: 0 };
  cfg.stt = { ...(cfg.stt ?? {}), enabled: false };
  cfg.lsp = { ...(cfg.lsp ?? {}), install_strategy: 'manual' };
  // Hermes would otherwise rewrite the machine's `hermes` command to run from this home (see scripts/provision.sh).
  cfg.cli = { ...(cfg.cli ?? {}), expose_on_path: false };
}

// ---------- approvals (Settings > Permissions) ----------

/**
 * How every bot's Hermes asks before risky actions, from its owner's settings. Hermes reads these keys
 * of config.yaml again whenever the file changes, so they are left out of the settings hash and a
 * change reaches running gateways without a restart (syncApprovals).
 *
 *   approvals.mode     off, smart (Hermes' model clears low-risk actions and asks about the rest) or manual
 *   approvals.deny     glob patterns of terminal commands Hermes refuses, whatever the mode ("Never Allow")
 *   command_allowlist  actions an "Always allow" answer cleared ("Allow without Asking"). Hermes adds to the
 *                      asking bot's list itself; every bot gets the union, so an answer counts for all of them.
 */
export interface ApprovalSettings { mode: ApprovalMode; deny: string[] }

const APPROVAL_MODES: ApprovalMode[] = ['off', 'smart', 'manual'];

export function approvalSettings(userId: string): ApprovalSettings {
  const u = db.prepare<[string], Pick<UserRecord, 'approval_mode' | 'approval_deny'>>('SELECT approval_mode, approval_deny FROM users WHERE id=?').get(userId);
  const mode = APPROVAL_MODES.find((m) => m === u?.approval_mode) ?? 'off';
  let deny: string[] = [];
  try { deny = (JSON.parse(u?.approval_deny ?? '[]') as unknown[]).filter((p): p is string => typeof p === 'string'); } catch { /* keep none */ }
  return { mode, deny };
}

/** Configs of the owner's bots that have a Hermes home. */
function configFiles(userId: string): string[] {
  return db.prepare<[string], Pick<BotRecord, 'id'>>("SELECT id FROM bots WHERE user_id=? AND engine='managed'").all(userId)
    .map((b) => path.join(homeFor(b.id), 'config.yaml'))
    .filter((f) => fs.existsSync(f));
}

const allowlistOf = (cfg: any): string[] => (Array.isArray(cfg?.command_allowlist) ? cfg.command_allowlist.filter((x: unknown): x is string => typeof x === 'string') : []);

/** "Allow without Asking": every entry an "Always allow" answer left in any of the owner's bots. */
export function allowedActions(userId: string): string[] {
  const all = new Set<string>();
  for (const f of configFiles(userId)) for (const e of allowlistOf(readYaml(f))) all.add(e);
  return [...all].sort((a, b) => a.localeCompare(b));
}

function applyApprovals(cfg: any, s: ApprovalSettings, allowed: string[]) {
  cfg.approvals = { ...(cfg.approvals ?? {}), mode: s.mode, deny: s.deny };
  if (allowed.length) cfg.command_allowlist = allowed;
  else delete cfg.command_allowlist;
}

/** Write the owner's approval settings and the shared allowlist into every bot's config, without restarting anything. */
export function syncApprovals(userId: string, drop?: string) {
  const s = approvalSettings(userId);
  const allowed = allowedActions(userId).filter((e) => e !== drop);
  for (const f of configFiles(userId)) {
    const cfg = readYaml(f);
    const before = JSON.stringify([cfg.approvals, cfg.command_allowlist]);
    applyApprovals(cfg, s, allowed);
    if (JSON.stringify([cfg.approvals, cfg.command_allowlist]) !== before) replacePrivate(f, YAML.stringify(cfg));
  }
}

/** Take an entry out of "Allow without Asking": Hermes asks about that action again, on every bot. */
export function forgetAllowed(userId: string, entry: string) {
  syncApprovals(userId, entry);
}

function soul(b: BotRecord): string {
  const owner = db.prepare<[string], Pick<UserRecord, 'username'>>('SELECT username FROM users WHERE id=?').get(b.user_id)?.username ?? 'the user';
  const role = b.label ? `, ${b.label}` : '';
  return [
    `You are ${b.name}${role}. You work for ${owner} as one of a small team of AI agents, each with its own screen on a shared computer.`,
    b.description ? `\n${b.description}` : '',
    '\nYou are direct, warm and brief. You do the work rather than describe it, and you say plainly what you did and what you could not do.',
    '',
  ].join('\n');
}

/** Rewrite the persona file after a rename or a new description. */
export function syncPersona(botId: string) {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') return;
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  fs.writeFileSync(path.join(home, 'SOUL.md'), soul(b));
}

/** Rewrite every bot's persona after the owner's user name changed (the account was created). */
export function syncPersonas(userId: string) {
  for (const { id } of db.prepare<[string], Pick<BotRecord, 'id'>>('SELECT id FROM bots WHERE user_id=?').all(userId)) syncPersona(id);
}

/** Point a link in the home at the machine's shared copy, replacing whatever Hermes made there on its own. */
function linkToShared(home: string, name: string) {
  fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
  const link = path.join(home, name);
  const target = path.join(HERMES_ROOT, name);
  if (!fs.existsSync(target)) return; // no Hermes installed on this machine
  try {
    if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === target) return;
    fs.rmSync(link, { recursive: true, force: true });
  } catch { /* not there yet */ }
  fs.symlinkSync(target, link);
}

/** Create or refresh the home. config.yaml is created once; after that only the keys we own are patched. */
async function writeHome(botId: string): Promise<{ home: string; key: string; display: string | null; settings: string }> {
  const b = requireBot(botId);
  const home = homeFor(botId);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  fs.chmodSync(home, 0o700);
  linkToShared(home, 'tools');
  linkToShared(home, 'installs');
  for (const p of SHARED_PLUGINS) linkToShared(home, path.join('plugins', p));

  // Its screen decides which display and which Chrome it drives.
  let display: string | null = null;
  let cdp = '';
  try {
    const s = await screenFor(b.user_id, botId);
    display = displayFor(s.screenId);
    cdp = cdpUrlFor(s.screenId);
  } catch (e: any) {
    console.warn(`[engine] no screen for ${b.name} yet: ${e?.message ?? e}`);
  }

  // It works in its Library folder, so what it makes there shows up in the app.
  const cwd = libraryDir(botId);
  fs.mkdirSync(cwd, { recursive: true });

  const from = inheritedHome(botId);
  const cfgFile = path.join(home, 'config.yaml');
  const fresh = !fs.existsSync(cfgFile);
  const cfg = fresh ? {} : readYaml(cfgFile);
  if (fresh) {
    const primary = from ? readYaml(path.join(from, 'config.yaml')) : {};
    for (const k of SHARED_CONFIG) if (primary[k] !== undefined) cfg[k] = primary[k];
    cfg.agent = { reasoning_effort: 'medium' };
  }
  applyManagedConfig(cfg, { bot: b, cwd, display, cdp });
  applyApprovals(cfg, approvalSettings(b.user_id), [...new Set([...allowlistOf(cfg), ...allowedActions(b.user_id)])]);
  replacePrivate(cfgFile, YAML.stringify(cfg));

  if (!fs.existsSync(path.join(home, 'SOUL.md'))) fs.writeFileSync(path.join(home, 'SOUL.md'), soul(b));

  // Subscription sign-ins live in auth.json, and each bot keeps its own: a new home starts without one.
  // A copy would give two bots the same refresh token, and providers rotate it on every refresh (Claude
  // does), so the first bot to refresh signs the other out. A sign-in every bot shares is a token in
  // Settings > Providers, which reaches each home's .env below.

  // .env holds the API server, model credentials and the search backend. Keys the user added by hand are
  // kept. A credential set in Settings > Providers wins; one that isn't stays as this home has it (a
  // bot's own sign-in may have written it there), or comes from the primary bot's home.
  const envFile = path.join(home, '.env');
  const mine = readDotenv(envFile);
  const key = mine.API_SERVER_KEY || crypto.randomBytes(24).toString('hex');
  const primaryEnv = from ? readDotenv(path.join(from, '.env')) : {};
  const vars: Record<string, string> = { ...mine };
  for (const { env: k, value } of secretEnv()) {
    if (value) vars[k] = value;
    else if (!vars[k] && primaryEnv[k]) vars[k] = primaryEnv[k];
  }
  Object.assign(vars, { API_SERVER_ENABLED: 'true', API_SERVER_KEY: key, API_SERVER_PORT: String(b.engine_port), API_SERVER_HOST: '127.0.0.1' });
  if (cdp) vars.BROWSER_CDP_URL = cdp; else delete vars.BROWSER_CDP_URL;
  if (searxngUrl()) vars.SEARXNG_URL = searxngUrl(); else delete vars.SEARXNG_URL;
  writePrivate(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

  const managed: any = {};
  applyManagedConfig(managed, { bot: b, cwd, display, cdp });
  // Hermes reads the default model again when config.yaml changes (syncModel), so choosing another one restarts nothing.
  delete managed.model;
  return { home, key, display, settings: settingsHash(managed, vars) };
}

/** Where a home records the settings hash its gateway started with. */
const SETTINGS_FILE = 'dispatch-settings';

/**
 * A hash of what a gateway reads when it starts and this app decides: the config keys this app owns
 * (but the default model), the .env it writes, the Hermes install (scripts/provision.sh records its pin) and the names of the
 * app's MCP tools, which Hermes lists when it connects. A gateway that outlived this server keeps
 * running only while the hash it started with still matches.
 */
function settingsHash(managed: unknown, vars: Record<string, string>): string {
  let pin = '';
  try { pin = fs.readFileSync(path.join(HERMES_ROOT, '.dispatch-pin'), 'utf8').trim(); } catch { /* not installed by provision.sh */ }
  const tools = TOOLS.map((t) => t.name);
  return crypto.createHash('sha256').update(JSON.stringify({ managed, vars, pin, tools })).digest('hex').slice(0, 20);
}

function startedWith(home: string): string {
  try { return fs.readFileSync(path.join(home, SETTINGS_FILE), 'utf8').trim(); } catch { return ''; }
}

// ---------- a bot's gateway ----------

async function healthy(url: string, timeoutMs = 2500): Promise<any | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function keyAccepted(url: string, key: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

/** HERMES_HOME of a running process, or null when it has none (or is gone). */
function hermesHomeOf(pid: number): string | null {
  try {
    const item = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith('HERMES_HOME='));
    return item ? item.slice('HERMES_HOME='.length) : null;
  } catch { return null; }
}

/**
 * The gateway's pid, but only if the pid file belongs to this home and the process is alive and runs
 * for this home. After a reboot the same pids come round again, so a stale pid file can name
 * another bot's gateway.
 */
function gatewayPid(home: string): number | null {
  let raw = '';
  try { raw = fs.readFileSync(path.join(home, 'gateway.pid'), 'utf8').trim(); } catch { return null; }
  let pid = NaN;
  try {
    const j = JSON.parse(raw);
    if (typeof j === 'number') pid = j;
    else {
      if (j?.hermes_home && path.resolve(j.hermes_home) !== path.resolve(home)) return null;
      pid = Number(j?.pid);
    }
  } catch { pid = Number(raw); }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch { return null; }
  try {
    if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('gateway')) return null;
  } catch { /* no /proc: trust the pid file */ }
  const runsFor = hermesHomeOf(pid);
  if (runsFor && path.resolve(runsFor) !== path.resolve(home)) return null;
  return pid;
}

async function stopGateway(botId: string) {
  warmed.delete(botId);
  const home = homeFor(botId);
  const pid = gatewayPid(home);
  if (!pid) return;
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
  };
  signal('SIGTERM');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { process.kill(pid, 0); } catch { return; }
  }
  signal('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
}

const starting = new Map<string, Promise<void>>();
const failures = new Map<string, string>();
const keys = new Map<string, string>();
/** Bots whose home changed under a running gateway (Settings > Providers): it restarts before its next run. */
const stale = new Set<string>();

function managedUrl(botId: string): string {
  const port = requireBot(botId).engine_port;
  if (!port) throw new Error('This bot has no engine port.');
  return `http://127.0.0.1:${port}`;
}

function managedKey(botId: string): string {
  let k = keys.get(botId);
  if (!k) {
    k = readDotenv(path.join(homeFor(botId), '.env')).API_SERVER_KEY ?? '';
    if (k) keys.set(botId, k);
  }
  return k;
}

async function startGateway(botId: string): Promise<void> {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') throw new Error('This bot has no agent.');
  if (!b.engine_port) db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run(freePort(), botId);
  const url = managedUrl(botId);

  // The home always follows this server's code and environment, even under a running gateway.
  const { home, key, display, settings } = await writeHome(botId);
  keys.set(botId, key);

  if (await healthy(url)) {
    const ours = await keyAccepted(url, key);
    const pid = gatewayPid(home);
    // A gateway from an earlier run of this server stays as it is while it runs on the current
    // settings. So does one whose bot's screen is down right now: restarting it would only take its
    // computer away. One without a pid file can't be stopped, so it stays too.
    if (ours && (startedWith(home) === settings || !display || !pid)) return;
    if (!pid) throw new Error(`Port ${b.engine_port} is taken by something else.`);
    if (ours) console.log(`[engine] ${b.name}: settings changed since its gateway started; restarting it`);
    await stopGateway(botId);
  }
  if (gatewayPid(home)) await stopGateway(botId);
  fs.writeFileSync(path.join(home, SETTINGS_FILE), `${settings}\n`);

  const log = fs.openSync(path.join(home, 'logs', 'gateway.out.log'), 'a');
  warmed.delete(botId);
  const child = spawn(HERMES_BIN, ['gateway', 'run', '--no-supervise'], {
    cwd: home,
    detached: true,
    stdio: ['ignore', log, log],
    env: hermesEnv(home, {
      HERMES_GATEWAY_LOCK_DIR: path.join(home, 'locks'),
      // Hermes' browser tool talks to a helper process it finds under this folder. With the default
      // (one folder per HOME) every bot would end up driving the same browser.
      BH_HOME: path.join(home, 'browser-harness'),
      ...(display ? { DISPLAY: display } : {}),
    }),
  });
  fs.closeSync(log);
  let exited: string | null = null;
  child.once('error', (e) => { exited = `could not run ${HERMES_BIN}: ${e.message}`; });
  child.once('exit', (code) => { exited = `the agent stopped while starting (exit ${code}). See ${path.join(home, 'logs', 'gateway.out.log')}`; });
  child.unref();

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) throw new Error(exited);
    if (await healthy(url, 1500)) {
      console.log(`[engine] ${b.name}: gateway up on ${url}`);
      return;
    }
  }
  throw new Error('The agent did not come up within 90 seconds.');
}

/** Start (or adopt) the bot's gateway. Safe to call often; concurrent calls share one start. */
function ensureManaged(botId: string): Promise<void> {
  let p = starting.get(botId);
  if (!p) {
    p = startGateway(botId)
      .then(() => { failures.delete(botId); })
      .catch((e: any) => {
        const msg = String(e?.message ?? e);
        failures.set(botId, msg);
        console.warn(`[engine] ${botId}: ${msg}`);
        throw e;
      })
      .finally(() => starting.delete(botId));
    starting.set(botId, p);
  }
  return p;
}

/** Where to send this bot's turns. Starts its gateway if it is not running. */
export async function engineFor(botId: string): Promise<Engine> {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  if (b.engine !== 'managed' || !b.engine_port) {
    if (b.kind === 'room') throw new Error('A group chat has no agent of its own.');
    assignEngine(botId);
  }
  const url = managedUrl(botId);
  // A start under way (a restart for new settings among them) is waited for, not raced.
  if (stale.delete(botId) || starting.has(botId) || !(await healthy(url, 1500)) || !managedKey(botId)) await ensureManaged(botId);
  return { url, key: managedKey(botId), home: homeFor(botId) };
}

// ---------- the first run on a gateway ----------

/**
 * Hermes loads a provider's SDK (the Anthropic one, at least) the first time a run needs it, and two
 * runs that both load it at the same moment can collide: one fails with "The 'anthropic' package is
 * required", which Hermes then reports for that run. That happens right after a gateway starts, when
 * a chat turn and a voice reply (or two voice replies) begin together. So the first run on a gateway
 * this process hasn't seen answer yet goes alone, and the others wait until Hermes has begun answering
 * it: by then the SDK is loaded. At most WARM_WAIT_MS, so a run that never answers holds no one long.
 */
const warmed = new Set<string>();
const warming = new Map<string, Promise<void>>();
const WARM_WAIT_MS = 30_000;
/** The events a run sends before Hermes builds its agent (api_server.py `_run_and_signal`). */
const BEFORE_AGENT = new Set(['run.queued', 'run.started', 'message.started']);

/**
 * Wait for this bot's gateway to take a new run. Returns the function to call with each event of the
 * run, and once with nothing when it ends; it lets the next run start once this one is answering.
 */
export async function runSlot(botId: string): Promise<(event?: unknown) => void> {
  for (;;) {
    if (warmed.has(botId)) return () => {};
    const first = warming.get(botId);
    if (!first) break;
    await first;
  }
  let open!: () => void;
  const gate = new Promise<void>((res) => { open = res; });
  warming.set(botId, gate);
  const release = () => {
    clearTimeout(timer);
    if (warming.get(botId) === gate) warming.delete(botId);
    open();
  };
  const timer = setTimeout(release, WARM_WAIT_MS);
  timer.unref();
  return (event?: unknown) => {
    if (event === undefined) return release();
    if (typeof event === 'string' && !BEFORE_AGENT.has(event)) { warmed.add(botId); release(); }
  };
}

/** A bot's provider or model changed: make it its Hermes' default now. Hermes reads config.yaml again when it changes. */
export function syncModel(botId: string) {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') return;
  const file = path.join(homeFor(botId), 'config.yaml');
  if (!fs.existsSync(file)) return;
  const cfg = readYaml(file);
  const before = JSON.stringify(cfg.model ?? null);
  applyModel(cfg, b);
  if (JSON.stringify(cfg.model ?? null) !== before) replacePrivate(file, YAML.stringify(cfg));
}

/**
 * Settings > Providers changed. A gateway keeps the credentials it started with in its environment, so
 * every one restarts on the new settings before its next run (engineFor). A credential taken out of
 * Settings also leaves every home now, where the home still holds that same value: a bot's own sign-in
 * stays. Returns the bots with a gateway, to restart now when they are idle.
 */
export function refreshEngines(removed: { env: string; value: string }[]): string[] {
  const ids = db.prepare<[], Pick<BotRecord, 'id'>>("SELECT id FROM bots WHERE engine='managed'").all().map((b) => b.id);
  for (const id of ids) {
    const file = path.join(homeFor(id), '.env');
    const vars = readDotenv(file);
    const kept = Object.entries(vars).filter(([k, v]) => !removed.some((r) => r.env === k && r.value === v));
    if (kept.length !== Object.keys(vars).length) replacePrivate(file, kept.map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    stale.add(id);
  }
  optionsCache.clear();
  endpointCache.clear();
  return ids;
}

/** The bot's Hermes home, without starting anything (memory files, sign-ins). */
export function engineHome(botId: string): string | null {
  return hasEngine(botId) ? homeFor(botId) : null;
}

/**
 * Hermes can run a private screen of its own for a profile (its "Bot Desktop": an Xvnc display with
 * state in <home>/bot-desktop). While that screen is up, the agent's computer-use tool acts there and
 * not on the screen this app shows (so does its browser tool, unless the config pins it to a Chrome
 * with `browser.cdp_url`), so the user could be watching an idle desktop.
 */
export function ownScreenOn(botId: string): boolean {
  const home = engineHome(botId);
  if (!home) return false;
  const dir = path.join(home, 'bot-desktop');
  try {
    // launcher.pid holds "<pid> <create time>"; the env file appears once the screen is usable.
    const pid = Number(fs.readFileSync(path.join(dir, 'launcher.pid'), 'utf8').trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 1 || !fs.existsSync(path.join(dir, 'env'))) return false;
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Ask Hermes to stop that private screen. Hermes refuses while a person is using it; the refusal is passed on. */
export function stopOwnScreen(botId: string): Promise<void> {
  const home = engineHome(botId);
  if (!home) return Promise.reject(new Error('This bot has no agent.'));
  return new Promise((resolve, reject) => {
    execFile(HERMES_BIN, ['computer-use', 'screen', 'stop'], { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 }, (err, stdout, stderr) => {
      if (!ownScreenOn(botId)) return resolve();
      const said = `${stderr || ''}\n${stdout || ''}`.trim().split('\n').filter(Boolean).pop();
      reject(new Error(said || (err ? String(err.message) : 'The screen is still running.')));
    });
  });
}

/** Start the gateway in the background (after creating a bot, or on server start). */
export function provisionEngine(botId: string) {
  if (hasEngine(botId)) ensureManaged(botId).catch(() => {});
}

export async function restartEngine(botId: string): Promise<void> {
  if (!hasEngine(botId)) return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  optionsCache.delete(botId);
  provisionEngine(botId);
}

/** The bot is gone: stop its gateway and delete its home. */
/**
 * The bot is gone (its row already deleted, see deleteBot): stop its gateway and delete its home.
 * `port` is the gateway's port, kept from new bots until the gateway has stopped.
 */
export async function removeEngine(botId: string, port: number | null): Promise<void> {
  if (port) retiringPorts.add(port);
  try {
    const home = homeFor(botId);
    if (!fs.existsSync(home)) return;
    await starting.get(botId)?.catch(() => {});
    await stopGateway(botId);
    keys.delete(botId);
    failures.delete(botId);
    optionsCache.delete(botId);
    if (path.resolve(home).startsWith(path.resolve(env.enginesDir) + path.sep)) fs.rmSync(home, { recursive: true, force: true });
  } finally {
    if (port) retiringPorts.delete(port);
  }
}

/** On server start: give older bots an engine, then bring the gateways up. */
export function initEngines() {
  fs.mkdirSync(env.enginesDir, { recursive: true });
  // A bot that ran on the separately managed "primary" agent (before this app ran every agent) gets one of its own.
  db.prepare("UPDATE bots SET engine=NULL, engine_port=NULL WHERE engine='primary'").run();
  const bots = db.prepare<[], Pick<BotRecord, 'id'>>("SELECT id FROM bots WHERE engine IS NULL AND kind <> 'room' AND hidden=0 ORDER BY is_primary DESC, created_at ASC").all();
  for (const b of bots) assignEngine(b.id);
  for (const b of db.prepare<[], Pick<BotRecord, 'id'>>("SELECT id FROM bots WHERE engine='managed'").all()) provisionEngine(b.id);
}

// ---------- what the settings panel shows ----------

/**
 * The model providers a bot can run on, in the panel's order, under their Hermes ids. ChatGPT, Grok and
 * Copilot sign in with a link and a code (`signIn`, signin.ts): ChatGPT and Grok into each bot's own
 * home, Copilot into the token in Settings > Providers that every bot shares. Claude runs only on the
 * token from `claude setup-token` in Settings > Providers: a sign-in for each bot gave every bot a
 * refresh token of its own to keep alive. API keys and the self-hosted address are set in Settings >
 * Providers too. `endpoint` marks the two Dispatch declares itself (applyEndpoints).
 */
const PROVIDERS: { id: string; name: string; kind: EngineProvider['kind']; signIn?: boolean; endpoint?: Endpoint }[] = [
  { id: 'anthropic', name: 'Claude', kind: 'subscription' },
  { id: 'openai-codex', name: 'ChatGPT', kind: 'subscription', signIn: true },
  { id: 'xai-oauth', name: 'Grok', kind: 'subscription', signIn: true },
  { id: 'copilot', name: 'GitHub Copilot', kind: 'subscription', signIn: true },
  { id: 'anthropic-api', name: 'Anthropic API', kind: 'api_key', endpoint: 'anthropic-api' },
  { id: 'openai-api', name: 'OpenAI API', kind: 'api_key' },
  { id: 'gemini', name: 'Google Gemini', kind: 'api_key' },
  { id: 'xai', name: 'xAI API', kind: 'api_key' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'api_key' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'api_key' },
  { id: 'self-hosted', name: 'Self-hosted', kind: 'endpoint', endpoint: 'self-hosted' },
];

type Endpoint = 'anthropic-api' | 'self-hosted';

const endpointCache = new Map<Endpoint, { at: number; models: string[]; error: string | null }>();

/**
 * The models one of Dispatch's endpoints lists, asked directly: Hermes only asks the endpoint a bot is on
 * now. Kept for a minute. Nothing to ask (no address or key) is no models and no error.
 */
export async function endpointModels(id: Endpoint): Promise<{ models: string[]; error: string | null }> {
  const hit = endpointCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  let url = '';
  let headers: Record<string, string> = {};
  if (id === 'self-hosted') {
    const base = getSetting('self-hosted-url');
    const key = getSetting('self-hosted-key');
    if (base) url = `${base}/models`;
    if (key) headers = { Authorization: `Bearer ${key}` };
  } else {
    const key = getSetting('anthropic-api');
    if (key) url = `${ANTHROPIC_API}/v1/models?limit=100`;
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  if (!url) return { models: [], error: null };
  let out: { models: string[]; error: string | null };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    const body: any = await r.json().catch(() => null);
    const models = Array.isArray(body?.data) ? body.data.map((m: any) => m?.id).filter((m: unknown): m is string => typeof m === 'string' && !!m) : [];
    if (!r.ok) out = { models: [], error: `${url} answered HTTP ${r.status}${typeof body?.error?.message === 'string' ? `: ${body.error.message}` : ''}` };
    else out = models.length ? { models, error: null } : { models: [], error: `${url} lists no models` };
  } catch (e: any) {
    out = { models: [], error: `Couldn’t reach ${url}: ${e?.cause?.code ?? e?.message ?? e}` };
  }
  endpointCache.set(id, { at: Date.now(), ...out });
  return out;
}

/** The name of a provider that signs in with a code (signin.ts), or null for one that doesn't (a key, a token, or not ours). */
export function signInName(provider: string): string | null {
  const p = PROVIDERS.find((x) => x.id === provider);
  return p?.signIn ? p.name : null;
}

const optionsCache = new Map<string, { at: number; data: any }>();

async function modelOptions(botId: string, e: { url: string; key: string }): Promise<any | null> {
  const hit = optionsCache.get(botId);
  if (hit && Date.now() - hit.at < 15_000) return hit.data;
  try {
    const r = await fetch(`${e.url}/api/model/options`, { headers: e.key ? { Authorization: `Bearer ${e.key}` } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    optionsCache.set(botId, { at: Date.now(), data });
    return data;
  } catch { return null; }
}

/**
 * Our providers with what the bot's Hermes reports about them (signed in, the models it suggests); one
 * Hermes leaves out counts as not connected. Dispatch's own endpoints list the models their server lists.
 */
async function toProviders(data: any): Promise<EngineProvider[]> {
  const list: any[] = Array.isArray(data?.providers) ? data.providers : [];
  return Promise.all(PROVIDERS.map(async (p): Promise<EngineProvider> => {
    const h = list.find((x) => x?.slug === p.id);
    const featured = Array.isArray(h?.featured_models) && h.featured_models.length ? h.featured_models : Array.isArray(h?.models) ? h.models : [];
    let models: string[] = featured.filter((m: unknown) => typeof m === 'string');
    if (p.endpoint && h) {
      const listed = (await endpointModels(p.endpoint)).models;
      if (listed.length) models = listed;
    }
    if (p.id === 'deepseek' && !models.includes(DEFAULT_DEEPSEEK_MODEL)) models.unshift(DEFAULT_DEEPSEEK_MODEL);
    return { id: p.id, name: p.name, kind: p.kind, signIn: !!p.signIn, connected: !!h?.authenticated, models };
  }));
}

export async function engineInfo(botId: string): Promise<EngineInfo> {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  const engine = hasEngine(botId);
  const base: Omit<EngineInfo, 'status'> = { botId, profile: botId, error: null, model: b.model ?? null, provider: b.provider ?? null, version: null, providers: [], ownScreen: engine ? ownScreenOn(botId) : false };
  if (!engine) return { ...base, status: 'error', error: 'This bot has no agent.' };
  if (!b.engine_port) return { ...base, status: 'error', error: 'No port assigned.' };
  const e = { url: managedUrl(botId), key: managedKey(botId) };

  const health = await healthy(e.url);
  if (!health) {
    if (starting.has(botId)) return { ...base, status: 'starting' };
    const failed = failures.get(botId);
    if (failed) return { ...base, status: 'error', error: failed };
    provisionEngine(botId);
    return { ...base, status: 'starting' };
  }
  if (starting.has(botId)) return { ...base, status: 'starting' };

  const data = await modelOptions(botId, e);
  return {
    ...base,
    status: 'ready',
    version: typeof health.version === 'string' && health.version !== 'unknown' ? health.version : null,
    model: b.model ?? data?.model ?? null,
    provider: b.provider ?? data?.provider ?? null,
    providers: await toProviders(data),
  };
}

/** After a sign-in the provider list changes; drop what we remembered. */
export function forgetEngineOptions(botId: string) { optionsCache.delete(botId); }
