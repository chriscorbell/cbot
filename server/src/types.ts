// The contract between server and web: the web app imports this file (as @shared/types).
// Keep it free of server imports, so it bundles into the web app on its own.

/** Every shape a bot can have, each with its own artwork, in the order the shape picker shows them. */
export const AVATAR_SHAPES = [
  'blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex',
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const AVATAR_COLORS = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

/** The person who uses the app. `username` is what they sign in with and what the bots call them. */
export interface User { id: string; username: string; avatarUrl: string | null }

export interface Bot {
  id: string;
  /** The workspace whose team it is on. */
  workspaceId: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  isPrimary: boolean;
  /** 'room' = group chat (members answer instead of the bot itself). */
  kind?: 'agent' | 'room';
  /** Hidden from the rail by the user; Search still finds it. */
  sidebarHidden?: boolean;
  effort: (typeof EFFORTS)[number];
  /** Voice chat settings: a voice id from the speech service (Phonon's) and a speed inside its range. */
  voice: string;
  voiceSpeed: number;
  /** Hermes engine: model id and provider for this bot; null = the engine's default. */
  model: string | null;
  provider: string | null;
  generation: number;
  unread: number;
  lastPreview: string | null;
  lastActivityAt: number;
  createdAt: number;
}

/** When a workspace's primary bot checks in with the user on its own (server/src/proactive.ts). */
export interface CheckinSettings { enabled: boolean; times: string[]; timezone: string }

/** A separate team of bots with its own primary bot, task board and check-ins (server/src/workspaces.ts). */
export interface Workspace {
  id: string;
  name: string;
  /** Whether it uses the task board. */
  taskBoard: boolean;
  checkins: CheckinSettings;
  createdAt: number;
}

/** A transcript row. `seq` orders rows; `updatedSeq` is a per-bot revision counter (rows are rewritten while streaming). */
export interface Row {
  botId: string;
  generation: number;
  seq: number;
  updatedSeq: number;
  kind: RowKind;
  body: RowBody;
  createdAt: number;
}

export type RowKind = 'message' | 'tool-call' | 'card' | 'event' | 'notice';

export type RowBody =
  | MessageBody
  | ToolCallBody
  | CardBody
  | EventBody
  | NoticeBody;

export interface MessageBody {
  type: 'message';
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  /** Set when a message came from another bot, a routine or a voice call rather than the user typing. */
  from?: { kind: 'bot' | 'routine' | 'voice'; id: string; name: string };
  citations?: { url: string; title?: string }[];
  /** An emoji the user reacted with. */
  reaction?: string;
  /** The bot thinking aloud between steps; kept for the record, not shown in the chat. */
  note?: boolean;
  /** Files the user attached, saved in the bot's Library (paths are relative to it). */
  attachments?: Attachment[];
  /** The id of the voice call the bot posted this from (post_to_chat), so the chat's agent is told about it. */
  call?: string;
}

export interface Attachment { name: string; path: string; size: number; type: string }

export interface ToolCallBody {
  type: 'tool-call';
  callId: string;
  name: string;
  /** Human phrase, e.g. "Clicking on screen". */
  label: string;
  status: 'running' | 'done' | 'error' | 'awaiting-approval' | 'denied';
  args?: unknown;
  summary?: string;
  /** Data URL thumbnail for computer actions. */
  screenshot?: string;
}

/** An answer to one of Hermes' approval prompts: this time, from now on (for every bot), or no. */
export type ApprovalChoice = 'once' | 'always' | 'deny';

/** How Hermes asks before risky actions: never, only when its own model can't clear them, or always. */
export type ApprovalMode = 'off' | 'smart' | 'manual';

export type CardBody =
  | {
      type: 'card';
      card: 'approval';
      approvalId: string;
      title: string;
      detail: string;
      tool: string;
      /** What the tool is doing ("Running commands"); older cards have none. */
      label?: string;
      /** The command Hermes wants to run, shown as code. */
      command?: string;
      /** The answers Hermes takes for this prompt; older cards offered all three. */
      choices?: ApprovalChoice[];
      args: unknown;
      status: 'pending' | 'allowed' | 'always' | 'denied' | 'expired';
    }
  | {
      type: 'card';
      card: 'question';
      question: string;
      options: string[];
      /** The user may pick more than one option. */
      multiple?: boolean;
      status: 'pending' | 'answered' | 'dismissed';
      answer?: string;
    }
  | WeatherCard;

/** A forecast shown as a card (the show_weather tool). Temperatures are °C and wind km/h; the card converts. */
export interface WeatherCard {
  type: 'card';
  card: 'weather';
  status: 'shown';
  place: string;
  /** ISO country code, e.g. 'US'; the card starts in °F there. */
  country?: string;
  /** IANA zone of the place, for its local times. */
  timezone: string;
  /** When the forecast was fetched (epoch ms). */
  fetchedAt: number;
  current: { temp: number; feelsLike: number; code: number; isDay: boolean; humidity: number; wind: number; high: number; low: number };
  /** The next hours from now; `event` marks a sunrise or sunset slotted in between. */
  hourly: { time: string; temp: number; code: number; isDay: boolean; event?: 'sunrise' | 'sunset' }[];
  daily: { date: string; high: number; low: number; code: number; precip: number }[];
}

export interface EventBody {
  type: 'event';
  /**
   * 'routine-run' is only in older chats; nothing writes it now and the chat hides it. 'task': something
   * on the team's task board that concerns this bot. 'bot-question': one bot asked another with ask_bot.
   */
  event: 'routine-created' | 'routine-updated' | 'routine-run' | 'bot-message' | 'conversation-cleared' | 'computer' | 'voice-call' | 'task' | 'bot-question';
  text: string;
  ref?: string;
  /** voice-call only: the call record (set on the end-of-call row). */
  call?: VoiceCallRecord;
  /** bot-question only: the question and, once it came, the answer. */
  ask?: BotQuestion;
}

/**
 * A question one bot asked another with ask_bot (server/src/agent/asks.ts). The row is in both bots'
 * chats: written 'asking' when the question goes out and rewritten once it is answered or failed.
 */
export interface BotQuestion {
  from: { id: string; name: string };
  to: { id: string; name: string };
  question: string;
  status: 'asking' | 'answered' | 'failed';
  /** The answer, or why there is none. */
  answer?: string;
}

export interface VoiceCallRecord {
  id: string;
  phase: 'started' | 'ended';
  durationMs?: number;
  /** A few words naming the call, e.g. "Tokyo weather check". */
  title?: string;
  summary?: string;
  transcript?: { role: 'user' | 'assistant'; text: string }[];
}

/** A voice in the picker. `group` is 'American', 'British' or 'Characters'. */
export interface VoiceOption { id: string; name: string; gender?: string; description?: string; group?: string }

export interface NoticeBody { type: 'notice'; text: string; tone?: 'info' | 'warn' | 'error' }

export type ActivityKind =
  | 'thinking' | 'working' | 'searching_web' | 'reading_web' | 'browsing_web' | 'on_its_computer'
  | 'running_commands' | 'waiting_on_command' | 'messaging_named' | 'connecting_service'
  | 'waiting_for_you' | 'drafting_file' | 'remembering';

/**
 * What a bot is doing right now (server/src/agent/live.ts owns it): idle, or running a turn. A
 * running turn always has an activity and a start time; an idle bot has neither.
 */
export type LiveState =
  | { botId: string; isRunning: false; activity: null; startedAt: null; caption: null }
  | {
      botId: string;
      isRunning: true;
      activity: { kind: ActivityKind; detail?: string; since: number };
      startedAt: number;
      /** Short line from the model's live reasoning or Hermes' status, shown next to "Thinking". */
      caption: string | null;
    };

export interface Routine {
  id: string; botId: string; name: string; prompt: string; schedule: string; timezone: string;
  enabled: boolean; nextRunAt: number | null; lastRunAt: number | null; description: string;
}

/** Where a task is on the team's board, in the board's column order. */
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A task on the team's shared board (server/src/agent/team.ts owns it). */
export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  notes: string;
  status: TaskStatus;
  /** The bot whose task it is; null while nobody has it. */
  ownerId: string | null;
  /** The name of the bot that had it until it was removed from the team; null otherwise. */
  previousOwner: string | null;
  /** The bot that put it on the board, with its name at the time; null when the user did. */
  createdBy: { id: string; name: string } | null;
  createdAt: number;
  updatedAt: number;
}

/** One entry of a bot's Hermes memory: what it knows about the user (USER.md) or its own notes (MEMORY.md). */
export interface Memory { id: string; botId: string; text: string; source: 'user' | 'notes' }

export interface Skill { id: string; botId: string; name: string; description: string; body: string; createdAt: number; updatedAt: number }

export interface LibraryFile { name: string; size: number; modifiedAt: number; isDir: boolean }

/**
 * Library files the raw route sends with their own type when asked for ?inline=1, by extension, so the
 * app can show them in place. Everything else is sent as a download. No SVG or HTML: opened at the
 * app's own address, either could run script as the app; the preview reads those as text instead.
 */
export const INLINE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

/** The type the raw route gives a file shown in place, or undefined for one it only downloads. */
export function inlineType(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? INLINE_TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
}

export interface ComputerState {
  /** The computer runs whenever the app does; 'error' while a bot's screen cannot be started. */
  status: 'running' | 'error';
  error: string | null;
  /** One screen per bot on the shared computer. width/height are the screen's pixel size. */
  screens: { botId: string; screenId: string; width?: number; height?: number }[];
}

/**
 * A model provider Hermes can use: a subscription a bot signs in to, an API key set in Settings >
 * Providers, or the self-hosted endpoint whose address is set there.
 */
export interface EngineProvider {
  id: string;
  name: string;
  kind: 'subscription' | 'api_key' | 'endpoint';
  /** Signs in with a link and a code (ChatGPT, Grok, Copilot; server/src/signin.ts). Claude takes only a token, in Settings > Providers. */
  signIn: boolean;
  connected: boolean;
  /** Suggested model ids for this provider. */
  models: string[];
}

/** The Hermes agent that runs one bot. */
export interface EngineInfo {
  botId: string;
  /** Name of the bot's Hermes home (its bot id). */
  profile: string;
  /** See the lifecycle in server/src/engine.ts. */
  status: 'ready' | 'starting' | 'error';
  error: string | null;
  model: string | null;
  provider: string | null;
  version: string | null;
  providers: EngineProvider[];
  /** Hermes is running a private screen of its own for this agent, so its computer work is not on the screen the app shows. */
  ownScreen: boolean;
}

/**
 * Updating Dispatch from GitHub (server/src/updates.ts). `current` is the running release's commit and
 * `available` the newest one on the branch Dispatch was installed from, when that is another commit, with
 * GitHub's page of what changed between them. `checkedAt` is when GitHub last answered.
 */
export type UpdateState = {
  /** What runs: its release (v1.2.0), or the first seven characters of its commit on a machine that follows a branch. */
  current: string;
  /** A later release or commit, the same way, and where to read what changed. */
  available: { version: string; url: string } | null;
  checkedAt: number | null;
} & (
  /** `error`: why the last check got no answer. */
  | { status: 'idle'; error: string | null }
  /** `step`: what the installer is doing, once it says. */
  | { status: 'updating'; step: string | null; startedAt: number }
  /** The update stopped, and this release goes on running. */
  | { status: 'failed'; error: string }
);

/**
 * A notification as the server sends it, encrypted by Web Push, to a device's service worker
 * (server/src/notifications.ts, web/src/sw.ts). `botId` is the chat a tap opens (null for the test
 * notification); `unread` is the count for the app's badge.
 */
export interface PushNotice { botId: string | null; title: string; body: string; unread: number }

/** Server-sent events on GET /api/events */
export type ServerEvent =
  /** `version`: the running release's commit (null outside a release), so a page can tell an update restarted the server. */
  | { type: 'hello'; serverTime: number; version: string | null }
  | { type: 'rows'; botId: string; generation: number; rows: Row[] }
  | { type: 'cleared'; botId: string; generation: number }
  | { type: 'live'; state: LiveState }
  | { type: 'roster' }
  | { type: 'bot'; bot: Bot }
  | { type: 'computer'; state: ComputerState }
  | { type: 'routines'; botId: string }
  | { type: 'memories'; botId: string }
  /** The team's task board changed. */
  | { type: 'tasks' }
  /** A workspace was made, changed or deleted. */
  | { type: 'workspaces' }
  | { type: 'update'; update: UpdateState }
  | { type: 'ping' };
