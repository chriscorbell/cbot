import fs from 'node:fs';
import path from 'node:path';
import { db, type BotRecord } from './db.js';
import { env } from './env.js';
import { deleteBot } from './bots.js';
import { forgetAllBotFiles } from './computer.js';

/**
 * Resetting cbot to a fresh install (Settings > General > Reset cbot), in two parts:
 *  1. takeDown: every bot is deleted the way removing one deletes it (bots.ts deleteBot: its turn,
 *     call, routines, gateway, Hermes home, screen, Chrome profile and Library). The reply waits for it.
 *  2. eraseAndExit, once the reply is out: what is left of the bots' files, then the database, the
 *     generated secret and the Hermes homes go, and the process exits. Its supervisor starts it again
 *     (Restart=always in deploy/cbot.service, the container's restart policy in development), and the
 *     new process starts as a fresh install does: no account, so the next visit makes one and the
 *     setup wizard follows.
 * Starting over in a new process, rather than clearing tables in this one, leaves no state behind in
 * memory. What the bots installed on the computer stays, and so do the logs.
 */

let teardown: Promise<void> | null = null;
let erasing = false;

/** Delete every bot, groups and hidden ones too. A second call waits for the first. */
export function takeDown(): Promise<void> {
  teardown ??= (async () => {
    const bots = db.prepare<[], BotRecord>("SELECT * FROM bots ORDER BY kind='room' DESC, created_at").all();
    for (const b of bots) await deleteBot(b);
    console.log(`[reset] took down ${bots.length} bot(s)`);
  })();
  return teardown;
}

/** What the data directory holds (env.ts): the database and its old copies, the secret, the Hermes homes. */
const DATA = /^(cbot\.db.*|secret|auth-fingerprint|engines)$/;

/** Erase the rest and exit for the supervisor to start a fresh server. Only the first call does anything. */
export async function eraseAndExit(): Promise<void> {
  if (erasing) return;
  erasing = true;
  await forgetAllBotFiles().catch((e) => console.warn('[reset] bot files:', e?.message ?? e));
  db.close();
  for (const name of fs.readdirSync(env.dataDir)) {
    if (DATA.test(name)) fs.rmSync(path.join(env.dataDir, name), { recursive: true, force: true });
  }
  console.log('[reset] data erased; exiting to start again as a fresh install');
  process.exit(0);
}
