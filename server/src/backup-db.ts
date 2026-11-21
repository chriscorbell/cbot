/**
 * Copies SQLite databases that may be in use, for scripts/backup.sh:
 *
 *   node server/dist/backup-db.js <from> <to> [<from> <to> ...]
 *
 * A database in WAL mode keeps recent writes in its -wal file, so copying the files while the server
 * or a gateway writes can catch them halfway. SQLite's own backup copies a consistent state instead,
 * without stopping anything. Each copy that fails is named on stderr and the exit code is 1; the
 * others are still made. Imports nothing of the server's, so it needs none of its settings.
 */
import Database from 'better-sqlite3';
import { errorText } from './lib/errors.js';

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error('usage: node backup-db.js <from> <to> [<from> <to> ...]');
  process.exit(2);
}
let failed = 0;
for (let i = 0; i < args.length; i += 2) {
  try {
    const d = new Database(args[i], { readonly: true, fileMustExist: true });
    try {
      await d.backup(args[i + 1]);
    } finally {
      d.close();
    }
  } catch (e) {
    console.error(`${args[i]}: ${errorText(e)}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
