import { db, now, type BotRecord, type RowRecord } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow, markUnread, requireBot } from '../store.js';
import { copyToUploads, filesNote, uploadsDir } from '../library.js';
import type { Attachment } from '../types.js';
import type { Trigger } from './turns.js';

/**
 * Group chats ("rooms").
 * A room is a bot row with kind='room' and a members list, all from the room's workspace. It never runs its own agent loop:
 * a user message is dispatched to the members who should answer (@mentioned ones, else all,
 * capped), each member runs its normal loop with the group context and replies into the room
 * with post_to_group.
 *
 * Files attached in a room are uploaded to the room's own folder, which its chat shows them from.
 * Sending the message copies them into every member's Library, the bot's working folder, as a file
 * attached in its own chat would be. Every member gets them, not only the ones asked to answer, since
 * a later message may ask another; each copy is the bot's own to change.
 */

const MAX_RESPONDERS = 3;

export function roomMembers(roomId: string): { id: string; name: string }[] {
  const r = db.prepare<[string], Pick<BotRecord, 'members'>>('SELECT members FROM bots WHERE id=?').get(roomId);
  const ids: string[] = r?.members ? JSON.parse(r.members) : [];
  const byId = db.prepare<[string], Pick<BotRecord, 'id' | 'name'>>('SELECT id, name FROM bots WHERE id=?');
  return ids.map((id) => byId.get(id)).filter((m) => m !== undefined);
}

/** A group chat in the workspace. Its caller has checked the members are agents of that workspace. */
export function createRoom(userId: string, workspaceId: string, name: string, memberIds: string[]) {
  const id = newId('room');
  db.prepare(
    `INSERT INTO bots(id,user_id,workspace_id,name,label,description,avatar_shape,avatar_color,kind,members,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,'room',?,?,?)`,
  ).run(id, userId, workspaceId, name.slice(0, 60), 'Group', '', 'cloud', 'gray', JSON.stringify(memberIds), now(), now());
  hub.emit(userId, { type: 'roster' });
  return id;
}

/** The workspace's agents among `ids`, each once: who may be in one of its group chats. */
export const workspaceMembers = (workspaceId: string, ids: string[]) =>
  [...new Set(ids)].filter((id) => db.prepare("SELECT 1 FROM bots WHERE id=? AND workspace_id=? AND kind<>'room'").get(id, workspaceId));

/** The bot leaves every group chat it is in (it is moving to another workspace), and each says so. */
export function leaveRooms(botId: string) {
  const bot = requireBot(botId);
  const rooms = db.prepare<[string, string], Pick<BotRecord, 'id' | 'members'>>("SELECT id, members FROM bots WHERE workspace_id=? AND kind='room' AND members LIKE ?").all(bot.workspace_id, `%${botId}%`);
  for (const r of rooms) {
    const members: string[] = r.members ? JSON.parse(r.members) : [];
    if (!members.includes(botId)) continue;
    db.prepare('UPDATE bots SET members=?, updated_at=? WHERE id=?').run(JSON.stringify(members.filter((m) => m !== botId)), now(), r.id);
    appendRow(r.id, 'event', { type: 'event', event: 'bot-message', text: `${bot.name} left` });
  }
}

export type MemberFiles = Map<string, { file: string; type: string; size: number }[]>;

/** Copy a message's attachments from the room's folder to each member. A copy that fails is left out. */
export async function copyToMembers(roomId: string, attachments: Attachment[]): Promise<MemberFiles> {
  const copies: MemberFiles = new Map();
  for (const m of roomMembers(roomId)) {
    const mine: { file: string; type: string; size: number }[] = [];
    for (const a of attachments) {
      const src = `${uploadsDir(roomId)}/${a.path.slice('uploads/'.length)}`;
      try {
        mine.push({ file: await copyToUploads(src, m.id), type: a.type, size: a.size });
      } catch (e) {
        console.warn(`[rooms] copying ${a.name} to ${m.id} failed`, (e as Error).message);
      }
    }
    copies.set(m.id, mine);
  }
  return copies;
}

/**
 * Called instead of the agent loop when the user posts in a room. `files` are each member's copies of
 * what the message attached (copyToMembers).
 */
export function dispatchRoomMessage(roomId: string, text: string, enqueue: (botId: string, t: Trigger) => void, files: MemberFiles = new Map()) {
  const room = requireBot(roomId);
  const members = roomMembers(roomId);
  if (!members.length) {
    appendRow(roomId, 'notice', { type: 'notice', text: 'This group has no Bots yet.', tone: 'warn' });
    return;
  }
  const lower = text.toLowerCase();
  const mentioned = members.filter((m) => lower.includes(`@${m.name.toLowerCase()}`));
  const responders = (mentioned.length ? mentioned : members).slice(0, MAX_RESPONDERS);
  const recent = db.prepare<[string, number], Pick<RowRecord, 'body'>>("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT 12").all(roomId, room.generation)
    .reverse()
    .map((r) => {
      const b = JSON.parse(r.body) as { from?: { name: string }; role: string; text: string; attachments?: Attachment[] };
      const attached = b.attachments?.length ? `[attached ${b.attachments.map((a) => a.name).join(', ')}, copied to your uploads folder]` : '';
      return `${b.from?.name ?? (b.role === 'user' ? 'User' : 'Bot')}: ${[String(b.text ?? '').slice(0, 600), attached].filter(Boolean).join(' ')}`;
    })
    .join('\n');
  for (const m of responders) {
    enqueue(m.id, {
      type: 'system',
      text:
        `[Group chat "${room.name}"] Members: ${members.map((x) => x.name).join(', ')}. ` +
        `${mentioned.length ? 'You were @mentioned.' : 'The user addressed the whole group.'}\n` +
        `Recent group messages:\n${recent}${filesNote(files.get(m.id) ?? [])}\n\n` +
        `Reply to the group by calling post_to_group with group_name "${room.name}" (use your tools first if the request needs real work). ` +
        `${room.instructions.trim() ? 'Follow the instructions for this group under "Group chats" in your system prompt. ' : ''}` +
        `Keep it short and don't repeat what other Bots already said. If you have nothing to add, call stay_silent. Do not write a normal reply.`,
    });
  }
}

export function postToRoom(fromBotId: string, roomName: string, text: string) {
  const from = requireBot(fromBotId);
  const room = db.prepare<[string, string], BotRecord>("SELECT * FROM bots WHERE workspace_id=? AND kind='room' AND lower(name)=lower(?)").get(from.workspace_id, roomName.trim());
  if (!room) return `No group named "${roomName}".`;
  const members: string[] = room.members ? JSON.parse(room.members) : [];
  if (!members.includes(fromBotId)) return `You're not a member of "${room.name}".`;
  appendRow(room.id, 'message', { type: 'message', role: 'assistant', text, from: { kind: 'bot', id: from.id, name: from.name } });
  markUnread(room.id);
  return 'Posted to the group.';
}
