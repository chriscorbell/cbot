import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

/**
 * The database and its whole schema. Every table and column the app uses is declared here and
 * nowhere else, so importing any module that queries the database is enough to have the schema.
 *
 * To change the schema, append a migration to MIGRATIONS. Never edit one that has shipped: a
 * database records how many it has run in `PRAGMA user_version` and runs only the newer ones.
 */

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const now = () => Date.now();

// ---------- records: what a SELECT * gives back, column for column ----------
// Type a query with them, e.g. db.prepare<[string], BotRecord>('SELECT * FROM bots WHERE id=?').get(id),
// and keep them in step with MIGRATIONS below. SQLite booleans are 0 or 1.

export interface UserRecord {
  id: string;
  /** The account: the name the owner signs in with and goes by, and a scrypt hash of the password (lib/auth.ts). Null until the first visit creates it. */
  username: string | null;
  password_hash: string | null;
  avatar_url: string | null;
  created_at: number;
  /** Hermes' approvals for every bot (Settings > Permissions): 'off', 'smart' or 'manual' ("Ask"). */
  approval_mode: string;
  /** JSON array of glob patterns Hermes refuses as terminal commands (its approvals.deny), "Never Allow". */
  approval_deny: string;
  /** When the first-run setup finished: the web app's wizard that makes the first bot (bots.ts). Null until then. */
  setup_at: number | null;
}

export interface BotRecord {
  id: string;
  user_id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatar_shape: string;
  avatar_color: string;
  mode: string;
  is_primary: number;
  /** No longer read or written: pinning bots in the rail was removed. Old rows keep their value. */
  pinned: number;
  effort: string;
  /** Bumped by "New chat"; rows and the engine's conversation belong to one generation. */
  generation: number;
  /** The seq the next row of this generation gets. */
  next_seq: number;
  /** Revision counter for the bot's rows: every append or rewrite takes the next one (rows.updated_seq). */
  rev: number;
  unread: number;
  created_at: number;
  updated_at: number;
  voice: string;
  voice_speed: number;
  model: string | null;
  provider: string | null;
  engine: string | null;
  engine_port: number | null;
  handback_at: number | null;
  sidebar_hidden: number;
  kind: 'agent' | 'room';
  /** JSON array of member bot ids, for a room. */
  members: string | null;
  parent_bot_id: string | null;
  hidden: number;
  /**
   * How far into the current chat its agent has been told about rows it did not write (a voice call's
   * record, what a call posted): the last seq told. agent/catchup.ts reads and moves it; "New chat"
   * starts it again at 0.
   */
  told_seq: number;
}

export interface RowRecord { bot_id: string; generation: number; seq: number; updated_seq: number; kind: string; body: string; created_at: number }

export interface ScreenRecord { bot_id: string; user_id: string; screen_id: string; last_used_at: number }

export interface ApprovalRecord {
  id: string; bot_id: string;
  /** The card's row. Approvals from before migration 5 have no generation: their card is in the chat that was current. */
  generation: number | null; row_seq: number;
  /** Hermes' prompt id; older approvals kept a tool call id here. */
  call_id: string; tool: string;
  status: 'pending' | 'allowed' | 'always' | 'denied' | 'expired';
  created_at: number; resolved_at: number | null;
}

export interface RoutineRecord {
  id: string; bot_id: string; name: string; prompt: string; schedule: string; timezone: string;
  enabled: number; last_run_at: number | null; created_at: number;
}


export interface SkillRecord { id: string; bot_id: string; name: string; body: string; description: string; created_at: number; updated_at: number | null }

export interface ProactivityRecord {
  user_id: string; enabled: number; times: string; timezone: string;
  /** "<local date> <slot>" of the last check-in that fired, so a slot fires once a day. */
  last_fired: string | null;
  /** Unused: nothing counts silent check-ins any more. */
  silent_streak: number; updated_at: number;
}

/** One of the app's settings (settings.ts owns the keys). A key with no row is unset. */
export interface SettingRecord { key: string; value: string; updated_at: number }

function hasColumn(table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

function addColumn(table: string, col: string, ddl: string) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

const MIGRATIONS: (() => void)[] = [
  // 1. The schema as it stood when migrations started. Databases from before then may already have
  // any part of it, so every step is idempotent. Older databases also hold tables nothing reads any
  // more (llm_items, pending_turns, memories, memory_jobs, compactions); they are left alone.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        avatar_url TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      -- A bot's screen lease (computer.ts). It outlives the server; the display behind it is restarted on use.
      CREATE TABLE IF NOT EXISTS screens (
        bot_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        screen_id TEXT NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        avatar_shape TEXT NOT NULL DEFAULT 'blob',
        avatar_color TEXT NOT NULL DEFAULT 'blue',
        mode TEXT NOT NULL DEFAULT 'personal',
        is_primary INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        effort TEXT NOT NULL DEFAULT 'medium',
        generation INTEGER NOT NULL DEFAULT 1,
        next_seq INTEGER NOT NULL DEFAULT 1,
        rev INTEGER NOT NULL DEFAULT 0,
        unread INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rows (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        updated_seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, generation, seq)
      );
      CREATE INDEX IF NOT EXISTS rows_rev ON rows(bot_id, updated_seq);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        row_seq INTEGER NOT NULL,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS policies (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        mode TEXT NOT NULL,
        PRIMARY KEY (user_id, tool)
      );
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'working',
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      -- Check-ins for the primary bot (proactive.ts), one row per user.
      CREATE TABLE IF NOT EXISTS proactivity (
        user_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        times TEXT NOT NULL DEFAULT '["09:00","16:30"]',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        last_fired TEXT,
        silent_streak INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    // Voice settings. Databases from before the local speech service also have an unused voice_language.
    addColumn('bots', 'voice', "TEXT NOT NULL DEFAULT 'harper'");
    addColumn('bots', 'voice_speed', 'REAL NOT NULL DEFAULT 1');
    // The bot's model choice; null is the engine's default.
    addColumn('bots', 'model', 'TEXT');
    addColumn('bots', 'provider', 'TEXT');
    // Its Hermes engine: 'managed' (a gateway this app runs, see engine.ts) or null before one is assigned,
    // and the gateway's port.
    addColumn('bots', 'engine', 'TEXT');
    addColumn('bots', 'engine_port', 'INTEGER');
    // When the user handed the screen back after taking control; the next turn is told, then it is cleared.
    addColumn('bots', 'handback_at', 'INTEGER');
    // "Hide from sidebar": the bot keeps working and can be found with Search, which shows it again.
    addColumn('bots', 'sidebar_hidden', 'INTEGER NOT NULL DEFAULT 0');
    // 'agent', or 'room' for a group chat, whose `members` is a JSON array of bot ids (agent/rooms.ts).
    addColumn('bots', 'kind', "TEXT NOT NULL DEFAULT 'agent'");
    addColumn('bots', 'members', 'TEXT');
    // Subagents of an earlier version were hidden child bots. None are made any more, but old ones
    // may still exist: hidden bots stay out of the roster, the team and the bot count.
    addColumn('bots', 'parent_bot_id', 'TEXT');
    addColumn('bots', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('skills', 'description', "TEXT NOT NULL DEFAULT ''");
    addColumn('skills', 'updated_at', 'INTEGER');
    // Older databases kept a hosted computer's status here, from before the bots' computer was the machine cbot runs on.
    db.exec('DROP TABLE IF EXISTS computers');
  },
  // 2. The account lives in the database instead of the server's environment (CBOT_USER, CBOT_PASSWORD
  // before). Both stay null until the first visit creates the account.
  () => {
    addColumn('users', 'username', 'TEXT');
    addColumn('users', 'password_hash', 'TEXT');
  },
  // 3. A user is just a user name: the email (a placeholder nobody used) and the separate display name
  // go. SQLite can't drop a UNIQUE column in place, so the table is rebuilt; migrate() keeps foreign
  // keys off meanwhile, so dropping the old table cascades to nothing.
  () => {
    db.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        username TEXT,
        password_hash TEXT,
        avatar_url TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO users_new(id, username, password_hash, avatar_url, created_at)
        SELECT id, username, password_hash, avatar_url, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  },
  // 4. Tasks are gone: the bots no longer track work as tasks, and the app no longer lists them.
  () => {
    db.exec('DROP TABLE IF EXISTS tasks');
  },
  // 5. Approvals are Hermes' prompts again (agent/approvals.ts): a card names the conversation it is in,
  // and the owner chooses how the bots ask and which commands they never run. Off keeps what ran before.
  () => {
    // Every database that ran migration 1 has this table; one built by hand for a test may not.
    db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        row_seq INTEGER NOT NULL,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `);
    addColumn('approvals', 'generation', 'INTEGER');
    addColumn('users', 'approval_mode', "TEXT NOT NULL DEFAULT 'off'");
    addColumn('users', 'approval_deny', "TEXT NOT NULL DEFAULT '[]'");
  },
  // 6. Model credentials, the self-hosted endpoint and SearXNG are set in the app (Settings > Providers)
  // instead of the server's environment. settings.ts copies what the environment still has on first start.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  },
  // 7. A group's About is the user's to write, and its bots now read it. The app used to fill it in as
  // "Group chat with N Bots" and rewrite it whenever the members changed, so that text goes.
  () => {
    db.exec("UPDATE bots SET description='' WHERE kind='room' AND description GLOB 'Group chat with [0-9]* Bots'");
  },
  // 8. Where each chat's agent is in hearing about voice calls (agent/catchup.ts). Existing chats start
  // caught up, so the first turn after this doesn't retell every call they ever had.
  () => {
    addColumn('bots', 'told_seq', 'INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE bots SET told_seq = next_seq - 1');
  },
  // 9. A fresh install no longer starts with a bot: after the account is created, the web app's setup
  // wizard makes the first one. Accounts made before then already have their bots, so they are past it.
  () => {
    addColumn('users', 'setup_at', 'INTEGER');
    db.exec('UPDATE users SET setup_at = created_at WHERE password_hash IS NOT NULL');
  },
];

function migrate() {
  const ran = db.pragma('user_version', { simple: true }) as number;
  if (ran >= MIGRATIONS.length) return;
  // A migration may rebuild a table. With foreign keys on, dropping the old one would delete every row
  // that refers to it (ON DELETE CASCADE), so they are off while migrations run; the setting can only
  // change outside a transaction. Each migration checks the references before it commits.
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = ran; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        MIGRATIONS[v]();
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length) throw new Error(`migration ${v + 1} broke ${broken.length} foreign key reference(s)`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

migrate();
