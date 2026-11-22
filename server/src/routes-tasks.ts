import { Hono } from 'hono';
import { z } from 'zod';
import { body } from './lib/validate.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { addTask, changeTask, getTask, listTasks, removeTask, taskOwner } from './agent/team.js';
import { wake } from './agent/turns.js';
import { TASK_STATUSES } from './types.js';
import type { Ok, TaskResponse, TasksResponse } from './contract.js';

/**
 * /api/tasks: the team's task board, as the user sees and changes it in the app. The bots change the
 * same board with their tools; agent/team.ts tells each of them what concerns it either way. A task the
 * user gives a bot wakes it, so it starts on it.
 */
export const tasksApi = new Hono<AuthVars>();
tasksApi.use('*', requireUser);

const Title = z.string().trim().min(1, 'a task needs a title').max(200);
const Notes = z.string().max(8000);
/** An owner: one of the user's agents (checked in the route), or null for nobody. */
const Owner = z.string().nullable();

tasksApi.get('/', (c) => c.json({ tasks: listTasks(c.get('user').id) } satisfies TasksResponse));

tasksApi.post('/', async (c) => {
  const user = c.get('user');
  const p = await body(c, z.object({ title: Title, notes: Notes.default(''), ownerId: Owner.default(null), status: z.enum(TASK_STATUSES).default('todo') }));
  if (p.ownerId && !taskOwner(user.id, p.ownerId)) return c.json({ error: 'No such bot.' }, 400);
  const r = addTask(user.id, { kind: 'user' }, p);
  if (r.given) wake(r.given, 0);
  return c.json({ task: r.task } satisfies TaskResponse);
});

tasksApi.patch('/:id', async (c) => {
  const user = c.get('user');
  const p = await body(c, z.object({ title: Title.optional(), notes: Notes.optional(), ownerId: Owner.optional(), status: z.enum(TASK_STATUSES).optional() }));
  if (!getTask(user.id, c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  if (p.ownerId && !taskOwner(user.id, p.ownerId)) return c.json({ error: 'No such bot.' }, 400);
  const r = changeTask(user.id, { kind: 'user' }, c.req.param('id'), p);
  if (!r) return c.json({ error: 'not found' }, 404);
  if (r.given) wake(r.given, 0);
  return c.json({ task: r.task } satisfies TaskResponse);
});

tasksApi.delete('/:id', (c) => {
  if (!removeTask(c.get('user').id, { kind: 'user' }, c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true } satisfies Ok);
});
