import type { ApprovalChoice, Attachment, Bot } from '@shared/types';
import type {
  BotResponse, BotsResponse, ComputerResponse, MeResponse, Ok, RoomCreated, RoomMembersResponse, RoomMembersSet, SearchResponse,
  RoutineResponse, RoutinesResponse, RowResponse, RowsResponse, UploadResponse,
} from '@shared/contract';
import { request as req, upload } from './http';

export { ApiError } from './http';
export type { RoomMember } from '@shared/contract';

/** A message's reaction; null clears it. */
export type RowPatch = { reaction?: string | null };

export const api = {
  me: () => req<MeResponse>('GET', '/auth/me'),
  setup: (username: string, password: string) => req<MeResponse>('POST', '/auth/setup', { username, password }),
  login: (username: string, password: string) => req<MeResponse>('POST', '/auth/login', { username, password }),
  logout: () => req<Ok>('POST', '/auth/logout'),
  changePassword: (current: string, next: string) => req<Ok>('POST', '/auth/password', { current, next }),

  bots: () => req<BotsResponse>('GET', '/bots'),
  search: (q: string) => req<SearchResponse>('GET', `/search?q=${encodeURIComponent(q)}`),
  /** A new bot. The setup wizard's first one also brings its job; it greets once setup finishes. */
  createBot: (b: Pick<Bot, 'name' | 'avatarShape' | 'avatarColor'> & Partial<Pick<Bot, 'label' | 'description' | 'instructions'>>) => req<BotResponse>('POST', '/bots', b),
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

  /** Answers Hermes' approval prompt (server/src/agent/approvals.ts). Without a choice (an old draft card) it just expires. */
  approve: (approvalId: string, choice?: ApprovalChoice) => req<Ok>('POST', `/approvals/${approvalId}`, choice ? { choice } : {}),
  /** `generation` is the chat the question is in; the server refuses an answer to a cleared chat. */
  answer: (id: string, seq: number, generation: number, answer: string) => req<Ok>('POST', `/bots/${id}/cards/${seq}/answer`, { answer, generation }),
  /** Use the store's `patchRow`, which shows the change at once. */
  patchRow: (id: string, seq: number, generation: number | undefined, p: RowPatch) => req<Ok>('PATCH', `/bots/${id}/rows/${seq}`, { ...p, generation }),

  routines: (id: string) => req<RoutinesResponse>('GET', `/bots/${id}/routines`),
  setRoutine: (rid: string, enabled: boolean) => req<RoutineResponse>('PATCH', `/routines/${rid}`, { enabled }),

  computer: () => req<ComputerResponse>('GET', '/computer'),

  roomMembers: (id: string) => req<RoomMembersResponse>('GET', `/rooms/${id}/members`),
  setRoomMembers: (id: string, botIds: string[]) => req<RoomMembersSet>('PUT', `/rooms/${id}/members`, { botIds }),
  createRoom: (name: string, botIds: string[]) => req<RoomCreated>('POST', '/rooms', { name, botIds }),
};
