import { TASK_STATUSES, type Task, type TaskStatus } from '@shared/types';
import { relativeShort } from './time';

/** What each column of the board and each status pick says. */
export const STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', doing: 'Doing', blocked: 'Blocked', done: 'Done' };

/** Newest change first: what moved last is at the top of its column. */
const byLatest = (a: Task, b: Task) => b.updatedAt - a.updatedAt;

/** The board's columns, in TASK_STATUSES order, each with its tasks newest change first. */
export function tasksByStatus(tasks: readonly Task[]): Record<TaskStatus, Task[]> {
  const out = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as Task[]])) as Record<TaskStatus, Task[]>;
  for (const t of tasks) out[t.status].push(t);
  for (const s of TASK_STATUSES) out[s].sort(byLatest);
  return out;
}

/** What a bot has on its plate: its tasks that aren't done, what it is doing first, then what holds it up, then what waits. */
const PLATE_ORDER: Record<TaskStatus, number> = { doing: 0, blocked: 1, todo: 2, done: 3 };
export function plateOf(tasks: readonly Task[], botId: string): Task[] {
  return tasks
    .filter((t) => t.ownerId === botId && t.status !== 'done')
    .sort((a, b) => PLATE_ORDER[a.status] - PLATE_ORDER[b.status] || byLatest(a, b));
}

/** Who put the task on the board: "from you" or "from Ava". */
export const creatorText = (t: Pick<Task, 'createdBy'>) => (t.createdBy ? `from ${t.createdBy.name}` : 'from you');

/** "just now", "5m ago", "yesterday", "3d ago": when a task last changed. */
export function changedAgo(ts: number, now = Date.now()): string {
  const r = relativeShort(ts, now);
  return r === 'now' ? 'just now' : r === 'Yesterday' ? 'yesterday' : `${r} ago`;
}
