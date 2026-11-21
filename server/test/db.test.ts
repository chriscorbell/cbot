import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, migrate } from '../src/db.js';

const columns = (d: Database.Database, table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const tables = (d: Database.Database) => (d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);

/** A database file of its own, set up by `sql`. */
function database(sql = ''): { d: Database.Database; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-db-')), 'dispatch.db');
  const d = new Database(file);
  d.exec(sql);
  return { d, file };
}

test('a fresh database gets the whole schema and records its version', () => {
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(tables(db), ['approvals', 'auth_sessions', 'bots', 'proactivity', 'routines', 'rows', 'runs', 'screens', 'settings', 'skills', 'turns', 'users']);
  for (const col of ['kind', 'members', 'voice', 'engine', 'engine_port', 'handback_at', 'sidebar_hidden', 'told_seq']) {
    assert.ok(columns(db, 'bots').includes(col), `bots.${col}`);
  }
  assert.deepEqual(columns(db, 'users'), ['id', 'username', 'password_hash', 'avatar_url', 'created_at', 'approval_mode', 'approval_deny', 'setup_at']);
  assert.ok(columns(db, 'approvals').includes('generation'));
  assert.deepEqual(columns(db, 'settings'), ['key', 'value', 'updated_at']);
});

test('migrating a database that is up to date changes nothing', () => {
  const { d, file } = database();
  migrate(d, file);
  migrate(d, file);
  assert.equal(d.pragma('user_version', { simple: true }), 2);
  // References cascade once the migrations are done.
  assert.equal(d.pragma('foreign_keys', { simple: true }), 1);
  d.close();
});

test('a database from another version is refused with a way to start over, and left as it was', () => {
  // The development versions before the schema was folded into one migration recorded nine.
  const { d, file } = database("CREATE TABLE bots (id TEXT PRIMARY KEY, hidden INTEGER); INSERT INTO bots VALUES ('bot_1', 0); PRAGMA user_version = 9;");
  assert.throws(() => migrate(d, file), (e: Error) => {
    assert.match(e.message, /was made by another version of Dispatch \(schema 9; this version knows 2\)/);
    assert.match(e.message, /docker compose -p dispatch-dev down -v/);
    return true;
  });
  assert.deepEqual(tables(d), ['bots']);
  assert.equal(d.pragma('user_version', { simple: true }), 9);
  d.close();

  // So is one with tables but no version at all, from before versions were recorded.
  const old = database("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT); INSERT INTO users VALUES ('usr_1', 'a@localhost');");
  assert.throws(() => migrate(old.d, old.file), /schema 0; this version knows 2/);
  assert.deepEqual(tables(old.d), ['users']);
  old.d.close();
});
