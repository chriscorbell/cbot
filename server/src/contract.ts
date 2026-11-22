// The HTTP API's responses (and the voice relay's handshake), shared by server and web. Server
// handlers build each response with `satisfies`; the web app's calls (web/src/lib/api.ts) name the
// same type, so changing a response here breaks the build on both sides until both agree.
// Request bodies are the zod schemas next to their routes (lib/validate.ts).
import type {
  ApprovalMode, Attachment, Bot, ComputerState, EngineInfo, LibraryFile, LiveState, Memory, Routine, Row, Skill, Task, UpdateState, User, VoiceOption, Workspace,
} from './types.js';

export interface Ok { ok: true }
/** GET /api/health: the running release's commit (null outside an installed release), once its database answers. */
export interface Health { ok: true; commit: string | null }
/** POST /api/reset: the setup code the fresh install's account takes (server/src/lib/auth.ts). */
export interface ResetResponse { ok: true; setupCode: string }
export interface ApiError { error: string }

/**
 * `needsAccount`: no account exists yet, so the web app shows the first-run form. `needsSetup`: the
 * signed-in user hasn't finished the setup wizard that makes their first bot (bots.ts setupPending).
 */
export interface MeResponse { user: User | null; needsAccount: boolean; needsSetup: boolean }
export interface BotsResponse { bots: Bot[]; live: LiveState[] }
export interface BotResponse { bot: Bot }
export interface RowsResponse { generation: number; rows: Row[] }
export interface RowResponse { row: Row }
export interface RoutinesResponse { routines: Routine[] }
export interface RoutineResponse { routine: Routine }
export interface ComputerResponse { computer: ComputerState }
/**
 * Settings > Permissions, for every bot: how Hermes asks (`mode`), the actions an "Always allow"
 * answer cleared (`allowed`, Hermes' command_allowlist) and the command patterns it refuses (`deny`).
 */
export interface PermissionsResponse { mode: ApprovalMode; allowed: string[]; deny: string[] }

/**
 * `ownCertificate`: this request came over HTTPS with Dispatch's own certificate (https.ts), which a
 * browser warns about until the device trusts it. Settings > General then offers the certificate.
 */
export interface HttpsResponse { ownCertificate: boolean }

/** Settings > General > Updates. Null when this install can't update itself (updates.ts says when). */
export interface UpdateResponse { update: UpdateState | null }

/** The secrets Settings > Providers holds: API keys, subscription tokens, the self-hosted endpoint's key. */
export type SecretId = 'anthropic-api' | 'openai-api' | 'gemini' | 'xai' | 'openrouter' | 'deepseek' | 'claude-token' | 'copilot-token' | 'self-hosted-key';
/** Whether a secret is set, and its last four characters (for a long one) to tell keys apart. The secret never comes back. */
export interface SecretState { set: boolean; ending: string }
/**
 * Settings > Providers, for every bot. `selfHosted.models` are the models its endpoint lists, and
 * `error` says why it couldn't be asked (both empty with no address set).
 */
export interface ProvidersResponse {
  secrets: Record<SecretId, SecretState>;
  selfHosted: { url: string; models: string[]; error: string | null };
  searxngUrl: string;
}

/** GET /api/tasks: every open task, and the ones finished in the last 14 days. */
export interface TasksResponse { tasks: Task[] }
export interface WorkspacesResponse { workspaces: Workspace[] }
export interface WorkspaceResponse { workspace: Workspace }
/** A new workspace and its primary bot, made together. */
export interface WorkspaceCreated { workspace: Workspace; bot: Bot }
export interface TaskResponse { task: Task }

export interface RoomMember { id: string; name: string; label: string; avatarShape: string; avatarColor: string }
export interface RoomMembersResponse { members: RoomMember[] }
export interface RoomCreated { id: string }
export interface RoomMembersSet extends Ok { members: string[] }

export interface BotSettingsBundle {
  memories: Memory[];
  skills: Skill[];
  routines: Routine[];
}
export interface SkillResponse { skill: Skill }
export interface EngineResponse { engine: EngineInfo }
/**
 * A subscription sign-in with a code (server/src/signin.ts): open `url` on any device, enter `code`
 * and approve, and it finishes by itself. `error` says why one failed.
 */
export interface ProviderSignIn {
  id: string;
  /** The Hermes provider id, as in EngineProvider. */
  provider: string;
  name: string;
  status: 'waiting' | 'done' | 'failed' | 'cancelled';
  url: string;
  code: string;
  error: string | null;
}
export interface SignInResponse { signIn: ProviderSignIn }
export interface LibraryListing { status: 'ok' | 'error'; path: string; files: LibraryFile[]; error?: string }
export interface UploadResponse { files: Attachment[] }
export interface UrlResponse { url: string }
export interface ComputerDetails {
  computer: ComputerState;
  screens: { botId: string; screenId: string; lastUsedAt: number }[];
}

export interface VoiceOptions { voices: VoiceOption[]; defaultVoice?: string; speeds: number[] }
export interface VoiceSession {
  callId: string;
  /** The call's relay socket, a path on this origin (voice-relay.ts). */
  websocketUrl: string;
  sampleRate: number;
  voice: string;
  speed: number;
}
export interface VoiceEnded extends Ok { seq?: number; duplicate?: true }
/**
 * How a call kept the bot's voice out of the microphone, sent with POST /api/voice/end for the
 * server's log. `canceller`: the call's own AEC3 (web/src/voice/aec.ts), with how many dB it took
 * off while the bot played, or the browser's (`browserCancels`: whether the browser said it was on).
 * Then the echo gate after it (web/src/voice/echo.ts): how loud the bot still was at the microphone as
 * a share of its output, and the frames held back. `route`: whether the bot played through the page's
 * WebRTC connection (CallOutput in web/src/voice/audio.ts). `seconds`: with AEC3, the call second by
 * second while the bot was audible (EchoLog in web/src/voice/aec.ts).
 */
export interface VoiceEcho {
  coupling: number; frames: number; held: number; route?: 'webrtc' | 'direct';
  canceller?: 'aec3' | 'browser'; removedDb?: number; browserCancels?: boolean;
  seconds?: EchoSecond[];
}
/**
 * One second of a call with AEC3: what the call played, what the microphone heard and what was left
 * after cancelling (dB below full scale); how late the bot's voice reached the microphone, in ms
 * (null when it couldn't be told); render quanta the microphone delivered nothing in; and the
 * context's output latency in ms (null where the browser doesn't say).
 */
export type EchoSecond = [second: number, played: number, heard: number, cancelled: number, delayMs: number | null, gaps: number, outputLatencyMs: number | null];
export interface Transcription { text: string }

/** A message that mentions the search, with about a line of text around the first match. */
export interface SearchMessageHit {
  botId: string; generation: number; seq: number; role: 'user' | 'assistant';
  /** The bot that wrote it, when it came from another bot (a group chat). */
  from?: string;
  text: string; createdAt: number;
}
/** A file or folder in a bot's Library whose name matches; `path` is relative to the Library. */
export interface SearchFileHit { botId: string; path: string; name: string; isDir: boolean; size: number; modifiedAt: number }
export interface SearchResponse { messages: SearchMessageHit[]; files: SearchFileHit[] }
