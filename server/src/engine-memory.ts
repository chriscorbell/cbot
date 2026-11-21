import fs from 'node:fs';
import path from 'node:path';
import { db, type BotRecord } from './db.js';
import { hub } from './lib/hub.js';
import { sha256 } from './lib/ids.js';
import { withFileLock } from './lib/flock.js';
import { engineHome } from './engine.js';
import type { Memory } from './types.js';

/**
 * What a bot remembers lives in its Hermes home, not in our database: `memories/MEMORY.md` (the
 * agent's own notes) and `memories/USER.md` (what it knows about the user). Each file is a list of
 * entries separated by a line holding only "§". The app shows them and lets the user remove one.
 * Hermes writes both with its memory tool, during a turn or in the review it runs after every ten or
 * so messages, and reads them into the prompt when a conversation starts, so a removal shows from the
 * next conversation on. The files keep no dates, so neither do the entries.
 *
 * Removing an entry works the way Hermes' own writes do (tools/memory_tool_store.py `_mutate`): hold
 * the flock on `<file>.lock`, read the file again, write the rest to a temporary file and rename it
 * over. Without the lock, a removal racing a save by the bot would undo one or the other.
 */

const SEP = '\n§\n';
// About the user first. The keys are part of every memory id, so they stay as they are.
const FILES = [
  { key: 'u', file: 'USER.md', source: 'user' as const },
  { key: 'm', file: 'MEMORY.md', source: 'notes' as const },
];

/**
 * The entries of a memory file, stripped, without empty or repeated ones (Hermes drops repeats too).
 * Strict reads fail on bytes that aren't UTF-8, as Hermes' do, so a rewrite never saves a mangled copy.
 */
function read(file: string, strict = false): { entries: string[]; ok: boolean } {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    return { entries: [], ok: (e as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  let text: string;
  try {
    // TextDecoder drops a leading byte-order mark, like Python's utf-8-sig.
    text = new TextDecoder('utf-8', { fatal: strict }).decode(raw);
  } catch {
    return { entries: [], ok: false };
  }
  return { entries: [...new Set(text.split(SEP).map((e) => e.trim()).filter(Boolean))], ok: true };
}

function writeAtomic(file: string, text: string) {
  const tmp = path.join(path.dirname(file), `.mem_dispatch_${process.pid}_${path.basename(file)}`);
  const mode = fs.statSync(file).mode & 0o777;
  fs.writeFileSync(tmp, text);
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// Bot ids never contain a dot, so it separates the parts of a memory id.
const idFor = (botId: string, key: string, text: string) => `mem.${botId}.${key}.${sha256(text).slice(0, 16)}`;

export function listMemories(botId: string): Memory[] {
  const home = engineHome(botId);
  if (!home) return [];
  const out: Memory[] = [];
  for (const f of FILES) {
    const { entries } = read(path.join(home, 'memories', f.file));
    for (const text of entries) out.push({ id: idFor(botId, f.key, text), botId, text, source: f.source });
  }
  return out;
}

/** The bot a memory id belongs to, so the caller can check who owns it. */
export function memoryBot(id: string): string | null {
  const parts = id.split('.');
  return parts.length === 4 && parts[0] === 'mem' ? parts[1] : null;
}

/**
 * Remove one entry. False when it isn't there any more: removed already, or changed by the bot since
 * the list was read. Throws when Hermes holds the file for too long or the file can't be read safely.
 */
export async function deleteMemory(id: string): Promise<boolean> {
  const botId = memoryBot(id);
  const home = botId ? engineHome(botId) : null;
  if (!botId || !home) return false;
  const f = FILES.find((x) => x.key === id.split('.')[2]);
  if (!f) return false;
  const file = path.join(home, 'memories', f.file);
  if (!fs.existsSync(file)) return false;
  return withFileLock(`${file}.lock`, 10, () => {
    const { entries, ok } = read(file, true);
    if (!ok) throw new Error(`${f.file} can’t be read safely, so it was left as it is.`);
    const keep = entries.filter((text) => idFor(botId, f.key, text) !== id);
    if (keep.length === entries.length) return false;
    writeAtomic(file, keep.join(SEP));
    return true;
  });
}

// ---------- telling open views when a bot's memory changes ----------

/** Each bot's memory files as last seen: inode, size and mtime of both, so a rewrite or a rename shows. */
const seen = new Map<string, string>();

function signature(home: string): string {
  return FILES.map((f) => {
    try {
      const s = fs.statSync(path.join(home, 'memories', f.file));
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return '-';
    }
  }).join('|');
}

/**
 * One look at every bot's memory files. A bot whose files changed since the last look gets a
 * `memories` event, so an open Memories tab shows what the bot saved during a turn or in its review.
 * The first look only records what is there.
 */
export function checkMemories() {
  const bots = db.prepare<[], Pick<BotRecord, 'id' | 'user_id'>>("SELECT id, user_id FROM bots WHERE engine='managed'").all();
  const live = new Set<string>();
  for (const b of bots) {
    const home = engineHome(b.id);
    if (!home) continue;
    live.add(b.id);
    const sig = signature(home);
    const prev = seen.get(b.id);
    seen.set(b.id, sig);
    if (prev !== undefined && prev !== sig) hub.emit(b.user_id, { type: 'memories', botId: b.id });
  }
  for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
}

/** Look every few seconds. Hermes writes the files from its own process, so there is nothing to hook into. */
export function initMemoryWatch() {
  checkMemories();
  setInterval(checkMemories, 3000).unref();
}
