import { db, now, type SettingRecord } from './db.js';
import type { SecretId, SecretState } from './contract.js';

/**
 * The app's settings that used to come from the server's environment (Settings > Providers): model
 * keys and subscription tokens, the self-hosted model endpoint and the SearXNG address. engine.ts
 * writes them into every bot's Hermes home, and voice.ts reads the DeepSeek key for call summaries.
 *
 * Each one is a row in `settings`; no row means unset. The first start with this table copies what the
 * environment still sets (importEnvironment), so an existing .env keeps working. After that the
 * environment is not read for them: they change in the app.
 */

/** A secret: its key in `settings`, the variable a bot's Hermes reads it from, and where it came from before. */
interface Secret { id: SecretId; env: string; fromEnv?: string }

export const SECRETS: readonly Secret[] = [
  // Not ANTHROPIC_API_KEY: Hermes would use that for the Claude subscription too, ahead of a bot's own
  // sign-in. The key reaches Hermes through the `anthropic-api` endpoint engine.ts declares.
  { id: 'anthropic-api', env: 'CBOT_ANTHROPIC_API_KEY', fromEnv: 'ANTHROPIC_API_KEY' },
  { id: 'openai-api', env: 'OPENAI_API_KEY', fromEnv: 'OPENAI_API_KEY' },
  { id: 'gemini', env: 'GEMINI_API_KEY', fromEnv: 'GEMINI_API_KEY' },
  { id: 'xai', env: 'XAI_API_KEY', fromEnv: 'XAI_API_KEY' },
  { id: 'openrouter', env: 'OPENROUTER_API_KEY', fromEnv: 'OPENROUTER_API_KEY' },
  { id: 'deepseek', env: 'DEEPSEEK_API_KEY', fromEnv: 'DEEPSEEK_API_KEY' },
  // Subscription tokens: one sign-in for every bot instead of signing each in on its screen.
  { id: 'claude-token', env: 'CLAUDE_CODE_OAUTH_TOKEN', fromEnv: 'CLAUDE_CODE_OAUTH_TOKEN' },
  { id: 'copilot-token', env: 'COPILOT_GITHUB_TOKEN', fromEnv: 'COPILOT_GITHUB_TOKEN' },
  { id: 'self-hosted-key', env: 'CBOT_SELF_HOSTED_API_KEY' },
];

export const SECRET_IDS = SECRETS.map((s) => s.id);

export type SettingKey = SecretId | 'self-hosted-url' | 'searxng-url';

/** Marks a database whose environment values were copied in. */
const IMPORTED = 'env-imported';

const readRow = db.prepare<[string], Pick<SettingRecord, 'value'>>('SELECT value FROM settings WHERE key=?');
const writeRow = db.prepare<[string, string, number]>('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at');
const deleteRow = db.prepare<[string]>('DELETE FROM settings WHERE key=?');

/** The setting's value, or '' when it is unset. */
export function getSetting(key: SettingKey): string {
  return readRow.get(key)?.value ?? '';
}

/** Set each key given; '' unsets it. Returns the keys whose value changed, with what they held before. */
export function putSettings(patch: Partial<Record<SettingKey, string>>): Map<SettingKey, string> {
  const changed = new Map<SettingKey, string>();
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch) as [SettingKey, string | undefined][]) {
      if (value === undefined) continue;
      const before = getSetting(key);
      if (before === value) continue;
      if (value) writeRow.run(key, value, now()); else deleteRow.run(key);
      changed.set(key, before);
    }
  })();
  return changed;
}

/** Whether a secret is set, and enough of its end to tell two keys apart. The secret itself never leaves the server. */
export function secretState(id: SecretId): SecretState {
  const v = getSetting(id);
  return { set: !!v, ending: v.length >= 16 ? v.slice(-4) : '' };
}

/** The variables a bot's Hermes reads its credentials from, with the value of each one set here. */
export function secretEnv(): { env: string; value: string }[] {
  return SECRETS.map((s) => ({ env: s.env, value: getSetting(s.id) }));
}

/** The .env variable a secret is written to. */
export const envOf = (id: SecretId) => SECRETS.find((s) => s.id === id)!.env;

/**
 * Copy what the server's environment sets into settings, once per database. A later change to the
 * environment is not read: by then these are set in the app.
 */
export function importEnvironment() {
  if (readRow.get(IMPORTED)) return;
  const copied: string[] = [];
  db.transaction(() => {
    const take = (key: SettingKey, name: string) => {
      const v = process.env[name]?.trim();
      if (!v || getSetting(key)) return;
      writeRow.run(key, v, now());
      copied.push(name);
    };
    for (const s of SECRETS) if (s.fromEnv) take(s.id, s.fromEnv);
    take('searxng-url', 'SEARXNG_URL');
    writeRow.run(IMPORTED, '1', now());
  })();
  if (copied.length) console.log(`[settings] copied ${copied.join(', ')} from the environment; they are set in Settings > Providers from now on`);
}

/**
 * A key or token as it may go into a .env line: printable ASCII and no spaces, so it can't end the
 * line or start a comment. Null when it isn't one.
 */
export function cleanSecret(raw: string): string | null {
  const v = raw.trim();
  return /^[\x21-\x7e]{1,1000}$/.test(v) ? v : null;
}

/** An http(s) address, without a fragment or a trailing slash. Null when it isn't one. */
export function cleanUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v) || v.length > 500) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}
