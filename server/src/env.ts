import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A random secret made on first start and kept in the data directory, readable only by us.
 * It signs the tokens the agents present to /mcp, so it has to survive restarts and upgrades.
 */
function generatedSecret(file: string): string {
  let s = '';
  try { s = fs.readFileSync(file, 'utf8').trim(); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
  if (s) return s;
  s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${s}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return s;
}

/** TZ when it names a time zone (from .env.prod on the host, .env in the dev container), else UTC. Schedules without a zone of their own use it. */
function localTimeZone(): string {
  const tz = process.env.TZ?.trim();
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

const dataDir = path.resolve(process.env.DATA_DIR ?? new URL('../../data', import.meta.url).pathname);

export const env = {
  port: Number(process.env.PORT ?? 8787),
  /** The address to listen on; every address when unset. On the host it is 127.0.0.1, because Tailscale Serve holds the port on the tailnet address. */
  host: process.env.HOST?.trim() || undefined,
  /** HTTPS=1: serve HTTPS on the same port with Dispatch's own certificate (https.ts), for a machine reached on the local network. The installer sets it. */
  https: process.env.HTTPS === '1',
  /** Database, generated secret and the bots' Hermes homes. */
  dataDir,
  dbPath: path.join(dataDir, 'dispatch.db'),
  /** Signs the tokens the agents use to reach /mcp. */
  appSecret: generatedSecret(path.join(dataDir, 'secret')),
  /** Each bot's own Hermes home (see engine.ts). */
  enginesDir: path.join(dataDir, 'engines'),
  /** Bots on the team. Each one has a screen, a Chrome and a Hermes gateway running, so this is a cap on memory. */
  maxBots: Number(process.env.MAX_BOTS ?? 4),
  /** The server's IANA time zone: routines and check-ins default to it, and every bot's Hermes uses it. */
  timeZone: localTimeZone(),
  /** The speech service (speech/README.md), on its internal Docker network: deploy/dispatch.service and compose.yaml set it. */
  speechUrl: (process.env.SPEECH_URL || 'http://speech:8000').replace(/\/+$/, ''),
};
