import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { newId } from './lib/ids.js';

/**
 * The database and its whole schema. Every table and column the app uses is declared here and
 * nowhere else, so importing any module that queries the database is enough to have the schema.
 *
 * To change the schema, append a migration to MIGRATIONS. Never edit one that has shipped: a
 * database records how many it has run in `PRAGMA user_version` and runs only the newer ones.
 */

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
// The data folder (the database, the secret, the setup code) is the server's alone: the bots' account
// (account.ts) can't read it without sudo, whatever made the folder (a Docker volume starts at 0755).
fs.chmodSync(path.dirname(env.dbPath), 0o700);
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
  /** The workspace whose team it is on (workspaces.ts). Every bot and group chat has one. */
  workspace_id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatar_shape: string;
  avatar_color: string;
  is_primary: number;
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
  /**
   * How far into the current chat its agent has been told about rows it did not write (a voice call's
   * record, what a call posted): the last seq told. agent/catchup.ts reads and moves it; "New chat"
   * starts it again at 0.
   */
  told_seq: number;
  /** The last entry of `team_log` the bot's agent has been told (agent/team.ts). A new bot starts at the newest. */
  team_seen: number;
}

export interface RowRecord { bot_id: string; generation: number; seq: number; updated_seq: number; kind: string; body: string; created_at: number }

export interface ScreenRecord { bot_id: string; user_id: string; screen_id: string; last_used_at: number }

export interface ApprovalRecord {
  id: string; bot_id: string;
  /** The card's row: its chat and seq. */
  generation: number; row_seq: number;
  /** Hermes' prompt id. */
  call_id: string; tool: string;
  status: 'pending' | 'allowed' | 'always' | 'denied' | 'expired';
  created_at: number; resolved_at: number | null;
}

export interface RoutineRecord {
  id: string; bot_id: string; name: string; prompt: string; schedule: string; timezone: string;
  enabled: number; last_run_at: number | null; created_at: number;
}


export interface SkillRecord { id: string; bot_id: string; name: string; body: string; description: string; created_at: number; updated_at: number | null }

/** Check-ins for a workspace's primary bot (proactive.ts), one row per workspace that has set them. */
export interface ProactivityRecord {
  workspace_id: string; enabled: number; times: string; timezone: string;
  /** "<local date> <slot>" of the last check-in that fired, so a slot fires once a day. */
  last_fired: string | null;
  updated_at: number;
}

/** One of the app's settings (settings.ts owns the keys). A key with no row is unset. */
export interface SettingRecord { key: string; value: string; updated_at: number }

/**
 * A chat turn queued or running (agent/turns.ts), so a restart finds what the last process left.
 * `trigger` is the turn's Trigger as JSON; `run_id` is its Hermes run once Hermes has it.
 */
export interface TurnRecord { id: number; bot_id: string; generation: number; trigger: string; run_id: string | null; created_at: number }

/** A Hermes run started and not yet seen to end (agent/runs.ts), by Hermes' run id. */
export interface RunRecord { id: string; bot_id: string; surface: 'chat' | 'voice' | 'summary' | 'ask'; started_at: number }

/**
 * A bot whose row is gone while what ran for it is still being taken down (deleteBot in bots.ts).
 * A restart finishes the job; its gateway's port goes to no other bot until then.
 */
export interface DeletedBotRecord { id: string; kind: string; engine_port: number | null; deleted_at: number }

/**
 * A workspace (workspaces.ts): one team of bots with its own primary bot, task board and check-ins.
 * Bots see and reach only the bots of their own workspace. Every account has at least one.
 */
export interface WorkspaceRecord {
  id: string; user_id: string; name: string;
  /** 1 while the workspace uses the task board: its bots get the task tools and the app shows the board. */
  task_board: number;
  /** Its place in the switcher, lowest first. */
  position: number;
  created_at: number; updated_at: number;
}

/** A task on the team's board (agent/team.ts). `status` is a TaskStatus. */
export interface TaskRecord {
  id: string; user_id: string; workspace_id: string; title: string; notes: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  /** The bot whose task it is; null while nobody has it. */
  owner_id: string | null;
  /** The name of the owner that was removed from the team, while the task waits for a new one. */
  previous_owner: string | null;
  /** The bot that put it on the board and its name then; both null when the user did. */
  created_by: string | null; creator_name: string | null;
  created_at: number; updated_at: number;
}

/**
 * Something the team's agents are told at the start of their next turn (agent/team.ts): a bot joined or
 * left, a task changed hands or got done. `audience` is the one bot it is for, or null for every bot but
 * `actor_id`, the bot it is about.
 */
export interface TeamLogRecord { id: number; user_id: string; workspace_id: string; actor_id: string | null; audience: string | null; text: string; created_at: number }

/**
 * The schema, one migration per change. The first is the whole schema as it stood before the first
 * release with real installs: the migrations that led there were folded into it once, when the only
 * install was about to be wiped, and the tables and columns nothing used any more went with them.
 * From here on migrations are append-only again: never edit one that has shipped.
 */
const MIGRATIONS: ((d: Database.Database) => void)[] = [
  // 1. The schema.
  (d) => {
    d.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        -- The account: the name the owner signs in with, and a scrypt hash of the password (lib/auth.ts).
        username TEXT,
        password_hash TEXT,
        avatar_url TEXT,
        created_at INTEGER NOT NULL,
        -- Hermes' approvals for every bot (Settings > Permissions), and the commands they never run.
        -- Smart to start: the bot's model clears low-risk actions and asks about the rest.
        approval_mode TEXT NOT NULL DEFAULT 'smart',
        approval_deny TEXT NOT NULL DEFAULT '[]',
        -- When the first-run setup finished (bots.ts); null until then.
        setup_at INTEGER
      );
      CREATE TABLE auth_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      -- A bot's screen lease (computer.ts). It outlives the server; the display behind it is restarted on use.
      CREATE TABLE screens (
        bot_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        screen_id TEXT NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        avatar_shape TEXT NOT NULL DEFAULT 'blob',
        avatar_color TEXT NOT NULL DEFAULT 'blue',
        is_primary INTEGER NOT NULL DEFAULT 0,
        effort TEXT NOT NULL DEFAULT 'medium',
        generation INTEGER NOT NULL DEFAULT 1,
        next_seq INTEGER NOT NULL DEFAULT 1,
        rev INTEGER NOT NULL DEFAULT 0,
        unread INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        voice TEXT NOT NULL DEFAULT 'harper',
        voice_speed REAL NOT NULL DEFAULT 1,
        -- The bot's model choice; null is the engine's default.
        model TEXT,
        provider TEXT,
        -- Its Hermes engine: 'managed' (a gateway this app runs, see engine.ts) or null before one is
        -- assigned, and the gateway's port.
        engine TEXT,
        engine_port INTEGER,
        -- When the user handed the screen back after taking control; the next turn is told, then it is cleared.
        handback_at INTEGER,
        -- "Hide from sidebar": the bot keeps working and can be found with Search, which shows it again.
        sidebar_hidden INTEGER NOT NULL DEFAULT 0,
        -- 'agent', or 'room' for a group chat, whose members is a JSON array of bot ids (agent/rooms.ts).
        kind TEXT NOT NULL DEFAULT 'agent',
        members TEXT,
        -- Where the current chat's agent is in hearing about voice calls (agent/catchup.ts).
        told_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE rows (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        updated_seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, generation, seq)
      );
      CREATE INDEX rows_rev ON rows(bot_id, updated_seq);
      -- Hermes' approval prompts (agent/approvals.ts), each shown as a card in a chat.
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        row_seq INTEGER NOT NULL,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        generation INTEGER NOT NULL
      );
      CREATE TABLE routines (
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
      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        updated_at INTEGER
      );
      -- Check-ins for the primary bot (proactive.ts), one row per user.
      CREATE TABLE proactivity (
        user_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        times TEXT NOT NULL DEFAULT '["09:00","16:30"]',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        last_fired TEXT,
        updated_at INTEGER NOT NULL
      );
      -- Model credentials, the self-hosted endpoint and SearXNG (Settings > Providers, settings.ts).
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  },
  // 2. What a restart finds of the last process's turns and runs (agent/turns.ts, agent/runs.ts).
  (d) => {
    d.exec(`
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        run_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        surface TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
    `);
  },
  // 3. Bots being deleted (bots.ts), so a restart can finish taking down what ran for them.
  (d) => {
    d.exec(`
      CREATE TABLE deleted_bots (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        engine_port INTEGER,
        deleted_at INTEGER NOT NULL
      );
    `);
  },
  // 4. The team's task board, and what each agent is told about changes to the team (agent/team.ts).
  (d) => {
    d.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        -- The bot whose task it is; null while nobody has it. Deleting a bot hands its tasks back first
        -- (bots.ts), and says whose they were in previous_owner.
        owner_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
        previous_owner TEXT,
        -- The bot that put it on the board and its name then; null when the user did.
        created_by TEXT,
        creator_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX tasks_owner ON tasks(owner_id);
      CREATE TABLE team_log (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        actor_id TEXT,
        audience TEXT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      -- The last team_log entry each bot's agent has been told.
      ALTER TABLE bots ADD COLUMN team_seen INTEGER NOT NULL DEFAULT 0;
    `);
  },
  // 5. Workspaces (workspaces.ts): separate teams of bots, each with its own primary bot, task board and
  // check-ins. Every account gets one called Personal, which takes everything it had. Check-ins move from
  // one per account to one per workspace: the table is rebuilt with the same rows, keyed by workspace.
  (d) => {
    d.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        task_board INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX workspaces_user ON workspaces(user_id, position);
    `);
    const users = d.prepare<[], { id: string; created_at: number }>('SELECT id, created_at FROM users').all();
    const add = d.prepare('INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)');
    for (const u of users) add.run(newId('ws'), u.id, 'Personal', u.created_at, u.created_at);
    d.exec(`
      -- A workspace with bots can't be deleted from under them: workspaces.ts deletes its bots first.
      ALTER TABLE bots ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
      UPDATE bots SET workspace_id = (SELECT id FROM workspaces w WHERE w.user_id = bots.user_id);
      CREATE INDEX bots_workspace ON bots(workspace_id);
      ALTER TABLE tasks ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
      UPDATE tasks SET workspace_id = (SELECT id FROM workspaces w WHERE w.user_id = tasks.user_id);
      ALTER TABLE team_log ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
      UPDATE team_log SET workspace_id = (SELECT id FROM workspaces w WHERE w.user_id = team_log.user_id);
      CREATE INDEX team_log_workspace ON team_log(workspace_id, id);
      CREATE TABLE proactivity_by_workspace (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        times TEXT NOT NULL DEFAULT '["09:00","16:30"]',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        last_fired TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO proactivity_by_workspace(workspace_id,enabled,times,timezone,last_fired,updated_at)
        SELECT w.id, p.enabled, p.times, p.timezone, p.last_fired, p.updated_at FROM proactivity p JOIN workspaces w ON w.user_id = p.user_id;
      DROP TABLE proactivity;
      ALTER TABLE proactivity_by_workspace RENAME TO proactivity;
    `);
  },
];

/**
 * Runs the migrations this database hasn't run yet. A database that records more migrations than
 * this version knows, or has tables but no record at all, was made by another version of Dispatch:
 * most likely a development version from before the schema was folded into one migration. This
 * version can't open it, so it says how to start over instead of guessing.
 */
export function migrate(d: Database.Database, file: string, upTo = MIGRATIONS.length): void {
  const ran = d.pragma('user_version', { simple: true }) as number;
  const tables = (d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n;
  if (ran > MIGRATIONS.length || (ran === 0 && tables > 0)) {
    throw new Error(
      `${file} was made by another version of Dispatch (schema ${ran}; this version knows ${MIGRATIONS.length}), so this one can't open it. ` +
      'Start over with an empty database: install Dispatch again on a fresh machine, or for the dev container run `docker compose -p dispatch-dev down -v`.',
    );
  }
  if (ran >= upTo) return;
  // A migration may rebuild a table. With foreign keys on, dropping the old one would delete every row
  // that refers to it (ON DELETE CASCADE), so they are off while migrations run; the setting can only
  // change outside a transaction. Each migration checks the references before it commits.
  d.pragma('foreign_keys = OFF');
  try {
    for (let v = ran; v < upTo; v++) {
      d.transaction(() => {
        MIGRATIONS[v](d);
        const broken = d.pragma('foreign_key_check') as unknown[];
        if (broken.length) throw new Error(`migration ${v + 1} broke ${broken.length} foreign key reference(s)`);
        d.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    d.pragma('foreign_keys = ON');
  }
}

migrate(db, env.dbPath);
