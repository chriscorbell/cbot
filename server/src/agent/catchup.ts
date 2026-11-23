// What a bot's text chat and its side conversations missed of each other. A voice call is a Hermes
// session of its own, apart from the chat's (voice.ts says why), and so is a teammate's question
// (agent/asks.ts), so none of them has the others in its history. The chat's rows are the record of all
// of them, and before each run a session is told the rows it did not write:
//
//   a call      hears what is new in the text chat since its last run: messages typed there, the bot's
//               replies there, questions waiting there (chatNews, called by voice-relay.ts and asks.ts)
//   the chat    hears about the calls that ended since its last turn, with what was said on them, what
//               a call posted in the chat with post_to_chat, and what it answered teammates who asked
//               (sideNews, called by turns.ts)
//
// Both arrive as a bracketed note at the start of the run's input, so the instructions, and the prompt
// cache behind them, stay the same.
import { db, now, type RowRecord, type UserRecord } from '../db.js';
import { getBotRow, requireBot } from '../store.js';
import { computerState } from '../computer.js';
import { getLive } from './live.js';
import type { ActivityKind, CardBody, MessageBody, RowBody } from '../types.js';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "just now", "4m ago", "2h ago", "3d ago" */
export function ago(t: number): string {
  const s = Math.round((now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

/** "45s", "4m 05s" */
export function callLength(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function messageText(b: MessageBody): string {
  const files = b.attachments?.length ? `[attached: ${b.attachments.map((a) => a.name).join(', ')}]` : '';
  return [b.text.trim(), files].filter(Boolean).join(' ');
}

// ---------- the chat at a glance, for a call or a teammate ----------

const ACTIVITY_WORDS: Partial<Record<ActivityKind, string>> = {
  thinking: 'thinking it through', working: 'working on it', searching_web: 'searching the web', reading_web: 'reading a web page',
  browsing_web: 'browsing the web', on_its_computer: 'using its computer', running_commands: 'running commands on its computer',
  waiting_on_command: 'waiting on a command', messaging_named: 'messaging another Bot', connecting_service: 'using an app',
  waiting_for_you: 'waiting for the user', drafting_file: 'drafting a file', remembering: 'making a note',
};

function chatMessage(body: RowBody): { role: 'user' | 'assistant'; text: string; via?: string } | null {
  // Notes are the bot thinking aloud between steps, not part of the conversation.
  if (body.type !== 'message' || body.streaming || body.note) return null;
  const via = body.from ? (body.from.kind === 'voice' ? 'said on a call' : body.from.kind === 'routine' ? `routine ${body.from.name}` : `from ${body.from.name}`) : undefined;
  return { role: body.role, text: body.text, via };
}

/** Recent messages in the bot's current conversation, oldest first. */
export function recentMessages(botId: string, count: number) {
  const b = requireBot(botId);
  const rows = db.prepare<[string, number, number], Pick<RowRecord, 'seq' | 'body' | 'created_at'>>("SELECT seq, body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind IN ('message','event','card') ORDER BY seq DESC LIMIT ?").all(botId, b.generation, count * 2);
  const out: { seq: number; at: number; who: string; text: string }[] = [];
  for (const r of rows) {
    const body = JSON.parse(r.body) as RowBody;
    const m = chatMessage(body);
    if (m) out.push({ seq: r.seq, at: r.created_at, who: m.role === 'user' ? `User${m.via ? ` (${m.via})` : ''}` : b.name, text: m.text });
    else if (body.type === 'event' && body.event === 'voice-call' && body.call?.phase === 'ended') out.push({ seq: r.seq, at: r.created_at, who: 'Call record', text: body.text });
    else if (body.type === 'card' && body.status === 'pending') out.push({ seq: r.seq, at: r.created_at, who: 'Waiting for the user', text: body.card === 'approval' ? body.title : body.question });
    if (out.length >= count) break;
  }
  return out.reverse();
}

/** What the bot is doing in its chat right now, what waits on the user there, and its computer. */
export function activitySnapshot(botId: string) {
  const live = getLive(botId);
  const pending = db.prepare<[string, number], Pick<RowRecord, 'body'>>("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='card' ORDER BY seq DESC LIMIT 20").all(botId, requireBot(botId).generation)
    .map((r) => JSON.parse(r.body) as CardBody)
    .filter((b): b is Extract<CardBody, { card: 'approval' | 'question' }> => (b.card === 'approval' || b.card === 'question') && b.status === 'pending');
  const lines: string[] = [];
  if (live.isRunning) lines.push(`Busy right now: ${ACTIVITY_WORDS[live.activity.kind] ?? 'working'}${live.activity.detail ? ` (${live.activity.detail})` : ''}, started ${ago(live.startedAt)}.`);
  else lines.push('Idle: not working on anything right now.');
  if (pending.length) lines.push(`Waiting on the user in chat:\n${pending.map((b) => `- ${b.card === 'approval' ? b.title : b.question}`).join('\n')}`);
  const comp = computerState(requireBot(botId).user_id);
  lines.push(`Computer: ${comp.status === 'running' ? 'running' : `a screen did not start (${comp.error})`}.`);
  return lines.join('\n');
}

// ---------- the text chat, for a call ----------

/**
 * How far a call has heard the text chat: the bot's row revision it was last told up to, and the rows
 * it has been told about. Rows are rewritten in place (a reply streams, a note becomes the turn's
 * answer), so the cursor follows the revision counter rather than seq, and `told` keeps a row that
 * changes again (a reaction, an answered question) from being told twice.
 */
export interface ChatCursor { rev: number; told: Set<string> }

const key = (r: Pick<RowRecord, 'generation' | 'seq'>) => `${r.generation}:${r.seq}`;

/** A chat row as a line for a call, or null while it is nothing to tell: a tool step, a note, a reply still being written, the call's own post. */
function chatLine(body: RowBody, owner: string, callId: string): string | null {
  switch (body.type) {
    case 'message': {
      if (body.streaming || body.note || (callId && body.call === callId)) return null;
      const text = clip(oneLine(messageText(body)), 600);
      if (!text) return null;
      if (body.role === 'assistant') return `You: ${text}`;
      if (body.from?.kind === 'bot') return `${body.from.name}, another Bot: ${text}`;
      if (body.from?.kind === 'routine') return `Routine ${body.from.name}: ${text}`;
      return `${owner}: ${text}`;
    }
    case 'card':
      if (body.card === 'page') return `You showed ${owner} a visual: ${clip(oneLine(body.title), 200)}`;
      return body.card === 'question' && body.status === 'pending' ? `Your question, waiting for ${owner}'s answer: ${clip(oneLine(body.question), 300)}` : null;
    case 'notice':
      return `Notice from the app: ${clip(oneLine(body.text), 300)}`;
    default:
      return null;
  }
}

/**
 * Where a call starts in the text chat: everything there already is counted as heard (the call's
 * instructions show the recent part of it). Only the newest rows are looked at; an older one that
 * changes during the call may be told as new.
 */
export function chatCursor(botId: string): ChatCursor {
  const bot = getBotRow(botId);
  if (!bot) return { rev: 0, told: new Set() };
  const rows = db.prepare<[string, number], Pick<RowRecord, 'generation' | 'seq' | 'body'>>('SELECT generation, seq, body FROM rows WHERE bot_id=? AND generation=? ORDER BY seq DESC LIMIT 200').all(botId, bot.generation);
  return { rev: bot.rev, told: new Set(rows.filter((r) => chatLine(JSON.parse(r.body) as RowBody, '', '')).map(key)) };
}

/** Lines a call is told at most; the rest is counted. */
const MAX_LINES = 12;

/**
 * What changed in the text chat since the call last heard, as a note for the call's next run, or null.
 * Moves the cursor on. A row is told once it is finished, and the call's own posts are left out.
 */
export function chatNews(botId: string, callId: string, cursor: ChatCursor, owner: string): string | null {
  const bot = getBotRow(botId);
  if (!bot) return null;
  const rows = db.prepare<[string, number, number], RowRecord>('SELECT * FROM rows WHERE bot_id=? AND generation=? AND updated_seq>? ORDER BY seq').all(botId, bot.generation, cursor.rev);
  cursor.rev = bot.rev;
  const lines: string[] = [];
  for (const r of rows) {
    if (cursor.told.has(key(r))) continue;
    const line = chatLine(JSON.parse(r.body) as RowBody, owner, callId);
    if (!line) continue;
    cursor.told.add(key(r));
    lines.push(`- ${line} (${ago(r.created_at)})`);
  }
  if (!lines.length) return null;
  const left = lines.length - MAX_LINES;
  return `[New in your text chat with ${owner} since you last heard, oldest first:${left > 0 ? `\n(${left} earlier left out)` : ''}\n${lines.slice(-MAX_LINES).join('\n')}]`;
}

// ---------- calls and teammates' questions, for the text chat ----------

/** What the chat's agent is told of one call. */
interface CallNews { ended?: { at: number; durationMs?: number; transcript: { role: 'user' | 'assistant'; text: string }[] }; posts: string[] }

/** Transcript lines told per call, and calls per note; the newest are kept. */
const MAX_CALL_LINES = 40;
const MAX_CALLS = 3;
/** Teammates' questions told per note; the newest are kept. */
const MAX_ASKS = 5;

/**
 * What the text chat's agent has not been told about: the rows after `bots.told_seq` in the bot's
 * current chat that a call wrote (its record when it ended, its posts), and the questions teammates
 * asked it in side conversations, with its answers. `upTo` is where the chat is caught up to once the
 * note is in Hermes' hands; the turn passes it to `markTold` then, so a turn that never reached Hermes
 * leaves the news for the next one. A question still being answered holds `upTo` back to just before
 * it, so it is told once it has its answer.
 */
export function sideNews(botId: string, generation: number): { note: string | null; upTo: number } | null {
  const bot = getBotRow(botId);
  if (!bot || bot.generation !== generation) return null;
  let upTo = bot.next_seq - 1;
  if (upTo <= bot.told_seq) return { note: null, upTo };
  const owner = db.prepare<[string], Pick<UserRecord, 'username'>>('SELECT username FROM users WHERE id=?').get(bot.user_id)?.username ?? 'the user';
  const rows = db.prepare<[string, number, number], RowRecord>("SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq>? AND kind IN ('message','event') ORDER BY seq").all(botId, generation, bot.told_seq);
  const calls = new Map<string, CallNews>();
  const asks: string[] = [];
  const of = (id: string) => calls.get(id) ?? calls.set(id, { posts: [] }).get(id)!;
  for (const r of rows) {
    const body = JSON.parse(r.body) as RowBody;
    if (body.type === 'message' && body.call && body.role === 'assistant') of(body.call).posts.push(messageText(body));
    else if (body.type === 'event' && body.event === 'voice-call' && body.call?.phase === 'ended') {
      of(body.call.id).ended = { at: r.created_at, durationMs: body.call.durationMs, transcript: body.call.transcript ?? [] };
    } else if (body.type === 'event' && body.event === 'bot-question' && body.ask && body.ask.to.id === botId) {
      // Its own questions to others came back as its tools' answers; only the ones it answered are news.
      if (body.ask.status === 'asking') {
        upTo = r.seq - 1;
        break;
      }
      asks.push(`${body.ask.from.name} asked you, ${ago(r.created_at)}: ${clip(oneLine(body.ask.question), 600)}\n${body.ask.status === 'answered' ? `You answered: ${clip(oneLine(body.ask.answer ?? ''), 1200)}` : `You didn't answer: ${clip(oneLine(body.ask.answer ?? ''), 200)}`}`);
    }
  }
  const parts: string[] = [];
  if (calls.size) {
    const told = [...calls.values()].slice(-MAX_CALLS).map((c) => {
      const lines: string[] = [];
      if (c.ended) {
        const said = c.ended.transcript.map((t) => `${t.role === 'user' ? owner : 'You'}: ${clip(oneLine(t.text), 500)}`);
        lines.push(`Voice call${c.ended.durationMs ? `, ${callLength(c.ended.durationMs)}` : ''}, ended ${ago(c.ended.at)}:`);
        if (said.length > MAX_CALL_LINES) lines.push(`(${said.length - MAX_CALL_LINES} earlier lines left out)`);
        lines.push(...(said.length ? said.slice(-MAX_CALL_LINES) : ['(no transcript)']));
      } else {
        lines.push('A voice call that has not ended yet:');
      }
      for (const p of c.posts) lines.push(`You posted in this chat during the call:\n${clip(p, 2000)}`);
      return lines.join('\n');
    });
    const left = calls.size - told.length;
    parts.push(`[Note from the app: since your last turn here, ${owner} talked with you on a voice call. A call runs in a conversation of its own, so it is not in your history here. Oldest first:${left > 0 ? `\n(${left} earlier call${left === 1 ? '' : 's'} left out)` : ''}\n\n${told.join('\n\n')}]`);
  }
  if (asks.length) {
    const left = asks.length - MAX_ASKS;
    parts.push(`[Note from the app: since your last turn here, teammates asked you questions with ask_bot, which you answered in side conversations that are not in your history here. Oldest first:${left > 0 ? `\n(${left} earlier left out)` : ''}\n\n${asks.slice(-MAX_ASKS).join('\n\n')}]`);
  }
  return { note: parts.length ? parts.join('\n\n') : null, upTo };
}

/** The chat's agent has the news up to `upTo` (sideNews). Only forward, and only in the chat it was read from. */
export function markTold(botId: string, generation: number, upTo: number) {
  db.prepare('UPDATE bots SET told_seq=? WHERE id=? AND generation=? AND told_seq<?').run(upTo, botId, generation, upTo);
}
