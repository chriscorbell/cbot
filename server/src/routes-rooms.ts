import { Hono } from 'hono';
import { z } from 'zod';
import { body } from './lib/validate.js';
import { db, now, type BotRecord } from './db.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { appendRow } from './store.js';
import { createRoom, roomMembers, workspaceMembers } from './agent/rooms.js';
import { defaultWorkspace, nameInUse, ownWorkspace } from './workspaces.js';
import type { RoomCreated, RoomMembersResponse, RoomMembersSet } from './contract.js';

/** /api/rooms: group chat membership. A room is a bot row with kind='room'; its members are agents of its workspace. */
export const roomsApi = new Hono<AuthVars>();
roomsApi.use('*', requireUser);

const ownRoom = (userId: string, id: string) =>
  db.prepare<[string, string], BotRecord>("SELECT * FROM bots WHERE id=? AND user_id=? AND kind='room'").get(id, userId);

roomsApi.get('/:id/members', (c) => {
  const room = ownRoom(c.get('user').id, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const members = roomMembers(room.id).map((m) => {
    const b = db.prepare<[string], Pick<BotRecord, 'id' | 'name' | 'label' | 'avatar_shape' | 'avatar_color'>>('SELECT id, name, label, avatar_shape, avatar_color FROM bots WHERE id=?').get(m.id)!;
    return { id: b.id, name: b.name, label: b.label, avatarShape: b.avatar_shape, avatarColor: b.avatar_color };
  });
  return c.json({ members } satisfies RoomMembersResponse);
});

/** Create a group from the UI: { name, botIds[], workspaceId }. */
roomsApi.post('/', async (c) => {
  const user = c.get('user');
  const p = await body(c, z.object({ name: z.string().default(''), botIds: z.array(z.string()).default([]), workspaceId: z.string().optional() }));
  const ws = p.workspaceId ? ownWorkspace(user.id, p.workspaceId) : defaultWorkspace(user.id);
  if (!ws) return c.json({ error: 'not found' }, 404);
  const valid = workspaceMembers(ws.id, p.botIds);
  if (!p.name.trim() || valid.length < 2) return c.json({ error: 'A group needs a name and at least 2 Bots.' }, 400);
  const taken = nameInUse(ws.id, p.name);
  if (taken) return c.json({ error: taken }, 409);
  const id = createRoom(user.id, ws.id, p.name.trim(), valid);
  return c.json({ id } satisfies RoomCreated);
});

roomsApi.put('/:id/members', async (c) => {
  const user = c.get('user');
  const room = ownRoom(user.id, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const { botIds } = await body(c, z.object({ botIds: z.array(z.string()).default([]) }));
  const before = new Set(roomMembers(room.id).map((m) => m.id));
  const next = workspaceMembers(room.workspace_id, botIds);
  db.prepare('UPDATE bots SET members=?, updated_at=? WHERE id=?').run(JSON.stringify(next), now(), room.id);
  const name = (id: string) => db.prepare<[string], Pick<BotRecord, 'name'>>('SELECT name FROM bots WHERE id=?').get(id)?.name ?? id;
  const added = next.filter((id) => !before.has(id)).map(name);
  const removed = [...before].filter((id) => !next.includes(id)).map(name);
  if (added.length || removed.length) {
    appendRow(room.id, 'event', { type: 'event', event: 'bot-message', text: [added.length ? `${added.join(', ')} joined` : '', removed.length ? `${removed.join(', ')} left` : ''].filter(Boolean).join(' · ') });
  }
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true, members: next } satisfies RoomMembersSet);
});
