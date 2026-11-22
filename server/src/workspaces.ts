import { db, now, type WorkspaceRecord } from './db.js';
import { newId } from './lib/ids.js';
import type { Workspace } from './types.js';
import { getCheckins } from './proactive.js';

/**
 * Workspaces: separate teams of bots under the one account, like the workspaces of a chat app.
 *
 * Each workspace has its own bots and group chats, one primary bot, a task board (which it may turn
 * off) and check-ins. A bot knows of and reaches only the bots of its own workspace: the roster in its
 * instructions (agent/prompt.ts), its tools that name a teammate or a group (agent/tools.ts), the board
 * and the team news (agent/team.ts) all look in `bots.workspace_id`. Provider settings, approvals and
 * the computer stay shared, and every bot runs as the one account, so this keeps the teams apart in the
 * app, not on the disk.
 *
 * Every account has at least one workspace: the first, Personal, is made with the account (bots.ts
 * ensureOwner) or by migration 5 for an account from before. Making another one makes its primary bot in
 * the same request (POST /api/workspaces), so no workspace is ever without one; deleting a workspace
 * deletes its bots first (bots.ts deleteWorkspace), and the last one can't be deleted.
 */

export const WORKSPACE_NAME_MAX = 40;
export const DEFAULT_WORKSPACE_NAME = 'Personal';

const byId = db.prepare<[string], WorkspaceRecord>('SELECT * FROM workspaces WHERE id=?');
const ofUser = db.prepare<[string], WorkspaceRecord>('SELECT * FROM workspaces WHERE user_id=? ORDER BY position, created_at');

export const getWorkspace = (id: string): WorkspaceRecord | undefined => byId.get(id);

/** The workspace, for code that runs only while it exists; throws when it doesn't. */
export function requireWorkspace(id: string): WorkspaceRecord {
  const w = byId.get(id);
  if (!w) throw new Error(`no workspace ${id}`);
  return w;
}

/** The workspace, if it exists and belongs to this user; routes use it to 404 everything else. */
export function ownWorkspace(userId: string, id: string | undefined): WorkspaceRecord | null {
  const w = id ? byId.get(id) : undefined;
  return w && w.user_id === userId ? w : null;
}

export const workspacesOf = (userId: string): WorkspaceRecord[] => ofUser.all(userId);

export function toWorkspace(w: WorkspaceRecord): Workspace {
  return { id: w.id, name: w.name, taskBoard: !!w.task_board, checkins: getCheckins(w.id), createdAt: w.created_at };
}

export const listWorkspaces = (userId: string): Workspace[] => workspacesOf(userId).map(toWorkspace);

/** A new workspace, last in the switcher. Its caller makes its primary bot in the same transaction. */
export function createWorkspace(userId: string, name: string): WorkspaceRecord {
  const id = newId('ws');
  const last = db.prepare<[string], { p: number | null }>('SELECT MAX(position) p FROM workspaces WHERE user_id=?').get(userId)?.p;
  db.prepare('INSERT INTO workspaces(id,user_id,name,position,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, name.trim().slice(0, WORKSPACE_NAME_MAX) || DEFAULT_WORKSPACE_NAME, last == null ? 0 : last + 1, now(), now());
  return requireWorkspace(id);
}

/** The user's first workspace, where a bot goes when nothing says which. Made, as Personal, if there is none. */
export function defaultWorkspace(userId: string): WorkspaceRecord {
  return ofUser.get(userId) ?? createWorkspace(userId, DEFAULT_WORKSPACE_NAME);
}

/** Whether the workspace uses the task board. A bot in one that doesn't is offered no task tools. */
export const boardOn = (workspaceId: string) => !!byId.get(workspaceId)?.task_board;

/** The agents in the workspace, oldest first. */
export const workspaceAgents = (workspaceId: string) =>
  db.prepare<[string], { id: string }>("SELECT id FROM bots WHERE workspace_id=? AND kind<>'room' ORDER BY created_at").all(workspaceId).map((b) => b.id);
