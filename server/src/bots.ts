import { db, now, type BotRecord, type UserRecord } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { toUser } from './lib/auth.js';
import { assignEngine, provisionEngine, removeEngine } from './engine.js';
import { getBot, listRoutines } from './store.js';
import { clear as clearTurns, enqueue } from './agent/turns.js';
import { unscheduleRoutine } from './routines.js';
import { forgetBotFiles, releaseScreen } from './computer.js';
import { dropCalls } from './voice.js';
import { cancelBotSignIns } from './signin.js';
import { NEW_BOT_VOICES } from './speech.js';
import { removeBotUnits } from './units.js';
import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarColor, type AvatarShape, type User } from './types.js';

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

/** The user's primary bot, if they have made a bot yet. */
export const primaryBot = (userId: string) =>
  db.prepare<[string], BotRecord>("SELECT * FROM bots WHERE user_id=? AND is_primary=1 AND kind<>'room' ORDER BY created_at LIMIT 1").get(userId);

export function createBot(userId: string, b: { name: string; label?: string; description?: string; instructions?: string; avatarShape?: string; avatarColor?: string }) {
  // Every bot runs a screen, a Chrome and an agent of its own on the one computer.
  if (agentCount() >= env.maxBots) throw new UserError(`The team is full: the computer has room for ${env.maxBots} bots. Remove one to add another.`);
  const id = newId('bot');
  const shape = SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, SHAPES);
  const color = COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  const voice = hashPick(id, NEW_BOT_VOICES);
  // The first bot is the primary one: the user's main point of contact, and the bot later ones copy
  // their model and sign-ins from (engine.ts).
  const primary = !primaryBot(userId);
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,is_primary,voice,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, b.name.trim().slice(0, 60) || 'New Bot', (b.label ?? '').trim().slice(0, 60), (b.description ?? '').trim().slice(0, 500), (b.instructions ?? '').trim().slice(0, 8000), shape, color, primary ? 1 : 0, voice, now(), now());
  assignEngine(id);
  provisionEngine(id);
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}

/** A new bot's first turn: it says hello and asks what it should help with. */
export function welcome(bot: Pick<BotRecord, 'id' | 'name'>, username: string) {
  enqueue(bot.id, { type: 'system', text: `You were just created. Greet ${username} by name and introduce yourself as ${bot.name} in one or two short sentences, using what you already know about them if anything. Then call ask_user once with multiple set to true, asking what they would most like your help with, with up to four short options suited to them. Nothing else.` });
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
  // Approvals start on Smart, the column's default.
  db.prepare('INSERT INTO users(id,created_at) VALUES (?,?)').run(id, now());
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
  const bot = primaryBot(user.id);
  if (first && greet && bot) welcome(bot, user.username);
}

/**
 * Delete a bot and everything it runs. Its row goes first (its rows and routines with it), so
 * from then on requests about it fail, new turns for it are not queued and its MCP token stops
 * working. Then what runs for it on the computer is taken down: its turn, its sign-in, its gateway and home, its
 * screen (whose lease is freed last), its slice with whatever of the bot's still runs in it, and only
 * then its Chrome profile and Library, so nothing is still writing there. A group runs nothing, so only
 * its folder of attached files goes. A cleanup step that fails is logged and the rest still runs; the
 * bot is gone either way.
 */
export async function deleteBot(b: BotRecord) {
  const routines = listRoutines(b.id);
  clearTurns(b.id);
  dropCalls(b.id);
  cancelBotSignIns(b.id);
  db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  hub.emit(b.user_id, { type: 'roster' });
  for (const r of routines) unscheduleRoutine(r.id);
  if (b.kind === 'room') {
    await forgetBotFiles(b.id).catch((e) => console.warn('[computer] cleanup failed', e?.message ?? e));
    return;
  }
  await removeEngine(b.id, b.engine_port).catch((e) => console.warn('[engine] remove failed', e?.message ?? e));
  await releaseScreen(b.id).catch((e) => console.warn('[computer] release failed', e?.message ?? e));
  await removeBotUnits(b.id).catch((e) => console.warn('[units] removing the bot\'s units failed', e?.message ?? e));
  await forgetBotFiles(b.id).catch((e) => console.warn('[computer] cleanup failed', e?.message ?? e));
}
