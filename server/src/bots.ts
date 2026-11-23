import { db, now, type BotRecord, type DeletedBotRecord, type UserRecord, type WorkspaceRecord } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { toUser } from './lib/auth.js';
import { assignEngine, provisionEngine, refreshTools, removeEngine, syncPersona } from './engine.js';
import { getBot, getBotRow, listRoutines, requireBot } from './store.js';
import { clear as clearTurns, enqueue } from './agent/turns.js';
import { unscheduleRoutine } from './routines.js';
import { forgetBotFiles, readyScreen, releaseScreen } from './computer.js';
import { dropCalls } from './voice.js';
import { dropAsks } from './agent/asks.js';
import { ownerName, teamJoined, teamLeft } from './agent/team.js';
import { leaveRooms } from './agent/rooms.js';
import { createWorkspace, defaultWorkspace, nameInUse, requireWorkspace, workspacesOf } from './workspaces.js';
import { cancelBotSignIns } from './signin.js';
import { NEW_BOT_VOICES } from './speech.js';
import { removeBotUnits } from './units.js';
import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarColor, type AvatarShape, type Bot, type User } from './types.js';

const SHAPES: readonly AvatarShape[] = AVATAR_SHAPES;
const COLORS: readonly AvatarColor[] = AVATAR_COLORS;

function hashPick<T>(id: string, list: readonly T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

/** Thrown for things the user can fix; the message is shown to them. */
export class UserError extends Error {}

const agentCount = () => db.prepare<[], { n: number }>("SELECT COUNT(*) n FROM bots WHERE kind<>'room'").get()!.n;

/** The workspace's primary bot, if it has a bot yet. */
export const primaryBot = (workspaceId: string) =>
  db.prepare<[string], BotRecord>("SELECT * FROM bots WHERE workspace_id=? AND is_primary=1 AND kind<>'room' ORDER BY created_at LIMIT 1").get(workspaceId);

export interface NewBot { name: string; label?: string; description?: string; instructions?: string; avatarShape?: string; avatarColor?: string }

/** Who a bot is to the team: its role, its About and its instructions, as long as createBot keeps them. */
export interface Persona { label?: string; description?: string; instructions?: string }
const PERSONA_LIMITS = { label: 60, description: 500, instructions: 8000 } as const;
const clipPersona = (k: keyof Persona, v: string | undefined) => v?.trim().slice(0, PERSONA_LIMITS[k]);

/** A new bot in the workspace (the user's first one when none is named). The first bot of a workspace is its primary bot. */
export function createBot(userId: string, b: NewBot, workspaceId = defaultWorkspace(userId).id) {
  // Every bot runs a screen, a Chrome and an agent of its own on the one computer.
  const name = b.name.trim().slice(0, 60) || 'New Bot';
  const taken = nameInUse(workspaceId, name);
  if (taken) throw new UserError(taken);
  if (agentCount() >= env.maxBots) throw new UserError(`The team is full: the computer has room for ${env.maxBots} bots. Remove one to add another.`);
  const id = newId('bot');
  const shape = SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, SHAPES);
  const color = COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  const voice = hashPick(id, NEW_BOT_VOICES);
  // The workspace's first bot is its primary one: the user's main point of contact there, and the bot
  // later ones copy their model and sign-ins from (engine.ts).
  const primary = !primaryBot(workspaceId);
  db.prepare(
    'INSERT INTO bots(id,user_id,workspace_id,name,label,description,instructions,avatar_shape,avatar_color,is_primary,voice,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, workspaceId, name, clipPersona('label', b.label) ?? '', clipPersona('description', b.description) ?? '', clipPersona('instructions', b.instructions) ?? '', shape, color, primary ? 1 : 0, voice, now(), now());
  assignEngine(id);
  provisionEngine(id);
  // The rest of the team hears about it at their next turn; its own instructions list them already.
  teamJoined(requireBot(id));
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}

/**
 * A new bot's first turn: it says hello and asks what it should help with. A primary bot also mentions
 * check-ins once, since nothing else in a chat tells the user it can write first. A bot another bot made
 * (`by`, create_bot) only says hello: it was made for a job, which that bot hands it next.
 */
export function welcome(bot: Pick<BotRecord, 'id' | 'name' | 'is_primary'>, username: string, by?: string) {
  if (by) {
    enqueue(bot.id, { type: 'system', text: `${by} just added you to the team. Greet ${username} by name and introduce yourself as ${bot.name} in one or two short sentences, saying what you are here to do. Nothing else.` });
    return;
  }
  const checkins = bot.is_primary ? ` Add one short sentence saying you can also check in with ${username} at set times each day if they'd like, and that they can ask you or turn it on in the workspace's settings.` : '';
  enqueue(bot.id, { type: 'system', text: `You were just created. Greet ${username} by name and introduce yourself as ${bot.name} in one or two short sentences, using what you already know about them if anything.${checkins} Then call ask_user once with multiple set to true, asking what they would most like your help with, with up to four short options suited to them. Nothing else.` });
}

/**
 * An agent the workspace's primary bot added (create_bot). It greets the user like any new bot, saying
 * which bot added it. A reason instead of a bot when the computer has no room for another.
 */
export function addTeammate(by: BotRecord, b: NewBot): { bot: Bot } | { error: string } {
  let bot: Bot;
  try {
    bot = createBot(by.user_id, b, by.workspace_id);
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
  if (!setupPending(by.user_id)) welcome(requireBot(bot.id), ownerName(by.user_id), by.name);
  return { bot };
}

/**
 * Change a bot's label, About or instructions for the workspace's primary bot (update_bot), kept as long
 * as createBot keeps them. Returns the ones that changed; its agent reads them from its next turn.
 */
export function updatePersona(b: BotRecord, p: Persona): (keyof Persona)[] {
  const next: Persona = { label: clipPersona('label', p.label), description: clipPersona('description', p.description), instructions: clipPersona('instructions', p.instructions) };
  const changed = (['label', 'description', 'instructions'] as const).filter((k) => next[k] !== undefined && next[k] !== b[k]);
  if (!changed.length) return [];
  db.prepare('UPDATE bots SET label=COALESCE(?,label), description=COALESCE(?,description), instructions=COALESCE(?,instructions), updated_at=? WHERE id=?')
    .run(next.label ?? null, next.description ?? null, next.instructions ?? null, now(), b.id);
  showPersona(b, { persona: changed.includes('label') || changed.includes('description'), looks: changed.includes('label') });
  hub.emit(b.user_id, { type: 'roster' });
  return changed;
}

/**
 * After a bot's name, label or About changed, or its look: its persona file says who it is
 * (engine.ts syncPersona), and its desktop, which shows its name, label and colour, is dressed again if
 * it has one. A group chat has neither.
 */
export function showPersona(b: Pick<BotRecord, 'id' | 'user_id' | 'kind'>, o: { persona: boolean; looks: boolean }) {
  if (b.kind === 'room') return;
  if (o.persona) syncPersona(b.id);
  if (o.looks && db.prepare('SELECT 1 FROM screens WHERE bot_id=?').get(b.id)) {
    readyScreen(b.user_id, b.id, { redress: true }).catch((e) => console.warn('[computer] redress failed', e?.message ?? e));
  }
}

/** A new workspace and its primary bot, together, so no workspace is ever without one. The bot greets the user. */
export function createWorkspaceWithBot(user: { id: string; username: string }, name: string, b: NewBot) {
  const made = db.transaction(() => {
    const ws = createWorkspace(user.id, name);
    return { ws, bot: createBot(user.id, b, ws.id) };
  })();
  hub.emit(user.id, { type: 'workspaces' });
  welcome(requireBot(made.bot.id), user.username);
  return made;
}

/**
 * Move an agent to another of the user's workspaces. It leaves its old team as a deleted bot would (its
 * tasks go back to nobody and the others hear it left), leaves the old workspace's group chats, and
 * joins the new team caught up. Questions to or from it end, since the bots on the other end are no
 * longer its teammates. Its chat, Library, routines and memory go with it. A primary bot stays until
 * another bot of its workspace is made primary.
 */
export function moveBot(b: BotRecord, to: WorkspaceRecord) {
  if (b.kind === 'room') throw new UserError('A group chat stays in its workspace.');
  if (b.is_primary) throw new UserError('Make another bot primary first.');
  if (to.user_id !== b.user_id) throw new Error('not the same user');
  if (to.id === b.workspace_id) return;
  const taken = nameInUse(to.id, b.name);
  if (taken) throw new UserError(`${taken} Rename one of them first.`);
  const from = requireWorkspace(b.workspace_id);
  dropAsks(b.id);
  db.transaction(() => {
    teamLeft(b, { moved: true });
    leaveRooms(b.id);
    db.prepare('UPDATE bots SET workspace_id=?, updated_at=? WHERE id=?').run(to.id, now(), b.id);
    teamJoined(requireBot(b.id));
  })();
  // The task tools come and go with the board, which the two workspaces may not agree on.
  if (!!from.task_board !== !!to.task_board) refreshTools([b.id]);
  hub.emit(b.user_id, { type: 'roster' });
}

/**
 * Delete a workspace: each of its bots and group chats goes as deleteBot takes one down, then its board,
 * news and check-ins with the workspace. The user's last workspace stays.
 */
export async function deleteWorkspace(ws: WorkspaceRecord) {
  if (workspacesOf(ws.user_id).length <= 1) throw new UserError('This is your only workspace.');
  const bots = db.prepare<[string], BotRecord>("SELECT * FROM bots WHERE workspace_id=? ORDER BY kind='room' DESC, created_at").all(ws.id);
  // Group chats first, so no member is left in one while it goes; each bot's row goes at once, its
  // computer is taken down after.
  const downs: Promise<void>[] = [];
  for (const b of bots) {
    const cur = getBotRow(b.id);
    if (cur) downs.push(deleteBot(cur));
  }
  db.prepare('DELETE FROM workspaces WHERE id=?').run(ws.id);
  hub.emit(ws.user_id, { type: 'workspaces' });
  hub.emit(ws.user_id, { type: 'tasks' });
  await Promise.all(downs);
}

/**
 * The one person who uses the app: the oldest user. On first start there is none yet, so its row is
 * made without an account. The first visit names it and sets the password (lib/auth.ts); then the web
 * app's setup wizard makes the first bot and finishes setup (finishSetup).
 */
export function ensureOwner(): User {
  const existing = db.prepare<[], UserRecord>('SELECT * FROM users ORDER BY created_at, rowid LIMIT 1').get();
  if (existing) return toUser(existing);
  const id = newId('usr');
  // Approvals start on Smart, the column's default. The account's bots start in a workspace called Personal.
  db.prepare('INSERT INTO users(id,created_at) VALUES (?,?)').run(id, now());
  defaultWorkspace(id);
  return toUser(db.prepare<[string], UserRecord>('SELECT * FROM users WHERE id=?').get(id)!);
}

/**
 * First-run setup: after creating the account the user makes their first bot in the web app's wizard
 * (its name, look, label, About, instructions and model), which ends with finishSetup. Until then `GET /api/auth/me` says
 * `needsSetup`, and a bot made meanwhile holds back its greeting, since it has no model to answer with yet.
 */
export function setupPending(userId: string): boolean {
  return db.prepare<[string], Pick<UserRecord, 'setup_at'>>('SELECT setup_at FROM users WHERE id=?').get(userId)?.setup_at == null;
}

/**
 * The wizard's last step. The first bot greets the user now, unless they left its model for later: a
 * turn without one would only fail. Finishing again does nothing.
 */
export function finishSetup(user: User, greet: boolean) {
  const first = db.prepare('UPDATE users SET setup_at=? WHERE id=? AND setup_at IS NULL').run(now(), user.id).changes > 0;
  const bot = primaryBot(defaultWorkspace(user.id).id);
  if (first && greet && bot) welcome(bot, user.username);
}

/**
 * Delete a bot and everything it runs. Its row goes first (its rows and routines with it), so
 * from then on requests about it fail, new turns for it are not queued and its MCP token stops
 * working. Then what runs for it on the computer is taken down: its turn, its sign-in, its gateway and home, its
 * screen (whose lease is freed last), its slice with whatever of the bot's still runs in it, and only
 * then its Chrome profile and Library folder, so nothing is still writing there. A group runs nothing, so only
 * its folder of attached files goes. A cleanup step that fails is logged and the rest still runs; the
 * bot is gone either way.
 *
 * Taking it down can take minutes (a unit may take two to stop), and the server may stop meanwhile.
 * So the row's delete also records the bot in `deleted_bots`, which keeps its gateway's port from new
 * bots (engine.ts freePort) until the job is done, and a restart finishes it (finishDeletions).
 */
export async function deleteBot(b: BotRecord) {
  const routines = listRoutines(b.id);
  clearTurns(b.id);
  dropCalls(b.id);
  dropAsks(b.id);
  cancelBotSignIns(b.id);
  db.transaction(() => {
    // Its tasks go back to nobody, and the rest of the team hears it left.
    teamLeft(b);
    db.prepare('INSERT OR REPLACE INTO deleted_bots(id,kind,engine_port,deleted_at) VALUES (?,?,?,?)').run(b.id, b.kind, b.engine_port, now());
    db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  })();
  hub.emit(b.user_id, { type: 'roster' });
  for (const r of routines) unscheduleRoutine(r.id);
  await takeDown({ id: b.id, kind: b.kind });
}

/** What a deleted bot ran on the computer, taken down in deleteBot's order; then its record in `deleted_bots` goes. */
async function takeDown(b: Pick<DeletedBotRecord, 'id' | 'kind'>) {
  if (b.kind !== 'room') {
    await removeEngine(b.id).catch((e) => console.warn('[engine] remove failed', e?.message ?? e));
    await releaseScreen(b.id).catch((e) => console.warn('[computer] release failed', e?.message ?? e));
    await removeBotUnits(b.id).catch((e) => console.warn('[units] removing the bot\'s units failed', e?.message ?? e));
  }
  await forgetBotFiles(b.id).catch((e) => console.warn('[computer] cleanup failed', e?.message ?? e));
  db.prepare('DELETE FROM deleted_bots WHERE id=?').run(b.id);
}

/**
 * On server start: deletions the last process didn't finish, one at a time. A screen lease whose bot
 * is gone with no record of its deletion (left by a version that kept none) is taken down the same
 * way, so its display number comes back.
 */
export async function finishDeletions() {
  const left = db.prepare<[], DeletedBotRecord>('SELECT * FROM deleted_bots ORDER BY deleted_at').all();
  const orphans = db.prepare<[], { bot_id: string }>('SELECT bot_id FROM screens WHERE bot_id NOT IN (SELECT id FROM bots) AND bot_id NOT IN (SELECT id FROM deleted_bots)').all();
  for (const o of orphans) db.prepare("INSERT INTO deleted_bots(id,kind,engine_port,deleted_at) VALUES (?,'agent',NULL,?)").run(o.bot_id, now());
  for (const b of [...left, ...orphans.map((o) => ({ id: o.bot_id, kind: 'agent' }))]) {
    console.log(`[bots] finishing the deletion of ${b.id}, which the last process left unfinished`);
    await takeDown(b);
  }
}
