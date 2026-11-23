import { db, now, type BotRecord, type TaskRecord, type TeamLogRecord, type UserRecord } from '../db.js';
import { requireWorkspace } from '../workspaces.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { conversation, getBotRow } from '../store.js';
import type { Task, TaskStatus } from '../types.js';

/**
 * The team: its shared task board, and what each agent is told when the team changes. A team is a
 * workspace's agents (workspaces.ts): each workspace has its own board and its own news, and a task's
 * owner is always a bot of the task's workspace.
 *
 * A task belongs to one bot, or to nobody, and moves between four states:
 *
 *   todo ⇄ doing ⇄ blocked ──► done (and back, if someone reopens it)
 *
 * Bots change tasks with their tools (agent/tools.ts) and the user in the app (routes-tasks.ts), both
 * through addTask, changeTask and removeTask here, so the two always tell the same people. A bot that
 * leaves the team (teamLeft, from deleteBot) hands its tasks back: nobody owns them, previous_owner says
 * whose they were, and one it was doing is to do again. One moved to another workspace does the same.
 *
 * The team log is what each agent hears about the team: a teammate joined or left, a task was given to
 * it, moved, changed or finished. An entry is for one bot (`audience`) or for every bot but the one it
 * is about (`actor_id`). A bot's agent is told the entries it hasn't heard yet at the start of its next
 * turn, as a bracketed note at the start of the run's input (teamNews, read by agent/turns.ts), the way
 * catchup.ts tells it about voice calls, so the instructions and the prompt cache behind them stay the
 * same. Being given a task also wakes the bot (a 'team' turn, queued by the caller), so it starts now,
 * and so does a task the bot created getting done or blocked, since the bot is waiting on that work.
 */

/**
 * Bot-to-bot hops in one chain of messages and tasks before the app stops waking bots for it at once,
 * so two bots can't keep each other busy. A task the workspace's primary bot hands out starts a chain
 * of its own (agent/tools.ts wakeFor), and a wake-up for the board that the limit holds back waits for
 * HOP_PAUSE_MS instead (agent/turns.ts wake), so delegated work never sits until some unrelated turn.
 */
export const MAX_HOPS = 6;
/** How long a wake-up held back by MAX_HOPS waits before it starts a chain of its own. */
export const HOP_PAUSE_MS = 5 * 60_000;

/** How long finished tasks stay on the board. */
const DONE_SHOWN_MS = 14 * 86_400_000;
/** How long the log keeps an entry; one older than this was told long ago or no longer matters. */
const LOG_KEPT_MS = 30 * 86_400_000;
/** Entries told per note; the rest are counted. */
const MAX_NEWS = 15;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Text from a task's notes on one line, for news and lists that keep them short: cut at `n`, and then
 * pointing at get_task, which gives the notes whole, so a long brief is never only half read.
 */
export function notesPreview(text: string, n: number, taskId: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > n ? `${flat.slice(0, n - 1)}… (cut short; get_task ${taskId} has it all)` : flat;
}

/** A task's notes once `who` adds `note` to the end, on a line of its own (changeTask). */
export const withNote = (notes: string, who: string, note: string) => `${notes ? `${notes}\n` : ''}${who}: ${note.trim()}`;

/** Who did something: the user in the app, or a bot with one of its tools. */
export type Actor = { kind: 'user' } | { kind: 'bot'; id: string; name: string };

export const ownerName = (userId: string) => db.prepare<[string], Pick<UserRecord, 'username'>>('SELECT username FROM users WHERE id=?').get(userId)?.username ?? 'The user';
const actorName = (userId: string, a: Actor) => (a.kind === 'bot' ? a.name : ownerName(userId));
const userOf = (workspaceId: string) => requireWorkspace(workspaceId).user_id;
const actorId = (a: Actor) => (a.kind === 'bot' ? a.id : null);
const botName = (id: string | null) => (id ? getBotRow(id)?.name ?? null : null);

// ---------- the log ----------

/** Something a workspace's agents hear at their next turn: for one bot (`audience`), or for all but `actorId`. */
export function logTeam(workspaceId: string, text: string, o: { actorId?: string | null; audience?: string | null } = {}) {
  db.prepare('INSERT INTO team_log(user_id,workspace_id,actor_id,audience,text,created_at) VALUES (?,?,?,?,?,?)').run(userOf(workspaceId), workspaceId, o.actorId ?? null, o.audience ?? null, text, now());
  db.prepare('DELETE FROM team_log WHERE created_at<?').run(now() - LOG_KEPT_MS);
}

const unheard = db.prepare<[string, number, string, string], TeamLogRecord>(
  'SELECT * FROM team_log WHERE workspace_id=? AND id>? AND (audience=? OR (audience IS NULL AND actor_id IS NOT ?)) ORDER BY id',
);

/** "just now", "4m ago", "2h ago", "3d ago" */
function ago(t: number): string {
  const s = Math.round((now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

/**
 * What the bot's agent hasn't heard about the team, as a note for its next run. `upTo` is the entry it
 * is caught up to once the run has it: the turn passes it to markTeamSeen then, so news a turn never
 * delivered waits for the next one. Null for a bot that is gone.
 */
export function teamNews(botId: string): { note: string | null; upTo: number } | null {
  const bot = getBotRow(botId);
  if (!bot) return null;
  const entries = unheard.all(bot.workspace_id, bot.team_seen, botId, botId);
  if (!entries.length) return { note: null, upTo: bot.team_seen };
  const lines = entries.slice(-MAX_NEWS).map((e) => `- ${e.text} (${ago(e.created_at)})`);
  const left = entries.length - lines.length;
  return {
    note: `[Team news since your last turn, oldest first:${left > 0 ? `\n(${left} earlier left out)` : ''}\n${lines.join('\n')}]`,
    upTo: entries[entries.length - 1].id,
  };
}

/** The bot's agent has the news up to `upTo` (teamNews). Only forward. */
export function markTeamSeen(botId: string, upTo: number) {
  db.prepare('UPDATE bots SET team_seen=? WHERE id=? AND team_seen<?').run(upTo, botId, upTo);
}

// ---------- joining and leaving ----------

const describe = (b: Pick<BotRecord, 'name' | 'label'>) => (b.label ? `${b.name} (${b.label})` : b.name);

/** A new agent on the team, or one moved here from another workspace: it starts caught up, and the others hear it joined. */
export function teamJoined(bot: BotRecord) {
  if (bot.kind === 'room') return;
  const newest = db.prepare<[], { id: number | null }>('SELECT MAX(id) id FROM team_log').get()?.id ?? 0;
  db.prepare('UPDATE bots SET team_seen=? WHERE id=?').run(newest, bot.id);
  logTeam(bot.workspace_id, `${describe(bot)} joined the team.`, { actorId: bot.id });
}

/**
 * An agent is leaving the team: deleteBot calls this before the bot's row goes, and moveBot before it
 * moves the bot to another workspace (`moved`). Its tasks go back to nobody, saying whose they were, and
 * the others hear it left and which tasks wait for someone.
 */
export function teamLeft(bot: BotRecord, o: { moved?: boolean } = {}) {
  if (bot.kind === 'room') return;
  const open = db.prepare<[string], TaskRecord>("SELECT * FROM tasks WHERE owner_id=? AND status<>'done' ORDER BY created_at").all(bot.id);
  db.prepare(`UPDATE tasks SET owner_id=NULL, previous_owner=?, status=CASE status WHEN 'doing' THEN 'todo' ELSE status END, updated_at=? WHERE owner_id=?`).run(bot.name, now(), bot.id);
  // Nobody is left to hear what was only for it.
  db.prepare('DELETE FROM team_log WHERE audience=?').run(bot.id);
  const tasks = open.map((t) => `"${clip(t.title, 80)}" (${t.id})`).join(', ');
  logTeam(bot.workspace_id, `${describe(bot)} ${o.moved ? 'moved to another workspace' : 'was removed from the team'}.${open.length ? ` Their open tasks have nobody now: ${tasks}.` : ''}`, { actorId: bot.id });
  hub.emit(bot.user_id, { type: 'tasks' });
}

// ---------- the board ----------

export function toTask(r: TaskRecord): Task {
  return {
    id: r.id, workspaceId: r.workspace_id, title: r.title, notes: r.notes, status: r.status, ownerId: r.owner_id, previousOwner: r.previous_owner,
    createdBy: r.created_by ? { id: r.created_by, name: r.creator_name ?? '' } : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** A workspace's board: every open task, and the ones finished in the last 14 days. Newest change first. */
export function listTasks(workspaceId: string): Task[] {
  return db.prepare<[string, number], TaskRecord>("SELECT * FROM tasks WHERE workspace_id=? AND (status<>'done' OR updated_at>?) ORDER BY updated_at DESC")
    .all(workspaceId, now() - DONE_SHOWN_MS).map(toTask);
}

/** Every board of the user's, for the app, which shows the one of the workspace it is in. */
export function userTasks(userId: string): Task[] {
  return db.prepare<[string, number], TaskRecord>("SELECT * FROM tasks WHERE user_id=? AND (status<>'done' OR updated_at>?) ORDER BY updated_at DESC")
    .all(userId, now() - DONE_SHOWN_MS).map(toTask);
}

export const getTask = (workspaceId: string, id: string) =>
  db.prepare<[string, string], TaskRecord>('SELECT * FROM tasks WHERE id=? AND workspace_id=?').get(id.trim(), workspaceId);

/** A task of the user's, in whichever workspace, for the app's routes. */
export const userTask = (userId: string, id: string) =>
  db.prepare<[string, string], TaskRecord>('SELECT * FROM tasks WHERE id=? AND user_id=?').get(id.trim(), userId);

/** An agent of this workspace that can own its tasks, by id. */
export const taskOwner = (workspaceId: string, id: string) =>
  db.prepare<[string, string], BotRecord>("SELECT * FROM bots WHERE id=? AND workspace_id=? AND kind<>'room'").get(id, workspaceId);

/** A line in a bot's chat about a task that concerns it, so the user sees why it is at work. */
function chatLine(botId: string, text: string, taskId: string) {
  if (getBotRow(botId)) conversation(botId).append('event', { type: 'event', event: 'task', text, ref: taskId });
}

/**
 * Who a change wakes, which the caller does (agent/turns.ts wake): the bot the task was given to, so it
 * starts on it, and the bot that created it, when it got done or blocked, so it picks up from there.
 */
export interface TaskChange { task: Task; given: string | null; creator: string | null }

export function addTask(workspaceId: string, actor: Actor, p: { title: string; notes?: string; ownerId?: string | null; status?: TaskStatus }): TaskChange {
  const id = newId('task');
  const t = now();
  const userId = userOf(workspaceId);
  db.prepare('INSERT INTO tasks(id,user_id,workspace_id,title,notes,status,owner_id,created_by,creator_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, userId, workspaceId, p.title.trim(), (p.notes ?? '').trim(), p.status ?? 'todo', p.ownerId ?? null, actorId(actor), actor.kind === 'bot' ? actor.name : null, t, t);
  const task = toTask(getTask(workspaceId, id)!);
  // A finished task needs nobody to start on it.
  const given = task.ownerId && task.ownerId !== actorId(actor) && task.status !== 'done' ? task.ownerId : null;
  if (given) giveTo(workspaceId, actor, given, task);
  hub.emit(userId, { type: 'tasks' });
  return { task, given, creator: null };
}

function giveTo(workspaceId: string, actor: Actor, botId: string, task: Task) {
  const who = actorName(userOf(workspaceId), actor);
  logTeam(workspaceId, `${who} gave you a task: "${clip(task.title, 120)}" (${task.id}).${task.notes ? ` Notes: ${notesPreview(task.notes, 600, task.id)}` : ''}`, { audience: botId });
  chatLine(botId, `${who} gave ${botName(botId)} a task: ${clip(task.title, 120)}`, task.id);
}

const STATUS_WORDS: Record<TaskStatus, string> = { todo: 'to do', doing: 'doing', blocked: 'blocked', done: 'done' };

/**
 * Change a task. `note` is added to the end of its notes, on a line of its own with who wrote it;
 * `notes` replaces them (the app's editor). The owner hears what someone else changed, a new owner is
 * given the task, the old one hears it moved, and the bot that created it hears it got done or blocked.
 */
export function changeTask(workspaceId: string, actor: Actor, id: string, p: { title?: string; notes?: string; note?: string; status?: TaskStatus; ownerId?: string | null }): TaskChange | null {
  const cur = getTask(workspaceId, id);
  if (!cur) return null;
  const userId = cur.user_id;
  const who = actorName(userId, actor);
  const me = actorId(actor);
  const title = p.title?.trim() || cur.title;
  let notes = p.notes !== undefined ? p.notes.trim() : cur.notes;
  if (p.note?.trim()) notes = withNote(notes, who, p.note);
  const status = p.status ?? cur.status;
  const owner = p.ownerId !== undefined ? p.ownerId : cur.owner_id;
  const moved = owner !== cur.owner_id;
  db.prepare('UPDATE tasks SET title=?, notes=?, status=?, owner_id=?, previous_owner=?, updated_at=? WHERE id=?')
    .run(title, notes, status, owner, moved ? null : cur.previous_owner, now(), cur.id);
  const task = toTask(getTask(workspaceId, cur.id)!);
  const name = `"${clip(title, 120)}" (${cur.id})`;

  let given: string | null = null;
  if (moved) {
    if (owner && owner !== me && status !== 'done') {
      given = owner;
      giveTo(workspaceId, actor, owner, task);
    }
    if (cur.owner_id && cur.owner_id !== me) {
      logTeam(workspaceId, `${who} moved your task ${name} to ${botName(owner) ?? 'nobody'}.`, { audience: cur.owner_id });
    }
  } else if (owner && owner !== me) {
    const what: string[] = [];
    if (status !== cur.status) what.push(`marked it ${STATUS_WORDS[status]}`);
    if (title !== cur.title) what.push('renamed it');
    if (p.note?.trim()) what.push(`noted: ${notesPreview(p.note, 400, cur.id)}`);
    else if (notes !== cur.notes) what.push('changed its notes');
    if (what.length) logTeam(workspaceId, `${who} changed your task ${name}: ${what.join('; ')}.`, { audience: owner });
  }
  // The bot that asked for it hears it got done or blocked, unless it did that itself or owns it (told
  // above), and is woken: it is waiting on the work, and nothing else may start its next turn for hours.
  // A note made with the change is what was done or what is in the way, so it comes along.
  let creator: string | null = null;
  const settled = status !== cur.status && (status === 'done' || status === 'blocked');
  if (settled && cur.created_by && cur.created_by !== me && cur.created_by !== owner && taskOwner(workspaceId, cur.created_by)) {
    creator = cur.created_by;
    const note = p.note?.trim() ? ` Note: ${notesPreview(p.note, 600, cur.id)}` : '';
    logTeam(workspaceId, status === 'done'
      ? `${owner === me ? who : botName(owner) ?? who} finished ${name}, a task you created.${note}`
      : `${who} marked ${name}, a task you created, blocked.${note}`, { audience: creator });
  }
  hub.emit(userId, { type: 'tasks' });
  return { task, given, creator };
}

/** Take a task off the board. Its owner hears, unless it took it off itself. */
export function removeTask(workspaceId: string, actor: Actor, id: string): boolean {
  const cur = getTask(workspaceId, id);
  if (!cur) return false;
  const userId = cur.user_id;
  db.prepare('DELETE FROM tasks WHERE id=?').run(cur.id);
  if (cur.owner_id && cur.owner_id !== actorId(actor) && cur.status !== 'done') {
    logTeam(workspaceId, `${actorName(userId, actor)} took your task "${clip(cur.title, 120)}" off the board.`, { audience: cur.owner_id });
  }
  hub.emit(userId, { type: 'tasks' });
  return true;
}

/**
 * A task as a line for an agent: "[doing] Login API (task_x) · owner: Kai · from Ava · notes: …". `user`
 * is the user's name. The notes are cut short, or left out with `notes: false` (get_task gives them whole).
 */
export function taskLine(t: Task, user: string, o: { owner?: boolean; notes?: boolean } = {}): string {
  const parts = [`[${STATUS_WORDS[t.status]}] ${t.title} (${t.id})`];
  if (o.owner) parts.push(t.ownerId ? `owner: ${botName(t.ownerId) ?? 'unknown'}` : `owner: nobody${t.previousOwner ? ` (was ${t.previousOwner})` : ''}`);
  parts.push(`from ${t.createdBy ? t.createdBy.name : user}`);
  if (t.notes && o.notes !== false) parts.push(`notes: ${notesPreview(t.notes, 300, t.id)}`);
  return parts.join(' · ');
}
