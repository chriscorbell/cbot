import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

const SCRIPT = new URL('../src/backup-db.ts', import.meta.url).pathname;
const backup = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });

test('a database in use is copied whole, writes still in its log among them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-backup-'));
  const live = new Database(path.join(dir, 'live.db'));
  live.pragma('journal_mode = WAL');
  live.pragma('wal_autocheckpoint = 0');
  live.exec('CREATE TABLE rows (n INTEGER)');
  live.prepare('INSERT INTO rows VALUES (?)').run(1);
  live.prepare('INSERT INTO rows VALUES (?)').run(2);
  // The rows are in live.db-wal, not live.db: a copy of live.db alone would have no table at all.
  expect(fs.statSync(path.join(dir, 'live.db-wal')).size).toBeGreaterThan(0);

  backup(path.join(dir, 'live.db'), path.join(dir, 'copy.db'));
  const copy = new Database(path.join(dir, 'copy.db'), { readonly: true });
  expect(copy.prepare('SELECT n FROM rows ORDER BY n').pluck().all()).toEqual([1, 2]);
  copy.close();
  live.close();
});

test('a file that is not a database is named and fails the copy, and the others are still made', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-backup-'));
  fs.writeFileSync(path.join(dir, 'notes.db'), 'plain text, not SQLite');
  const good = new Database(path.join(dir, 'good.db'));
  good.exec('CREATE TABLE t (x)');
  good.close();
  let failure = '';
  try {
    backup(path.join(dir, 'notes.db'), path.join(dir, 'notes.copy'), path.join(dir, 'good.db'), path.join(dir, 'good.copy'));
  } catch (e) {
    failure = String((e as { stderr?: string }).stderr);
  }
  expect(failure).toContain('notes.db');
  expect(fs.existsSync(path.join(dir, 'good.copy'))).toBe(true);
});
