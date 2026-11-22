import { Hono } from 'hono';
import { z } from 'zod';
import { body } from './lib/validate.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { addTask, changeTask, removeTask, taskOwner, userTask, userTasks } from './agent/team.js';
import { wake } from './agent/turns.js';
import { defaultWorkspace, ownWorkspace } from './workspaces.js';
import { TASK_STATUSES } from './types.js';
import type { Ok, TaskResponse, TasksResponse } from './contract.js';

/**
 * /api/tasks: the task boards, as the user sees and changes them in the app. Each workspace has its own
 * (a task's `workspaceId`), and the app shows the one of the workspace it is in. The bots change the
 * same boards with their tools; agent/team.ts tells each of them what concerns it either way. A task the
 * user gives a bot wakes it, so it starts on it. A workspace that has turned its board off takes no
 * new tasks; the ones it has wait for it to come back on.
 */
export const tasksApi = new Hono<AuthVars>();
tasksApi.use('*', requireUser);

const Title = z.string().trim().min(1, 'a task needs a title').max(200);
const Notes = z.string().max(8000);
/** An owner: one of the workspace's agents (checked in the route), or null for nobody. */
const Owner = z.string().nullable();
const BOARD_OFF = 'The task board is turned off in this workspace.';

tasksApi.get('/', (c) => c.json({ tasks: userTasks(c.get('user').id) } satisfies TasksResponse));

tasksApi.post('/', async (c) => {
  const user = c.get('user');
  const p = await body(c, z.object({ title: Title, notes: Notes.default(''), ownerId: Owner.default(null), status: z.enum(TASK_STATUSES).default('todo'), workspaceId: z.string().optional() }));
  const ws = p.workspaceId ? ownWorkspace(user.id, p.workspaceId) : defaultWorkspace(user.id);
  if (!ws) return c.json({ error: 'not found' }, 404);
  if (!ws.task_board) return c.json({ error: BOARD_OFF }, 409);
  if (p.ownerId && !taskOwner(ws.id, p.ownerId)) return c.json({ error: 'No such bot.' }, 400);
  const r = addTask(ws.id, { kind: 'user' }, { title: p.title, notes: p.notes, ownerId: p.ownerId, status: p.status });
  if (r.given) wake(r.given, 0);
  return c.json({ task: r.task } satisfies TaskResponse);
});

tasksApi.patch('/:id', async (c) => {
  const user = c.get('user');
  const p = await body(c, z.object({ title: Title.optional(), notes: Notes.optional(), ownerId: Owner.optional(), status: z.enum(TASK_STATUSES).optional() }));
  const cur = userTask(user.id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  if (!ownWorkspace(user.id, cur.workspace_id)?.task_board) return c.json({ error: BOARD_OFF }, 409);
  if (p.ownerId && !taskOwner(cur.workspace_id, p.ownerId)) return c.json({ error: 'No such bot.' }, 400);
  const r = changeTask(cur.workspace_id, { kind: 'user' }, cur.id, p);
  if (!r) return c.json({ error: 'not found' }, 404);
  if (r.given) wake(r.given, 0);
  return c.json({ task: r.task } satisfies TaskResponse);
});

tasksApi.delete('/:id', (c) => {
  const cur = userTask(c.get('user').id, c.req.param('id'));
  if (!cur || !removeTask(cur.workspace_id, { kind: 'user' }, cur.id)) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true } satisfies Ok);
});
