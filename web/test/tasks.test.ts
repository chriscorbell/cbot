import { expect, test } from 'vitest';
import type { Task } from '@shared/types';
import { changedAgo, creatorText, plateOf, tasksByStatus } from '../src/lib/tasks';

const task = (id: string, p: Partial<Task> = {}): Task => ({
  id, workspaceId: 'ws_1', title: id, notes: '', status: 'todo', ownerId: null, previousOwner: null, createdBy: null, createdAt: 0, updatedAt: 0, ...p,
});

test('the board has a column for every status, in order, each newest change first', () => {
  const cols = tasksByStatus([
    task('a', { status: 'doing', updatedAt: 1 }),
    task('b', { status: 'done', updatedAt: 5 }),
    task('c', { status: 'doing', updatedAt: 3 }),
  ]);
  expect(Object.keys(cols)).toEqual(['todo', 'doing', 'blocked', 'done']);
  expect(cols.doing.map((t) => t.id)).toEqual(['c', 'a']);
  expect(cols.todo).toEqual([]);
  expect(cols.done.map((t) => t.id)).toEqual(['b']);
});

test("a bot's plate is its unfinished tasks: what it is doing, then what holds it up, then what waits", () => {
  const plate = plateOf([
    task('waits', { ownerId: 'kai', status: 'todo', updatedAt: 9 }),
    task('done', { ownerId: 'kai', status: 'done' }),
    task('other', { ownerId: 'ava', status: 'doing' }),
    task('stuck', { ownerId: 'kai', status: 'blocked' }),
    task('older', { ownerId: 'kai', status: 'doing', updatedAt: 1 }),
    task('newer', { ownerId: 'kai', status: 'doing', updatedAt: 2 }),
  ], 'kai');
  expect(plate.map((t) => t.id)).toEqual(['newer', 'older', 'stuck', 'waits']);
});

test('a task says who added it and when it last changed', () => {
  expect(creatorText(task('a'))).toBe('from you');
  expect(creatorText(task('a', { createdBy: { id: 'bot_1', name: 'Ava' } }))).toBe('from Ava');
  const now = 1_000_000_000;
  expect(changedAgo(now - 10_000, now)).toBe('just now');
  expect(changedAgo(now - 5 * 60_000, now)).toBe('5m ago');
  expect(changedAgo(now - 30 * 3600_000, now)).toBe('yesterday');
  expect(changedAgo(now - 3 * 86_400_000, now)).toBe('3d ago');
});
