import type { ApprovalChoice, Attachment, Bot, CheckinSettings, TaskStatus } from '@shared/types';
import type {
  BotResponse, BotsResponse, ComputerResponse, MeResponse, NotificationTestResponse, NotificationsResponse, Ok, RoomCreated, RoomMembersResponse, RoomMembersSet, SearchResponse,
  RoutineResponse, RoutinesResponse, RowResponse, RowsResponse, TaskResponse, TasksResponse, UploadResponse,
  WorkspaceCreated, WorkspaceResponse, WorkspacesResponse,
} from '@shared/contract';
import { request as req, sendKeepalive, upload } from './http';

export { ApiError } from './http';
export type { RoomMember } from '@shared/contract';

/** A message's reaction; null clears it. */
export type RowPatch = { reaction?: string | null };

/** A new task on the team's board. `ownerId` null leaves it unassigned; a bot given one is told and starts on it. */
export interface TaskInput { title: string; notes?: string; ownerId?: string | null; status?: TaskStatus }
/** The fields of a task that change; the ones left out stay as they are. */
export type TaskPatch = Partial<TaskInput>;

/** What a workspace's settings change; the ones left out stay as they are. */
export interface WorkspacePatch { name?: string; taskBoard?: boolean; checkins?: Partial<CheckinSettings> }
/** A new bot's name and look, as the create-bot form sends them. */
export type NewBot = Pick<Bot, 'name' | 'avatarShape' | 'avatarColor'> & Partial<Pick<Bot, 'label' | 'description' | 'instructions'>>;

export const api = {
  me: () => req<MeResponse>('GET', '/auth/me'),
  setup: (username: string, password: string, code: string) => req<MeResponse>('POST', '/auth/setup', { username, password, code }),
  login: (username: string, password: string) => req<MeResponse>('POST', '/auth/login', { username, password }),
  logout: () => req<Ok>('POST', '/auth/logout'),
  changePassword: (current: string, next: string) => req<Ok>('POST', '/auth/password', { current, next }),

  bots: () => req<BotsResponse>('GET', '/bots'),
  search: (q: string) => req<SearchResponse>('GET', `/search?q=${encodeURIComponent(q)}`),
  /** A new bot, in the workspace named (the first one otherwise). The setup wizard's first one also brings its job; it greets once setup finishes. */
  createBot: (b: NewBot & { workspaceId?: string }) => req<BotResponse>('POST', '/bots', b),
  /** Move a bot to another workspace: it leaves its team, its tasks and its group chats there. */
  moveBot: (id: string, workspaceId: string) => req<BotResponse>('POST', `/bots/${id}/move`, { workspaceId }),
  finishSetup: (greet: boolean) => req<Ok>('POST', '/setup/finish', { greet }),
  markRead: (id: string) => req<Ok>('POST', `/bots/${id}/read`),
  markUnread: (id: string) => req<Ok>('POST', `/bots/${id}/unread`),
  setFlags: (id: string, p: { sidebarHidden?: boolean }) => req<BotResponse>('PATCH', `/bots/${id}`, p),
  rows: (id: string) => req<RowsResponse>('GET', `/bots/${id}/rows`),
  send: (id: string, text: string, attachments?: Attachment[]) => req<RowResponse>('POST', `/bots/${id}/messages`, { text, ...(attachments?.length ? { attachments } : {}) }),
  /** Saves files in the bot's Library (uploads/), ready to attach to a message. */
  upload: async (id: string, file: File): Promise<Attachment> => {
    const form = new FormData();
    form.append('file', file, file.name);
    return (await upload<UploadResponse>(`/bots/${id}/files/upload`, form, `${file.name} is too large`)).files[0];
  },
  interrupt: (id: string) => req<Ok>('POST', `/bots/${id}/interrupt`),
  fresh: (id: string) => req<Ok>('POST', `/bots/${id}/fresh`),

  /** Answers Hermes' approval prompt (server/src/agent/approvals.ts). */
  approve: (approvalId: string, choice: ApprovalChoice) => req<Ok>('POST', `/approvals/${approvalId}`, { choice }),
  /** `generation` is the chat the question is in; the server refuses an answer to a cleared chat. */
  answer: (id: string, seq: number, generation: number, answer: string) => req<Ok>('POST', `/bots/${id}/cards/${seq}/answer`, { answer, generation }),
  /** Use the store's `patchRow`, which shows the change at once. */
  patchRow: (id: string, seq: number, generation: number | undefined, p: RowPatch) => req<Ok>('PATCH', `/bots/${id}/rows/${seq}`, { ...p, generation }),

  routines: (id: string) => req<RoutinesResponse>('GET', `/bots/${id}/routines`),
  setRoutine: (rid: string, enabled: boolean) => req<RoutineResponse>('PATCH', `/routines/${rid}`, { enabled }),

  computer: () => req<ComputerResponse>('GET', '/computer'),

  roomMembers: (id: string) => req<RoomMembersResponse>('GET', `/rooms/${id}/members`),
  setRoomMembers: (id: string, botIds: string[]) => req<RoomMembersSet>('PUT', `/rooms/${id}/members`, { botIds }),
  createRoom: (name: string, botIds: string[], workspaceId: string) => req<RoomCreated>('POST', '/rooms', { name, botIds, workspaceId }),

  /** Every workspace's task board: every open task and the ones finished lately, each with its workspace. */
  tasks: () => req<TasksResponse>('GET', '/tasks'),
  addTask: (t: TaskInput & { workspaceId: string }) => req<TaskResponse>('POST', '/tasks', t),
  updateTask: (id: string, p: TaskPatch) => req<TaskResponse>('PATCH', `/tasks/${id}`, p),
  deleteTask: (id: string) => req<Ok>('DELETE', `/tasks/${id}`),

  workspaces: () => req<WorkspacesResponse>('GET', '/workspaces'),
  /** A new workspace with its first bot, which becomes its primary bot and says hello. */
  createWorkspace: (name: string, bot: NewBot) => req<WorkspaceCreated>('POST', '/workspaces', { name, bot }),
  updateWorkspace: (id: string, p: WorkspacePatch) => req<WorkspaceResponse>('PATCH', `/workspaces/${id}`, p),
  /** Deletes the workspace with every bot and group chat in it. */
  deleteWorkspace: (id: string) => req<Ok>('DELETE', `/workspaces/${id}`),
  /** The workspace's primary bot checks in now. */
  checkInNow: (id: string) => req<Ok>('POST', `/workspaces/${id}/checkin`),
  // Notifications on this device (server/src/notifications.ts, lib/notifications.ts).
  notifications: () => req<NotificationsResponse>('GET', '/notifications'),
  addDevice: (sub: PushSubscriptionJSON) => req<Ok>('PUT', '/notifications/device', { endpoint: sub.endpoint, keys: sub.keys }),
  removeDevice: (endpoint: string) => req<Ok>('DELETE', '/notifications/device', { endpoint }),
  testDevice: (endpoint: string) => req<NotificationTestResponse>('POST', '/notifications/test', { endpoint }),
  /** Which chat this tab shows in front of the user, or null. `leaving`: the page is going, so the request must outlive it. */
  presence: (tab: string, botId: string | null, leaving = false) => {
    if (leaving) { sendKeepalive('PUT', '/notifications/presence', { tab, botId }); return Promise.resolve(); }
    return req<Ok>('PUT', '/notifications/presence', { tab, botId }).then(() => {});
  },
};
