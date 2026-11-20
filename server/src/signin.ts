import { spawn } from 'node:child_process';
import { newId } from './lib/ids.js';
import { engineHome, forgetEngineOptions, HERMES_BIN, hermesEnv, signInName } from './engine.js';
import { saveProviderSettings } from './providers.js';
import type { ProviderSignIn } from './contract.js';

/**
 * Signing in to a subscription with a code, so nothing happens on a bot's screen. ChatGPT, Grok and
 * GitHub Copilot all use the OAuth device flow: the provider hands out a link and a short code, the
 * user opens the link on any device where they're signed in, enters the code and approves, and the
 * sign-in, asking every few seconds meanwhile, gets its tokens.
 *
 * ChatGPT and Grok run `hermes auth add <provider>` for the bot's Hermes home, in the background with
 * no terminal. It prints the link and the code, read from its output here, and saves the sign-in in
 * that home's auth.json itself. Each bot signs in on its own: these providers replace the refresh token
 * on every refresh, so bots sharing one would sign each other out (engine.ts).
 *
 * Copilot's is GitHub's device flow, run here with the OAuth app the github-copilot plugin signs in
 * with. GitHub's token doesn't rotate, so it becomes the Copilot token in Settings > Providers, which
 * every bot uses.
 *
 * A sign-in is starting (no code yet; startSignIn waits that out), then waiting (link and code shown),
 * then done, failed or cancelled, once. One runs per bot, and one for Copilot: asking again for the
 * same one while it waits gives back the same code, and asking for another provider cancels it. A
 * finished sign-in is kept a few minutes for the browser's last look, then forgotten.
 */

type Status = 'starting' | ProviderSignIn['status'];

interface Session {
  id: string;
  userId: string;
  /** What it signs in: `bot:<id>` for one bot's home, `copilot` for the token every bot shares. */
  slot: string;
  provider: string;
  name: string;
  status: Status;
  url: string;
  code: string;
  error: string | null;
  endedAt: number | null;
  /** Settles once the link and code are known, or the sign-in ended first. */
  ready: Promise<void>;
  settle: () => void;
  /** Stops what the sign-in runs. */
  stop: () => void;
  timers: NodeJS.Timeout[];
}

const sessions = new Map<string, Session>();

/** How long a provider gets to give a code. A home's first `hermes` run prepares its Python before that. */
const READY_MS = 60_000;
/** The codes last 15 minutes at all three providers; a sign-in still waiting after that has failed. */
const LIFETIME_MS = 15 * 60_000;
/** How long a finished sign-in can still be asked about. */
const KEEP_MS = 10 * 60_000;

const GITHUB = 'https://github.com';
/** The OAuth app the github-copilot plugin signs in with (its COPILOT_OAUTH_CLIENT_ID), so GitHub gives a token Copilot takes. */
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_ERRORS: Record<string, string> = {
  expired_token: 'The code expired. Start again.',
  access_denied: 'The sign-in was turned down on GitHub.',
};

/**
 * Starts signing in to `provider`, one that engine.ts marks `signIn`: into `botId`'s home for ChatGPT
 * and Grok, into Settings > Providers for Copilot. Resolves once the provider has given its link and
 * code, or with the sign-in failed (and why) if it ended first.
 */
export async function startSignIn(userId: string, provider: string, botId: string | null): Promise<ProviderSignIn> {
  prune();
  const name = signInName(provider);
  if (!name) throw new Error(`${provider} doesn’t sign in with a code.`);
  const shared = provider === 'copilot';
  const home = !shared && botId ? engineHome(botId) : null;
  if (!shared && !home) throw new Error('This bot has no agent.');
  const slot = shared ? 'copilot' : `bot:${botId}`;
  let s = [...sessions.values()].find((x) => x.slot === slot && x.endedAt === null);
  if (s && (s.provider !== provider || s.userId !== userId)) {
    end(s, 'cancelled');
    s = undefined;
  }
  if (!s) {
    const made = open(userId, slot, provider, name);
    if (shared) {
      copilot(made).catch((e: any) => { end(made, 'failed', `The GitHub sign-in failed: ${e?.message ?? e}`); });
    } else {
      hermes(made, home!, botId!);
    }
    s = made;
  }
  await s.ready;
  return view(s);
}

/** A sign-in this user started, or null when there is none (or it was forgotten). */
export function getSignIn(userId: string, id: string): ProviderSignIn | null {
  prune();
  const s = sessions.get(id);
  return s && s.userId === userId ? view(s) : null;
}

/** Cancels a sign-in this user started. False when there is no such sign-in; one already over stays as it ended. */
export function cancelSignIn(userId: string, id: string): boolean {
  const s = sessions.get(id);
  if (!s || s.userId !== userId) return false;
  end(s, 'cancelled');
  return true;
}

/** Cancels a bot's sign-in before its home goes (bots.ts). */
export function cancelBotSignIns(botId: string) {
  for (const s of sessions.values()) if (s.slot === `bot:${botId}`) end(s, 'cancelled');
}

function open(userId: string, slot: string, provider: string, name: string): Session {
  let settle!: () => void;
  const ready = new Promise<void>((resolve) => { settle = resolve; });
  const s: Session = { id: newId('signin'), userId, slot, provider, name, status: 'starting', url: '', code: '', error: null, endedAt: null, ready, settle, stop: () => {}, timers: [] };
  s.timers.push(
    setTimeout(() => { if (s.status === 'starting') end(s, 'failed', `${name} didn’t give a code in time. Try again.`); }, READY_MS),
    setTimeout(() => { end(s, 'failed', 'The code expired. Start again.'); }, LIFETIME_MS),
  );
  sessions.set(s.id, s);
  return s;
}

/** The provider gave its link and code: the user can go and approve. */
function shown(s: Session, url: string, code: string) {
  if (s.status !== 'starting') return;
  s.url = url;
  s.code = code;
  s.status = 'waiting';
  s.settle();
}

/** Ends a sign-in, once: a later end (the process closing after a cancel, say) changes nothing. */
function end(s: Session, status: 'done' | 'failed' | 'cancelled', error: string | null = null): boolean {
  if (s.endedAt !== null) return false;
  s.status = status;
  s.error = error;
  s.endedAt = Date.now();
  for (const t of s.timers) clearTimeout(t);
  try { s.stop(); } catch { /* already gone */ }
  s.settle();
  return true;
}

function prune() {
  const before = Date.now() - KEEP_MS;
  for (const [id, s] of sessions) if (s.endedAt !== null && s.endedAt < before) sessions.delete(id);
}

function view(s: Session): ProviderSignIn {
  return { id: s.id, provider: s.provider, name: s.name, status: s.status === 'starting' ? 'waiting' : s.status, url: s.url, code: s.code, error: s.error };
}

// ---------- ChatGPT and Grok: Hermes signs the bot's home in ----------

function hermes(s: Session, home: string, botId: string) {
  // No terminal and no browser: Hermes prints the link and the code, and the user opens them on their own device.
  const child = spawn(HERMES_BIN, ['auth', 'add', s.provider], {
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: hermesEnv(home, { BROWSER: 'true', PYTHONUNBUFFERED: '1', NO_COLOR: '1' }),
  });
  let out = '';
  const read = (chunk: Buffer) => {
    out = (out + chunk.toString('utf8')).slice(-8000);
    const found = s.status === 'starting' ? deviceCode(out) : null;
    if (found) shown(s, found.url, found.code);
  };
  child.stdout?.on('data', read);
  child.stderr?.on('data', read);
  child.once('error', (e) => { end(s, 'failed', `Couldn’t run Hermes: ${e.message}`); });
  child.once('close', (code) => {
    if (code === 0) {
      // What the agent reports changes now: the panel asks it again instead of using what it remembered.
      forgetEngineOptions(botId);
      end(s, 'done');
    } else {
      end(s, 'failed', lastLine(out) ?? `Hermes stopped (exit ${code ?? 'by signal'}).`);
    }
  });
  s.stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const URL_RE = /https:\/\/[^\s"'<>]+/g;
/** Device codes look like SJ18-ITJ1B or GSFD-VAWQ. */
const CODE_RE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/;

/**
 * The link and the code in what a Hermes sign-in printed, once whole lines hold both. The link is the
 * last one before the code (ChatGPT prints it on a line above; Grok's has the code in it).
 */
export function deviceCode(text: string): { url: string; code: string } | null {
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).replace(ANSI, '');
  const code = CODE_RE.exec(lines);
  if (!code) return null;
  const url = [...lines.matchAll(URL_RE)].filter((m) => m.index <= code.index).at(-1)?.[0].replace(/[.,;:)\]]+$/, '');
  return url ? { url, code: code[0] } : null;
}

/** The last thing a sign-in printed, which says why it failed. */
function lastLine(text: string): string | null {
  const line = text.replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  return line ? line.slice(0, 300) : null;
}

// ---------- Copilot: GitHub's device flow, into Settings > Providers ----------

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function github(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(`${GITHUB}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data: unknown = await r.json().catch(() => null);
  if (!r.ok || !data || typeof data !== 'object') throw new Error(`GitHub answered HTTP ${r.status}`);
  return data as Record<string, unknown>;
}

async function copilot(s: Session): Promise<void> {
  const start = await github('/login/device/code', { client_id: COPILOT_CLIENT_ID, scope: 'read:user' });
  const device = str(start.device_code);
  if (!device || !str(start.user_code)) throw new Error('GitHub gave no code.');
  shown(s, str(start.verification_uri) || `${GITHUB}/login/device`, str(start.user_code));
  // A second more than GitHub asks for, so a slow clock doesn't earn a slow_down.
  let every = Math.max(Number(start.interval) || 5, 1) + 1;
  while (s.endedAt === null) {
    await wait(every * 1000);
    if (s.endedAt !== null) return;
    let r: Record<string, unknown>;
    try {
      r = await github('/login/oauth/access_token', { client_id: COPILOT_CLIENT_ID, device_code: device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    } catch {
      continue; // a network blip is one more wait
    }
    if (s.endedAt !== null) return;
    const token = str(r.access_token);
    if (token) {
      saveProviderSettings({ 'copilot-token': token });
      end(s, 'done');
      return;
    }
    const error = str(r.error);
    if (error === 'slow_down') every = Number(r.interval) > 0 ? Number(r.interval) + 1 : every + 5;
    else if (error && error !== 'authorization_pending') end(s, 'failed', GITHUB_ERRORS[error] ?? `GitHub refused the sign-in (${error}).`);
  }
}
