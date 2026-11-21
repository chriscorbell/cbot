import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db } from '../src/db.js';

const columns = (d: Database.Database, table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

test('a fresh database gets the whole schema and records its version', () => {
  assert.ok((db.pragma('user_version', { simple: true }) as number) >= 1);
  for (const col of ['kind', 'members', 'hidden', 'parent_bot_id', 'voice', 'engine', 'engine_port', 'handback_at', 'sidebar_hidden', 'told_seq']) {
    assert.ok(columns(db, 'bots').includes(col), `bots.${col}`);
  }
  assert.ok(columns(db, 'proactivity').includes('silent_streak'));
  assert.ok(columns(db, 'skills').includes('description'));
  assert.deepEqual(columns(db, 'users'), ['id', 'username', 'password_hash', 'avatar_url', 'created_at', 'approval_mode', 'approval_deny', 'setup_at']);
  assert.ok(columns(db, 'approvals').includes('generation'));
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='tasks'").get(), undefined);
  assert.deepEqual(columns(db, 'settings'), ['key', 'value', 'updated_at']);
});

test('a database from before migrations is brought up to date without losing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-legacy-'));
  const old = new Database(path.join(dir, 'dispatch.db'));
  // The shape of a production database from before migrations: no group-chat or subagent columns yet,
  // and tables nothing reads any more.
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar_url TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE bots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '', avatar_shape TEXT NOT NULL DEFAULT 'blob', avatar_color TEXT NOT NULL DEFAULT 'blue', mode TEXT NOT NULL DEFAULT 'personal',
      is_primary INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, effort TEXT NOT NULL DEFAULT 'medium', generation INTEGER NOT NULL DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1, rev INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      voice TEXT NOT NULL DEFAULT 'harper');
    CREATE TABLE llm_items (bot_id TEXT, generation INTEGER, idx INTEGER, item TEXT);
    CREATE TABLE computers (id TEXT);
    INSERT INTO users VALUES ('usr_1', 'a@localhost', 'A', NULL, 1);
    INSERT INTO bots(id, user_id, name, next_seq, created_at, updated_at) VALUES ('bot_1', 'usr_1', 'Ada', 8, 1, 1);
  `);
  old.close();

  // db.ts migrates on import; run it in a process of its own, pointed at the old database.
  execFileSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/db.ts')"], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dir },
  });

  const after = new Database(path.join(dir, 'dispatch.db'));
  assert.equal(after.pragma('user_version', { simple: true }), 9);
  assert.ok(columns(after, 'bots').includes('kind'));
  assert.ok(columns(after, 'bots').includes('hidden'));
  assert.deepEqual(after.prepare("SELECT name, kind, hidden FROM bots WHERE id='bot_1'").get(), { name: 'Ada', kind: 'agent', hidden: 0 });
  // Its chat starts caught up on voice calls: the turn after the upgrade retells none.
  assert.equal((after.prepare("SELECT told_seq FROM bots WHERE id='bot_1'").get() as { told_seq: number }).told_seq, 7);
  assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE name='llm_items'").get(), 'unused tables are left alone');
  assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE name='computers'").get(), undefined);
  // The owner from the environment-credentials days has no account until the next visit creates it,
  // and then goes through the setup wizard, which starts from the bot it has. Approvals stay off, as they were.
  assert.deepEqual(after.prepare("SELECT * FROM users WHERE id='usr_1'").get(), {
    id: 'usr_1', username: null, password_hash: null, avatar_url: null, created_at: 1, approval_mode: 'off', approval_deny: '[]', setup_at: null,
  });
  after.close();
});

test('rebuilding the users table keeps every row that refers to it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-v2-'));
  const old = new Database(path.join(dir, 'dispatch.db'));
  // A database at version 2: users still has email and name, and other tables delete with their user.
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar_url TEXT, created_at INTEGER NOT NULL, username TEXT, password_hash TEXT);
    CREATE TABLE auth_sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE bots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'agent', next_seq INTEGER NOT NULL DEFAULT 1);
    INSERT INTO users VALUES ('usr_1', 'chris@localhost', 'Chris', NULL, 1, 'Chris', 'scrypt:x');
    INSERT INTO auth_sessions VALUES ('tok', 'usr_1', 1, 9999999999999);
    INSERT INTO bots(id, user_id, name) VALUES ('bot_1', 'usr_1', 'Ada');
    PRAGMA user_version = 2;
  `);
  old.close();

  execFileSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/db.ts')"], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dir },
  });

  const after = new Database(path.join(dir, 'dispatch.db'));
  assert.equal(after.pragma('user_version', { simple: true }), 9);
  assert.deepEqual(columns(after, 'users'), ['id', 'username', 'password_hash', 'avatar_url', 'created_at', 'approval_mode', 'approval_deny', 'setup_at']);
  // An account that existed before the setup wizard is past it.
  assert.deepEqual(after.prepare('SELECT id, username, password_hash, setup_at FROM users').all(), [{ id: 'usr_1', username: 'Chris', password_hash: 'scrypt:x', setup_at: 1 }]);
  assert.deepEqual(after.prepare('SELECT id FROM bots').all(), [{ id: 'bot_1' }]);
  assert.deepEqual(after.prepare('SELECT token FROM auth_sessions').all(), [{ token: 'tok' }]);
  // The references now point at the new table, and still cascade.
  after.pragma('foreign_keys = ON');
  assert.equal((after.prepare('PRAGMA foreign_key_list(bots)').get() as { table: string }).table, 'users');
  after.prepare("DELETE FROM users WHERE id='usr_1'").run();
  assert.equal((after.prepare('SELECT COUNT(*) AS n FROM bots').get() as { n: number }).n, 0);
  after.close();
});

test("a group's generated About is cleared, and one the user wrote is kept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-v6-'));
  const old = new Database(path.join(dir, 'dispatch.db'));
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE bots (id TEXT PRIMARY KEY, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', next_seq INTEGER NOT NULL DEFAULT 1);
    INSERT INTO bots(id, kind, description) VALUES ('room_1', 'room', 'Group chat with 3 Bots'), ('room_2', 'room', 'Keeps the servers up'), ('bot_1', 'agent', 'Group chat with 3 Bots');
    PRAGMA user_version = 6;
  `);
  old.close();

  execFileSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/db.ts')"], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dir },
  });

  const after = new Database(path.join(dir, 'dispatch.db'));
  assert.equal(after.pragma('user_version', { simple: true }), 9);
  assert.deepEqual(after.prepare('SELECT id, description FROM bots ORDER BY id').all(), [
    { id: 'bot_1', description: 'Group chat with 3 Bots' },
    { id: 'room_1', description: '' },
    { id: 'room_2', description: 'Keeps the servers up' },
  ]);
  after.close();
});
