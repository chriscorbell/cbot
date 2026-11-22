import { Hono } from 'hono';
import { z } from 'zod';
import { body } from './lib/validate.js';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { errorText } from './lib/errors.js';
import { createWorkspaceWithBot, deleteWorkspace, UserError } from './bots.js';
import { refreshTools } from './engine.js';
import { fireCheckin, setCheckins } from './proactive.js';
import { listWorkspaces, ownWorkspace, toWorkspace, workspaceAgents, WORKSPACE_NAME_MAX } from './workspaces.js';
import type { Ok, WorkspaceCreated, WorkspaceResponse, WorkspacesResponse } from './contract.js';

/**
 * /api/workspaces: the user's workspaces (workspaces.ts). Making one makes its primary bot with it;
 * changing one renames it, turns its task board on or off, or sets its check-ins (proactive.ts).
 */
export const workspacesApi = new Hono<AuthVars>();
workspacesApi.use('*', requireUser);

const Name = z.string().trim().min(1, 'A workspace needs a name.').max(WORKSPACE_NAME_MAX);

workspacesApi.get('/', (c) => c.json({ workspaces: listWorkspaces(c.get('user').id) } satisfies WorkspacesResponse));

/** A new workspace and its first bot, which becomes its primary bot and says hello. */
workspacesApi.post('/', async (c) => {
  const user = c.get('user');
  const p = await body(c, z.object({
    name: Name,
    bot: z.object({ name: z.string().trim().min(1, 'Name the first bot.'), avatarShape: z.string().optional(), avatarColor: z.string().optional(), label: z.string().optional(), description: z.string().optional() }),
  }));
  try {
    const { ws, bot } = createWorkspaceWithBot(user, p.name, p.bot);
    return c.json({ workspace: toWorkspace(ws), bot } satisfies WorkspaceCreated);
  } catch (e) {
    if (e instanceof UserError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

workspacesApi.patch('/:id', async (c) => {
  const user = c.get('user');
  const p = await body(c, z.object({
    name: Name.optional(),
    taskBoard: z.boolean().optional(),
    checkins: z.object({ enabled: z.boolean().optional(), times: z.array(z.string()).optional(), timezone: z.string().optional() }).optional(),
  }));
  const ws = ownWorkspace(user.id, c.req.param('id'));
  if (!ws) return c.json({ error: 'not found' }, 404);
  if (p.checkins) {
    try {
      setCheckins(ws.id, p.checkins);
    } catch (e) {
      return c.json({ error: `That time zone isn't one we know: ${errorText(e)}` }, 400);
    }
  }
  if (p.name !== undefined) db.prepare('UPDATE workspaces SET name=?, updated_at=? WHERE id=?').run(p.name, now(), ws.id);
  if (p.taskBoard !== undefined && p.taskBoard !== !!ws.task_board) {
    db.prepare('UPDATE workspaces SET task_board=?, updated_at=? WHERE id=?').run(p.taskBoard ? 1 : 0, now(), ws.id);
    // The board's tools come or go for every bot of the workspace.
    refreshTools(workspaceAgents(ws.id));
    hub.emit(user.id, { type: 'tasks' });
  }
  hub.emit(user.id, { type: 'workspaces' });
  return c.json({ workspace: toWorkspace(ownWorkspace(user.id, ws.id)!) } satisfies WorkspaceResponse);
});

/** Delete a workspace with every bot and group chat in it. The user's last one stays. */
workspacesApi.delete('/:id', async (c) => {
  const ws = ownWorkspace(c.get('user').id, c.req.param('id'));
  if (!ws) return c.json({ error: 'not found' }, 404);
  try {
    await deleteWorkspace(ws);
  } catch (e) {
    if (e instanceof UserError) return c.json({ error: e.message }, 409);
    throw e;
  }
  return c.json({ ok: true } satisfies Ok);
});

/** Settings' "Check in now": the workspace's primary bot checks in at once. */
workspacesApi.post('/:id/checkin', (c) => {
  const ws = ownWorkspace(c.get('user').id, c.req.param('id'));
  if (!ws) return c.json({ error: 'not found' }, 404);
  if (!fireCheckin(ws.id, true)) return c.json({ error: 'This workspace has no primary bot to check in.' }, 409);
  return c.json({ ok: true } satisfies Ok);
});
