import type { ApprovalMode, Bot, Skill } from '@shared/types';
import type {
  BotResponse, BotSettingsBundle, ComputerDetails, EngineResponse, HttpsResponse, LibraryListing, Ok, PermissionsResponse, ProvidersResponse, ResetResponse, RoutineResponse, RunRoutineResponse, SecretId, SignInResponse, SkillResponse, UpdateResponse, UrlResponse,
} from '@shared/contract';
import { fileStart, request as req } from './http';

export type { BotSettingsBundle, ComputerDetails, LibraryListing } from '@shared/contract';

/** What PATCH /bots/:id takes (server/src/routes.ts BotPatch checks it). */
export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'effort' | 'sidebarHidden' | 'voice' | 'voiceSpeed'>>;

export const configApi = {
  settings: (botId: string) => req<BotSettingsBundle>('GET', `/bots/${botId}/settings`),
  updateBot: (botId: string, p: BotPatch) => req<BotResponse>('PATCH', `/bots/${botId}`, p),
  deleteBot: (botId: string) => req<Ok>('DELETE', `/bots/${botId}`),
  makePrimary: (botId: string) => req<Ok>('POST', `/bots/${botId}/primary`),
  fresh: (botId: string) => req<Ok>('POST', `/bots/${botId}/fresh`),

  deleteMemory: (id: string) => req<Ok>('DELETE', `/memories/${id}`),

  createSkill: (botId: string, s: Pick<Skill, 'name' | 'description' | 'body'>) => req<SkillResponse>('POST', `/bots/${botId}/skills`, s),
  updateSkill: (id: string, s: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<SkillResponse>('PATCH', `/skills/${id}`, s),
  deleteSkill: (id: string) => req<Ok>('DELETE', `/skills/${id}`),

  setRoutine: (id: string, enabled: boolean) => req<RoutineResponse>('PATCH', `/routines/${id}`, { enabled }),
  /** '' removes it. */
  setPrecheck: (id: string, precheck: string) => req<RoutineResponse>('PATCH', `/routines/${id}`, { precheck }),
  /** Answers once the routine's precheck, if it has one, has run (up to 30 seconds). */
  runRoutine: (id: string) => req<RunRoutineResponse>('POST', `/routines/${id}/run`),
  deleteRoutine: (id: string) => req<Ok>('DELETE', `/routines/${id}`),


  files: (botId: string, path = '') => req<LibraryListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}`),
  downloadFile: (botId: string, path: string) => req<UrlResponse>('POST', `/bots/${botId}/files/download`, { path }),
  /** The start of a Library file, for the preview; `limit` bytes at most. */
  readFile: (botId: string, path: string, limit?: number, signal?: AbortSignal) => fileStart(`/bots/${botId}/files/raw?path=${encodeURIComponent(path)}`, limit, signal),

  computerDetails: () => req<ComputerDetails>('GET', '/computer/details'),
  resetScreen: (botId: string) => req<Ok>('POST', `/bots/${botId}/screen/reset`),
  /** Erases everything and restarts the server empty (server/src/reset.ts). */
  resetDispatch: () => req<ResetResponse>('POST', '/reset', { confirm: 'reset' }),
  /** Tells the bot the person has stopped driving its screen. */
  handback: (botId: string) => req<Ok>('POST', `/bots/${botId}/handback`),
  /** Switch the open screen connection `conn` (ComputerScreen names it) between watching and control. */
  screenMode: (botId: string, conn: string, mode: 'watch' | 'control') => req<Ok>('POST', `/bots/${botId}/screen/mode`, { conn, mode }),

  engine: (botId: string) => req<EngineResponse>('GET', `/bots/${botId}/engine`),
  setEngine: (botId: string, p: { provider?: string | null; model?: string | null }) => req<EngineResponse>('PATCH', `/bots/${botId}/engine`, p),
  /** Signs the bot in to ChatGPT, Grok or Copilot: answers with the link and the code to approve it with. */
  engineLogin: (botId: string, provider: string) => req<SignInResponse>('POST', `/bots/${botId}/engine/login`, { provider }),
  /** Signs in to GitHub for the Copilot token every bot uses. */
  copilotLogin: () => req<SignInResponse>('POST', '/providers/copilot/login'),
  signIn: (id: string) => req<SignInResponse>('GET', `/signins/${id}`),
  cancelSignIn: (id: string) => req<Ok>('DELETE', `/signins/${id}`),
  restartEngine: (botId: string) => req<EngineResponse>('POST', `/bots/${botId}/engine/restart`),
  /** Stops the private screen the agent runs for itself, so its computer work shows on the screen in the app. */
  stopOwnScreen: (botId: string) => req<EngineResponse>('POST', `/bots/${botId}/engine/screen/stop`),

  permissions: () => req<PermissionsResponse>('GET', '/permissions'),
  /** Whether this page came over Dispatch's own HTTPS certificate (server/src/https.ts). */
  https: () => req<HttpsResponse>('GET', '/https'),
  /** Updating Dispatch from GitHub (server/src/updates.ts): what it knows, asking GitHub now, and running the update. */
  update: () => req<UpdateResponse>('GET', '/update'),
  checkUpdate: () => req<UpdateResponse>('POST', '/update/check'),
  startUpdate: () => req<UpdateResponse>('POST', '/update'),
  /** How every bot asks before risky actions, and the commands none of them runs ("Never Allow"). */
  setPermissions: (patch: { mode?: ApprovalMode; deny?: string[] }) => req<PermissionsResponse>('PUT', '/permissions', patch),
  /** Takes an "Always allow" answer back: every bot asks about that action again. */
  forgetAllowed: (entry: string) => req<PermissionsResponse>('DELETE', `/permissions/allowed/${encodeURIComponent(entry)}`),

  providers: () => req<ProvidersResponse>('GET', '/providers'),
  /** Keys, tokens and addresses for every bot; '' removes one. Each bot's agent restarts to use them. */
  setProviders: (patch: { secrets?: Partial<Record<SecretId, string>>; selfHostedUrl?: string; searxngUrl?: string }) => req<ProvidersResponse>('PUT', '/providers', patch),
};
