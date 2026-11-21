import fs from 'node:fs/promises';
import path from 'node:path';
import { db, type BotRecord, type RowRecord } from './db.js';
import type { MessageBody } from './types.js';
import type { SearchFileHit, SearchMessageHit } from './contract.js';

/**
 * Search across a person's bots for the search box: messages in each chat they can see (the current
 * generation; a cleared chat's rows stay in the database but can't be shown), and the files in each
 * bot's Library by name. Bots themselves are matched in the browser, which already has them.
 */

export const MAX_HITS = 30;

/** LIKE treats % and _ as wildcards; a search for "50%" means the text. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Markdown marks that would show as clutter in a one-line excerpt. */
const plain = (text: string) =>
  text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`+/g, '').replace(/^\s{0,3}(#{1,6}|>)\s*/gm, '').replace(/\s+/g, ' ').trim();

/** About a line of text around the first match, cut at word boundaries, with … where it was cut. */
export function excerpt(text: string, q: string, before = 48, after = 110): string {
  const t = plain(text);
  const at = t.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return t.length > before + after ? `${t.slice(0, before + after).replace(/\s+\S*$/, '')}…` : t;
  let start = Math.max(0, at - before);
  let end = Math.min(t.length, at + q.length + after);
  if (start > 0) { const sp = t.indexOf(' ', start); start = sp >= 0 && sp < at ? sp + 1 : start; }
  if (end < t.length) { const sp = t.lastIndexOf(' ', end); end = sp > at + q.length ? sp : end; }
  return `${start > 0 ? '…' : ''}${t.slice(start, end)}${end < t.length ? '…' : ''}`;
}

/** Messages that mention `q`, newest first, in chats the person can open. Notes (the bot thinking aloud) aren't shown in the chat, so they aren't found. */
export function searchMessages(userId: string, q: string): SearchMessageHit[] {
  const rows = db.prepare<[string, string], RowRecord>(`
    SELECT r.* FROM rows r JOIN bots b ON b.id = r.bot_id
    WHERE b.user_id = ? AND r.generation = b.generation AND r.kind = 'message'
      AND json_extract(r.body, '$.text') LIKE ? ESCAPE '\\'
      AND COALESCE(json_extract(r.body, '$.note'), 0) = 0
    ORDER BY r.created_at DESC LIMIT ${MAX_HITS}`).all(userId, likePattern(q));
  return rows.map((r) => {
    const b = JSON.parse(r.body) as MessageBody;
    return {
      botId: r.bot_id, generation: r.generation, seq: r.seq, role: b.role, from: b.from?.kind === 'bot' ? b.from.name : undefined,
      text: excerpt(b.text, q), createdAt: r.created_at,
    } satisfies SearchMessageHit;
  });
}

/** Bounds on one Library walk, so a bot that unpacked a huge tree into its Library can't stall a search. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 5000;

/**
 * Files and folders whose name contains `q`, in each of the person's bots' Libraries under `root`,
 * newest first. Links aren't followed (they could leave the Library, or loop), and dot-files are
 * skipped, as the Library tab's listing shows them but nobody names one to find it.
 */
export async function searchLibraries(userId: string, q: string, root: string): Promise<SearchFileHit[]> {
  const needle = q.toLowerCase();
  const bots = db.prepare<[string], Pick<BotRecord, 'id'>>("SELECT id FROM bots WHERE user_id = ? AND kind <> 'room'").all(userId);
  const hits: SearchFileHit[] = [];
  for (const { id } of bots) {
    const base = path.join(root, id);
    let seen = 0;
    const walk = async (rel: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await fs.readdir(path.join(base, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (++seen > MAX_ENTRIES) return;
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.name.toLowerCase().includes(needle)) {
          try {
            const st = await fs.stat(path.join(base, p));
            hits.push({ botId: id, path: p, name: e.name, isDir: e.isDirectory(), size: e.isDirectory() ? 0 : st.size, modifiedAt: st.mtimeMs });
          } catch { /* gone meanwhile */ }
        }
        if (e.isDirectory() && depth < MAX_DEPTH) await walk(p, depth + 1);
      }
    };
    await walk('', 1);
  }
  return hits.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, MAX_HITS);
}
