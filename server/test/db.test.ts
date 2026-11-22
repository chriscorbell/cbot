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
  assert.equal(db.pragma('user_version', { simple: true }), 6);
  assert.deepEqual(tables(db), ['approvals', 'auth_sessions', 'bots', 'deleted_bots', 'proactivity', 'push_devices', 'push_keys', 'routines', 'rows', 'runs', 'screens', 'settings', 'skills', 'tasks', 'team_log', 'turns', 'users', 'workspaces']);
  for (const col of ['kind', 'members', 'voice', 'engine', 'engine_port', 'handback_at', 'sidebar_hidden', 'told_seq', 'team_seen']) {
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
  assert.equal(d.pragma('user_version', { simple: true }), 6);
  // References cascade once the migrations are done.
  assert.equal(d.pragma('foreign_keys', { simple: true }), 1);
  d.close();
});

test('a database from another version is refused with a way to start over, and left as it was', () => {
  // The development versions before the schema was folded into one migration recorded nine.
  const { d, file } = database("CREATE TABLE bots (id TEXT PRIMARY KEY, hidden INTEGER); INSERT INTO bots VALUES ('bot_1', 0); PRAGMA user_version = 9;");
  assert.throws(() => migrate(d, file), (e: Error) => {
    assert.match(e.message, /was made by another version of Dispatch \(schema 9; this version knows 6\)/);
    assert.match(e.message, /docker compose -p dispatch-dev down -v/);
    return true;
  });
  assert.deepEqual(tables(d), ['bots']);
  assert.equal(d.pragma('user_version', { simple: true }), 9);
  d.close();

  // So is one with tables but no version at all, from before versions were recorded.
  const old = database("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT); INSERT INTO users VALUES ('usr_1', 'a@localhost');");
  assert.throws(() => migrate(old.d, old.file), /schema 0; this version knows 6/);
  assert.deepEqual(tables(old.d), ['users']);
  old.d.close();
});

test('a database from before the task board gets it, and its bots have heard no team news yet', () => {
  const { d, file } = database();
  // The schema as the last release before the task board left it: three migrations, one bot.
  migrate(d, file, 3);
  d.exec("INSERT INTO users(id,created_at) VALUES ('usr_1', 0); INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES ('bot_1','usr_1','Ada',0,0);");
  migrate(d, file);
  assert.equal(d.pragma('user_version', { simple: true }), 6);
  assert.deepEqual(d.prepare('SELECT id, team_seen FROM bots').all(), [{ id: 'bot_1', team_seen: 0 }]);
  assert.ok(tables(d).includes('tasks') && tables(d).includes('team_log'));
  d.close();
});

test('a database from before workspaces puts everything it had in one called Personal, check-ins too', () => {
  const { d, file } = database();
  migrate(d, file, 4);
  d.exec(`
    INSERT INTO users(id,created_at) VALUES ('usr_1', 5);
    INSERT INTO bots(id,user_id,name,is_primary,created_at,updated_at) VALUES ('bot_1','usr_1','Ada',1,0,0);
    INSERT INTO bots(id,user_id,name,kind,members,created_at,updated_at) VALUES ('room_1','usr_1','Crew','room','["bot_1"]',0,0);
    INSERT INTO tasks(id,user_id,title,owner_id,created_at,updated_at) VALUES ('task_1','usr_1','Ship it','bot_1',0,0);
    INSERT INTO team_log(user_id,text,created_at) VALUES ('usr_1','Ada joined the team.',0);
    INSERT INTO proactivity(user_id,enabled,times,timezone,last_fired,updated_at) VALUES ('usr_1',1,'["08:00"]','Europe/Paris','2026-11-21 08:00',0);
  `);
  migrate(d, file);
  assert.equal(d.pragma('user_version', { simple: true }), 6);
  const ws = d.prepare('SELECT * FROM workspaces').all() as { id: string; user_id: string; name: string; task_board: number; created_at: number }[];
  assert.equal(ws.length, 1);
  assert.deepEqual({ ...ws[0], id: undefined }, { id: undefined, user_id: 'usr_1', name: 'Personal', task_board: 1, position: 0, created_at: 5, updated_at: 5 });
  const id = ws[0].id;
  assert.deepEqual(d.prepare('SELECT workspace_id FROM bots ORDER BY id').all(), [{ workspace_id: id }, { workspace_id: id }]);
  assert.deepEqual(d.prepare('SELECT workspace_id FROM tasks').all(), [{ workspace_id: id }]);
  assert.deepEqual(d.prepare('SELECT workspace_id FROM team_log').all(), [{ workspace_id: id }]);
  assert.deepEqual(d.prepare('SELECT * FROM proactivity').all(), [{ workspace_id: id, enabled: 1, times: '["08:00"]', timezone: 'Europe/Paris', last_fired: '2026-11-21 08:00', updated_at: 0 }]);
  d.close();
});

test('a device that takes notifications goes when the session that turned them on ends', () => {
  const { d, file } = database();
  migrate(d, file);
  d.pragma('foreign_keys = ON');
  d.exec(`
    INSERT INTO users(id,created_at) VALUES ('usr_1', 0);
    INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES ('s1','usr_1',0,1), ('s2','usr_1',0,1);
    INSERT INTO push_devices(endpoint,user_id,session,p256dh,auth,created_at,updated_at) VALUES ('https://push.example/a','usr_1','s1','k','a',0,0), ('https://push.example/b','usr_1','s2','k','a',0,0);
  `);
  d.exec("DELETE FROM auth_sessions WHERE token='s1'");
  assert.deepEqual(d.prepare('SELECT endpoint FROM push_devices').all(), [{ endpoint: 'https://push.example/b' }]);
  d.close();
});
