import { db, now, type BotRecord, type RoutineRecord, type RowRecord } from './db.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { mapSpeed, mapVoice } from './speech.js';
import type { AvatarColor, AvatarShape, Bot, Row, RowBody, RowKind, Routine } from './types.js';
import { Cron } from 'croner';

// ---------- bots ----------

export function toBot(r: BotRecord): Bot {
  // The newest row worth previewing; the bot's notes to itself and the routine-run lines older chats still have don't count.
  const last = db
    .prepare<[string, number], Pick<RowRecord, 'body' | 'created_at'>>("SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind IN ('message','card','event') AND json_extract(body, '$.event') IS NOT 'routine-run' ORDER BY seq DESC LIMIT 8")
    .all(r.id, r.generation).find((x) => !JSON.parse(x.body).note);
  let lastPreview: string | null = null;
  if (last) {
    const b = JSON.parse(last.body) as RowBody;
    lastPreview =
      b.type === 'message' ? (b.text || (b.attachments?.length ? `Attached ${b.attachments.map((a) => a.name).join(', ')}` : '')) : b.type === 'card' ? (b.card === 'approval' ? `Waiting for you: ${b.title}` : b.card === 'question' ? b.question : b.card === 'weather' ? `Weather in ${b.place}` : 'Draft') : b.type === 'event' ? b.text : null;
  }
  return {
    id: r.id,
    name: r.name,
    label: r.label,
    description: r.description,
    instructions: r.instructions,
    avatarShape: r.avatar_shape as AvatarShape,
    avatarColor: r.avatar_color as AvatarColor,
    isPrimary: !!r.is_primary,
    kind: r.kind === 'room' ? 'room' : 'agent',
    sidebarHidden: !!r.sidebar_hidden,
    effort: r.effort as Bot['effort'],
    voice: mapVoice(r.voice),
    voiceSpeed: mapSpeed(r.voice_speed),
    model: r.model ?? null,
    provider: r.provider ?? null,
    generation: r.generation,
    unread: r.unread,
    lastPreview: lastPreview ? lastPreview.slice(0, 140) : null,
    lastActivityAt: last?.created_at ?? r.updated_at,
    createdAt: r.created_at,
  };
}

const botById = db.prepare<[string], BotRecord>('SELECT * FROM bots WHERE id=?');

/** The bot's record, or undefined when there is no such bot (it may have been deleted mid-turn). */
export const getBotRow = (id: string): BotRecord | undefined => botById.get(id);

/** The bot's record, for code that runs only while the bot exists; throws when it doesn't. */
export function requireBot(id: string): BotRecord {
  const b = botById.get(id);
  if (!b) throw new Error(`no bot ${id}`);
  return b;
}

/** The bot, if it exists and belongs to this user; routes use it to 404 everything else. */
export function ownBot(userId: string, id: string | undefined): BotRecord | null {
  const b = id ? botById.get(id) : undefined;
  return b && b.user_id === userId ? b : null;
}

export const getBot = (id: string) => {
  const r = getBotRow(id);
  return r ? toBot(r) : null;
};
export const listBots = (userId: string) =>
  db.prepare<[string], BotRecord>('SELECT * FROM bots WHERE user_id=? AND hidden=0 ORDER BY is_primary DESC, created_at ASC').all(userId).map(toBot);

export function emitBot(botId: string) {
  const r = getBotRow(botId);
  if (r) hub.emit(r.user_id, { type: 'bot', bot: toBot(r) });
}

// ---------- rows ----------
//
// A bot's chat is a list of rows. Rows belong to a conversation `generation`: "New chat" bumps it and
// numbering starts again at seq 1, so a seq alone does not say which row it is. Code that keeps a row
// across an await holds a RowRef (or the Row itself), and long-running work (a turn, a call) writes
// through a Conversation, so nothing it does can land in a newer conversation.
//
// Every write takes the bot's next `rev` as the row's updatedSeq and emits a `rows` event; clients keep
// the newest revision of each row and ignore rows of an older generation than the one they show.

/** Which row: its bot, conversation and place in it. A Row is one. */
export interface RowRef { botId: string; generation: number; seq: number }

const rowAt = db.prepare<[string, number, number], RowRecord>('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=?');

function toRow(r: RowRecord): Row {
  return { botId: r.bot_id, generation: r.generation, seq: r.seq, updatedSeq: r.updated_seq, kind: r.kind as RowKind, body: JSON.parse(r.body) as RowBody, createdAt: r.created_at };
}

function bumpRev(botId: string): number {
  db.prepare('UPDATE bots SET rev = rev + 1, updated_at=? WHERE id=?').run(now(), botId);
  return requireBot(botId).rev;
}

/** Append a row to the bot's current conversation. */
export function appendRow(botId: string, kind: RowKind, body: RowBody): Row {
  const tx = db.transaction(() => {
    const b = requireBot(botId);
    const seq = b.next_seq;
    db.prepare('UPDATE bots SET next_seq = next_seq + 1 WHERE id=?').run(botId);
    const rev = bumpRev(botId);
    const t = now();
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run(botId, b.generation, seq, rev, kind, JSON.stringify(body), t);
    const row: Row = { botId, generation: b.generation, seq, updatedSeq: rev, kind, body, createdAt: t };
    return { userId: b.user_id, row };
  });
  const { userId, row } = tx();
  hub.emit(userId, { type: 'rows', botId, generation: row.generation, rows: [row] });
  return row;
}

/**
 * Rewrite a row's body (streaming text, a card's status, a call's summary). The row is found by its
 * generation, so a late update to a row of an earlier conversation changes that row and no other.
 */
export function updateRow(ref: RowRef, body: RowBody): Row | null {
  const tx = db.transaction(() => {
    const b = getBotRow(ref.botId);
    const existing = b && rowAt.get(ref.botId, ref.generation, ref.seq);
    if (!b || !existing) return null;
    const rev = bumpRev(ref.botId);
    db.prepare('UPDATE rows SET body=?, updated_seq=? WHERE bot_id=? AND generation=? AND seq=?').run(JSON.stringify(body), rev, ref.botId, ref.generation, ref.seq);
    const row: Row = { ...toRow(existing), body, updatedSeq: rev };
    return { userId: b.user_id, row };
  });
  const res = tx();
  if (!res) return null;
  hub.emit(res.userId, { type: 'rows', botId: ref.botId, generation: res.row.generation, rows: [res.row] });
  return res.row;
}

export function getRow(ref: RowRef): Row | null {
  const r = rowAt.get(ref.botId, ref.generation, ref.seq);
  return r ? toRow(r) : null;
}

/** A row of the bot's current conversation, by seq (what the web app sends). */
export function currentRow(botId: string, seq: number): Row | null {
  const b = getBotRow(botId);
  return b ? getRow({ botId, generation: b.generation, seq }) : null;
}

/**
 * One conversation of a bot, for work that outlives a request. Once the user starts a new chat it is
 * stale: appends are dropped (they would show in the new chat) and updates go to its own rows.
 */
export interface Conversation {
  botId: string;
  generation: number;
  /** Still the conversation the user sees. */
  isCurrent(): boolean;
  append(kind: RowKind, body: RowBody): Row | null;
  update(seq: number, body: RowBody): Row | null;
  get(seq: number): Row | null;
}

export function conversation(botId: string, generation = requireBot(botId).generation): Conversation {
  const isCurrent = () => getBotRow(botId)?.generation === generation;
  return {
    botId,
    generation,
    isCurrent,
    append: (kind, body) => (isCurrent() ? appendRow(botId, kind, body) : null),
    update: (seq, body) => updateRow({ botId, generation, seq }, body),
    get: (seq) => getRow({ botId, generation, seq }),
  };
}

export function listRows(botId: string, opts: { beforeSeq?: number; limit?: number } = {}): Row[] {
  const b = getBotRow(botId);
  if (!b) return [];
  const limit = Math.min(opts.limit ?? 200, 500);
  const rows = opts.beforeSeq
    ? db.prepare<[string, number, number, number], RowRecord>('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq<? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, opts.beforeSeq, limit)
    : db.prepare<[string, number, number], RowRecord>('SELECT * FROM rows WHERE bot_id=? AND generation=? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, limit);
  return rows.reverse().map(toRow);
}

/** "New chat": a new generation starts at seq 1. Rows of earlier ones stay in the database, unseen. */
export function clearConversation(botId: string) {
  const b = requireBot(botId);
  db.prepare('UPDATE bots SET generation = generation + 1, next_seq = 1, told_seq = 0 WHERE id=?').run(botId);
  hub.emit(b.user_id, { type: 'cleared', botId, generation: b.generation + 1 });
}

/** Something new for the user to read in this bot's chat: the rail's unread badge goes up by one. */
export function markUnread(botId: string) {
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
}

// ---------- routines ----------

export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [m, h, dom, mon, dow] = p;
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? new Date(2000, 0, 1, +h, +m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  if (time && dom === '*' && mon === '*' && dow === '*') return `Every day at ${time}`;
  if (time && dom === '*' && mon === '*' && dow === '1-5') return `Weekdays at ${time}`;
  if (time && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][+dow]} at ${time}`;
  if (m === '0' && h === '*') return 'Every hour';
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m.slice(2)} minutes`;
  if (m === '0' && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return `Every ${h.slice(2)} hours`;
  return expr;
}

export function toRoutine(r: RoutineRecord): Routine {
  const timezone: string = r.timezone || env.timeZone;
  let nextRunAt: number | null = null;
  try {
    nextRunAt = r.enabled ? new Cron(r.schedule, { timezone, paused: true }).nextRun()?.getTime() ?? null : null;
  } catch { /* invalid cron */ }
  return {
    id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone,
    enabled: !!r.enabled, nextRunAt, lastRunAt: r.last_run_at, description: describeCron(r.schedule),
  };
}

export function getRoutine(id: string): Routine | null {
  const r = db.prepare<[string], RoutineRecord>('SELECT * FROM routines WHERE id=?').get(id);
  return r ? toRoutine(r) : null;
}

export const listRoutines = (botId: string) => db.prepare<[string], RoutineRecord>('SELECT * FROM routines WHERE bot_id=? ORDER BY created_at').all(botId).map(toRoutine);

