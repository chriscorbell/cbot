// Voice calls. A call is the bot itself on the phone: each thing the user says is a turn of the bot's
// Hermes agent, on its own conversation for the call, with the bot's model and tools. The call runs
// through the relay in voice-relay.ts, where the local speech service listens and speaks. This module
// builds the call's instructions and canned lines, starts calls and records their start and end,
// summarises each call, and serves voice previews and composer dictation from the speech service.
import { Hono } from 'hono';
import { z } from 'zod';
import { body } from './lib/validate.js';
import { db, now, type BotRecord, type RowRecord } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import type { AuthVars } from './lib/auth.js';
import { appendRow, conversation, emitBot, getBotRow, ownBot, requireBot, updateRow } from './store.js';
import { getLive } from './agent/live.js';
import { computerState, screenForWork } from './computer.js';
import { engineFor, runSlot } from './engine.js';
import { instructionsFor } from './agent/prompt.js';
import { ago, callLength, chatCursor, type ChatCursor } from './agent/catchup.js';
import type { ActivityKind, CardBody, EventBody, RowBody, VoiceCallRecord } from './types.js';
import { SAMPLE_RATE, mapSpeed, mapVoice, speak, transcribe, voiceCatalog, type VoiceCatalog } from './speech.js';
import type { EchoSecond, Transcription, VoiceEnded, VoiceOptions, VoiceSession } from './contract.js';
import { errorText } from './lib/errors.js';

export const voiceApi = new Hono<AuthVars>();

const NO_SPEECH = 'The speech service is not answering.';

// ---------- voices ----------

/** Speeds offered in the picker, inside the speech service's range. */
const SPEEDS = [0.9, 1, 1.1, 1.2, 1.25];

function settingsOf(bot: BotRecord, catalog: VoiceCatalog) {
  return { voice: mapVoice(bot.voice, catalog), speed: mapSpeed(bot.voice_speed ?? 1, catalog) };
}

// ---------- helpers ----------

const ACTIVITY_WORDS: Partial<Record<ActivityKind, string>> = {
  thinking: 'thinking it through', working: 'working on it', searching_web: 'searching the web', reading_web: 'reading a web page',
  browsing_web: 'browsing the web', on_its_computer: 'using its computer', running_commands: 'running commands on its computer',
  waiting_on_command: 'waiting on a command', messaging_named: 'messaging another Bot', connecting_service: 'using an app',
  waiting_for_you: 'waiting for the user', drafting_file: 'drafting a file', remembering: 'making a note',
};

function messageText(body: RowBody): { role: 'user' | 'assistant'; text: string; via?: string } | null {
  // Notes are the bot thinking aloud between steps, not part of the conversation.
  if (body.type !== 'message' || body.streaming || body.note) return null;
  const via = body.from ? (body.from.kind === 'voice' ? 'said on a call' : body.from.kind === 'routine' ? `routine ${body.from.name}` : `from ${body.from.name}`) : undefined;
  return { role: body.role, text: body.text, via };
}

/** Recent messages in the bot's current conversation, oldest first. */
function recentMessages(botId: string, count: number) {
  const b = requireBot(botId);
  const rows = db.prepare("SELECT seq, body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind IN ('message','event','card') ORDER BY seq DESC LIMIT ?").all(botId, b.generation, count * 2) as Pick<RowRecord, 'seq' | 'body' | 'created_at'>[];
  const out: { seq: number; at: number; who: string; text: string }[] = [];
  for (const r of rows) {
    const body = JSON.parse(r.body) as RowBody;
    const m = messageText(body);
    if (m) out.push({ seq: r.seq, at: r.created_at, who: m.role === 'user' ? `User${m.via ? ` (${m.via})` : ''}` : b.name, text: m.text });
    else if (body.type === 'event' && body.event === 'voice-call' && body.call?.phase === 'ended') out.push({ seq: r.seq, at: r.created_at, who: 'Call record', text: body.text });
    else if (body.type === 'card' && body.status === 'pending') out.push({ seq: r.seq, at: r.created_at, who: 'Waiting for the user', text: body.card === 'approval' ? body.title : body.question });
    if (out.length >= count) break;
  }
  return out.reverse();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function activitySnapshot(botId: string) {
  const live = getLive(botId);
  const pending = (db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='card' ORDER BY seq DESC LIMIT 20").all(botId, requireBot(botId).generation) as Pick<RowRecord, 'body'>[])
    .map((r) => JSON.parse(r.body) as CardBody)
    .filter((b): b is Extract<CardBody, { card: 'approval' | 'question' }> => (b.card === 'approval' || b.card === 'question') && b.status === 'pending');
  const lines: string[] = [];
  if (live.isRunning) lines.push(`Busy right now: ${ACTIVITY_WORDS[live.activity.kind] ?? 'working'}${live.activity.detail ? ` (${live.activity.detail})` : ''}, started ${ago(live.startedAt)}.`);
  else lines.push('Idle: not working on anything right now.');
  if (pending.length) lines.push(`Waiting on the user in chat:\n${pending.map((b) => `- ${b.card === 'approval' ? b.title : b.question}`).join('\n')}`);
  const comp = computerState(requireBot(botId).user_id);
  lines.push(`Computer: ${comp.status === 'running' ? 'running' : `a screen did not start (${comp.error})`}.`);
  return lines.join('\n');
}


// ---------- the call's instructions and canned lines ----------

/** "Sunday, November 15, 2026 at 8:04 PM Coordinated Universal Time (UTC)" */
function localTime() {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: env.timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'long',
  }).format(new Date());
  return `${s} (${env.timeZone})`;
}

/**
 * What a call adds to the app's instructions. It is made once when the call starts and stays the same
 * for the whole call, so the model's prompt cache holds from turn to turn.
 */
function callInstructions(bot: BotRecord, firstName: string): string {
  const recent = recentMessages(bot.id, 14).map((m) => `[${ago(m.at)}] ${m.who}: ${clip(m.text.replace(/\s+/g, ' '), 400)}`).join('\n');
  return `# You are on a voice call
${firstName} is talking to you on a live voice call in the team app. What you write is read aloud as you write it, sentence by sentence, in your voice. What ${firstName} says reaches you as a speech transcript, which can mishear words; if something doesn't make sense, ask. On the call these rules replace the Style section above.

- Talk, don't write: one to three short sentences unless ${firstName} asks for more. No markdown, lists, headings, URLs, file paths, IDs or code. Say numbers and dates the way people say them. Summarise long text instead of reading it out.
- ${firstName} can see your text chat during the call. Anything better read than heard (links, addresses, lists, code, numbers to copy, a written summary) goes there with post_to_chat, and then you say it's in the chat. Post when ${firstName} asks for something in the chat or in writing.
- You have all your tools on the call. Before a step that takes a while (searching, browsing, running commands), say in a few words what you're about to do. A quiet sound plays while you work. When the work is done, give the outcome in a sentence or two.
- Ask questions out loud, one at a time. ask_user does not work on a call.
- Lines in [brackets] are notes from the app, not words ${firstName} said. Some tell you what is new in your text chat since your last turn, such as a reply you finished there; bring it up when ${firstName} was waiting for it.
- When ${firstName} says goodbye or asks to hang up, say a short goodbye and then call end_call. Write nothing after it.
- Speak English: the call's voice and speech recognition only know English.

## When the call started
- Time: ${localTime()}
- Your work in the text chat:
${activitySnapshot(bot.id).split('\n').map((l) => `  ${l}`).join('\n')}

## Recent text chat (oldest first)
${recent || '(no messages yet)'}`;
}

/** The bot answers the call with one of these at once; the model hears which one in its first turn. */
const GREETINGS = ['Hey {name}.', 'Hi {name}, what\'s up?', 'Hey {name}, what can I do for you?', 'Hi {name}.', 'Hey {name}, I\'m here.'];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

// ---------- calls ----------

/**
 * A call between POST /session and POST /end. Its life on the server:
 *
 *   created  POST /session: a 'started' row in the chat and a reservation in `calls`
 *   relayed  the relay's socket claims the reservation (claimCall), once: a dropped socket can't rejoin
 *   ended    POST /end: the reservation goes and an 'ended' row with the transcript is written in
 *            the bot's current chat (the request comes at hang-up, like a message the user sends, so
 *            a call that spanned a New chat keeps its record in sight); a summary rewrites that row
 *            when it comes back
 *
 * The relay closing does not end the call: the browser posts /end (a beacon when the tab closes),
 * because it holds the transcript. A reservation nobody ended goes after 2 hours with a bare
 * 'ended' row in the chat the call started in, or none if that chat was cleared; one lost in a
 * server restart leaves its 'started' row as it is; deleting the bot drops its reservations
 * (dropCalls).
 */
export interface ActiveCall {
  id: string; botId: string; userId: string; startedAt: number;
  /** The chat the call started in; the 2-hour sweep writes its end there, or nowhere if it was cleared. */
  generation: number;
  botName: string; firstName: string;
  /** The app's instructions and the call's, fixed for the call. */
  instructions: string;
  /** The call's own conversation in the bot's Hermes, apart from the text chat's. */
  conversation: string;
  /**
   * How far the call has heard the text chat: up to the instructions' snapshot at first, then moved on
   * by the relay as it tells each run what is new there (agent/catchup.ts).
   */
  chat: ChatCursor;
  model: string | null; provider: string | null; effort: string;
  greeting: string;
  voice: string; speed: number;
  relayed: boolean;
}
const calls = new Map<string, ActiveCall>();

/** The call for the relay's socket, once: it must be the user's and not have a relay yet. */
export function claimCall(callId: string, userId: string): ActiveCall | null {
  const call = calls.get(callId);
  if (!call || call.userId !== userId || call.relayed) return null;
  call.relayed = true;
  return call;
}

function callEvent(text: string, call: VoiceCallRecord): EventBody {
  return { type: 'event', event: 'voice-call', text, ref: call.id, call };
}

/** The browser a call came from, roughly, for the log. Zen and other Firefox builds say Firefox. */
export function browserName(ua: string | undefined): string {
  if (!ua) return 'unknown browser';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Version\/[\d.]+.*Safari\//.test(ua)) return 'Safari';
  return 'unknown browser';
}

voiceApi.get('/options', async (c) => {
  const catalog = await voiceCatalog().catch(() => null);
  if (!catalog) return c.json({ error: NO_SPEECH }, 503);
  const speeds = SPEEDS.filter((s) => s >= catalog.speed.min && s <= catalog.speed.max);
  return c.json({ voices: catalog.voices, defaultVoice: catalog.defaultVoice, speeds } satisfies VoiceOptions);
});

voiceApi.post('/session', async (c) => {
  const user = c.get('user');
  const { botId } = await body(c, z.object({ botId: z.string().default('') }));
  const bot = ownBot(user.id, botId);
  if (!bot || bot.kind === 'room') return c.json({ error: 'not found' }, 404);
  const catalog = await voiceCatalog().catch(() => null);
  if (!catalog) return c.json({ error: NO_SPEECH }, 503);
  const s = settingsOf(bot, catalog);
  // The bot's gateway and screen get ready while the greeting plays; its turns need both.
  void engineFor(bot.id).catch((e) => console.warn(`[voice] ${bot.id}: engine not ready: ${e?.message ?? e}`));
  void screenForWork(user.id, bot.id).catch((e) => console.warn(`[voice] ${bot.id}: screen not ready: ${e?.message ?? e}`));

  const first = user.username;
  const firstName = first ? first[0].toUpperCase() + first.slice(1) : 'there';
  const callId = newId('call');
  const startRow = appendRow(bot.id, 'event', callEvent(`Voice call with ${bot.name} started`, { id: callId, phase: 'started' }));
  // The snapshot of the chat and where the call starts hearing it are taken together.
  const callPart = callInstructions(bot, firstName);
  const chat = chatCursor(bot.id);
  calls.set(callId, {
    id: callId, botId: bot.id, userId: user.id, startedAt: now(), generation: startRow.generation,
    botName: bot.name, firstName,
    instructions: `${await instructionsFor(user.id, bot.id)}\n${callPart}`,
    conversation: `dispatch-${bot.id}-${callId}`, chat,
    model: bot.model ?? null, provider: bot.provider ?? null, effort: bot.effort ?? 'medium',
    greeting: pick(GREETINGS).replace('{name}', firstName),
    voice: s.voice, speed: s.speed, relayed: false,
  });
  emitBot(bot.id);

  // The browser opens this path on its own origin, with ws: or wss: to match the page.
  return c.json({ callId, websocketUrl: `/api/voice/relay/${callId}`, sampleRate: SAMPLE_RATE, voice: s.voice, speed: s.speed } satisfies VoiceSession);
});

/** How long a call's summary may take before the call record keeps no summary. */
const SUMMARY_WAIT_MS = 120_000;
const RUN_ENDED = new Set(['failed', 'cancelled', 'interrupted']);

/**
 * A call's title and one-line summary, written by the bot's own agent on the model the call used: one
 * short Hermes run on a session of its own beside the call's, given the transcript. Hermes holds the
 * bot's model access (keys, subscriptions, sign-ins), so whatever model answers the call can summarise
 * it. The run is polled until it ends rather than streamed; only its final answer matters.
 */
async function summarizeCall(call: ActiveCall, transcript: { role: string; text: string }[]): Promise<{ title: string | null; summary: string } | null> {
  if (!transcript.length) return null;
  const lines = transcript.map((t) => `${t.role === 'user' ? 'User' : call.botName}: ${t.text}`).join('\n').slice(-12_000);
  const engine = await engineFor(call.botId);
  const hermes = (path: string, init: { body?: unknown; timeout: number }) => fetch(`${engine.url}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(init.timeout),
  });
  const slot = await runSlot(call.botId);
  let runId = '';
  try {
    const res = await hermes('/v1/runs', {
      timeout: 30_000,
      body: {
        model: call.model || 'hermes-agent',
        ...(call.provider ? { provider: call.provider } : {}),
        input: `The voice call between the user and you (${call.botName}) has ended. Its transcript:\n\n${lines}`,
        instructions: `Describe the voice call in the input in two lines. Line 1: a title of two to four words, sentence case, no period (for example "Tokyo weather check"). Line 2: one short sentence (max 25 words), past tense, third person ("Talked about…", "Asked ${call.botName} to…"). No labels, no preamble. Use no tools: answer with the two lines only.`,
        session_id: `${call.conversation}-summary`,
        model_options: { reasoning_effort: 'low' },
      },
    });
    if (!res.ok) throw new Error(`Hermes refused the run (${res.status})`);
    runId = String(((await res.json()) as { run_id?: unknown }).run_id ?? '');
    if (!runId) throw new Error('Hermes started no run');
  } finally {
    slot();
  }
  for (const until = now() + SUMMARY_WAIT_MS; now() < until;) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await hermes(`/v1/runs/${encodeURIComponent(runId)}`, { timeout: 10_000 }).catch(() => null);
    if (!res?.ok) continue;
    const run = (await res.json()) as { status?: string; output?: unknown; error?: unknown };
    if (run.status === 'completed') return parseSummary(String(run.output ?? ''));
    if (run.status && RUN_ENDED.has(run.status)) throw new Error(String(run.error ?? `the run was ${run.status}`));
  }
  void hermes(`/v1/runs/${encodeURIComponent(runId)}/stop`, { body: {}, timeout: 10_000 })
    .catch((e) => console.warn(`[voice] couldn't stop the summary run ${runId}; it may still be running:`, (e as Error)?.message ?? e));
  throw new Error(`no answer in ${SUMMARY_WAIT_MS / 1000} seconds`);
}

/** The model's two lines as a title and a summary. One that ignores the format keeps its sentence as the summary. */
export function parseSummary(text: string): { title: string | null; summary: string } | null {
  const out = text.trim().split(/\n+/).map((l) => l.replace(/^(title|summary)\s*:\s*/i, '').trim()).filter(Boolean);
  if (!out.length) return null;
  const [first, ...rest] = out;
  // A model that ignores the format sends one sentence: keep it as the summary, with no title.
  if (!rest.length) return { title: null, summary: clip(first.replace(/\s+/g, ' '), 240) };
  return { title: clip(first.replace(/[.\s]+$/, ''), 48), summary: clip(rest.join(' ').replace(/\s+/g, ' '), 240) };
}

/**
 * A call's echo log in a line: "12s -24/-33/-71 d84 out42, 13s -26/-35/-70 d85, ...". The output
 * latency is written when it changes; gaps when there were any. Where the echo got through, the line
 * says whether its delay jumped, the microphone dropped audio or the room got louder.
 */
export function echoSeconds(seconds: EchoSecond[]): string {
  let latency: number | null = null;
  return seconds.map(([t, played, heard, cancelled, delay, gaps, out]) => {
    let s = `${t}s ${played}/${heard}/${cancelled}`;
    if (delay !== null) s += ` d${delay}`;
    if (gaps) s += ` gap${gaps}`;
    if (out !== null && out !== latency) s += ` out${out}`;
    latency = out ?? latency;
    return s;
  }).join(', ');
}

voiceApi.post('/end', async (c) => {
  const user = c.get('user');
  const { botId, callId, transcript, error, echo } = await body(c, z.object({
    botId: z.string(), callId: z.string(), error: z.string().optional(),
    transcript: z.array(z.object({ role: z.string(), text: z.string() })).catch([]).default([]),
    echo: z.object({
      coupling: z.number(), frames: z.number(), held: z.number(), route: z.enum(['webrtc', 'direct']).optional(),
      canceller: z.enum(['aec3', 'browser']).optional(), removedDb: z.number().optional(), browserCancels: z.boolean().optional(),
      seconds: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number().nullable(), z.number(), z.number().nullable()])).max(900).optional(),
    }).optional().catch(undefined),
  }));
  const bot = ownBot(user.id, botId);
  if (!bot) return c.json({ error: 'not found' }, 404);
  const call = calls.get(callId);
  if (!call || call.botId !== bot.id) return c.json({ ok: true, duplicate: true } satisfies VoiceEnded);
  calls.delete(callId);
  if (echo) {
    // How much of the bot's voice reached the microphone, and what took it out, to tune the call's echo handling by.
    const db = echo.coupling > 0 ? `${(20 * Math.log10(echo.coupling)).toFixed(0)} dB` : 'nothing';
    const canceller = echo.canceller === 'aec3'
      ? `AEC3 took ${echo.removedDb === undefined ? '?' : echo.removedDb.toFixed(0)} dB off the microphone`
      : `the browser's canceller (${echo.browserCancels === undefined ? 'unreported' : echo.browserCancels ? 'on' : 'off'})`;
    console.log(`[voice] ${callId} (${browserName(c.req.header('user-agent'))}): ${canceller}; after it the bot reached the microphone at ${db}, and the echo gate held back ${echo.held} of ${echo.frames} frames; played ${echo.route === 'webrtc' ? 'through WebRTC' : 'straight from the AudioContext'}`);
    if (echo.seconds?.length) console.log(`[voice] ${callId} echo by second (played/heard/after AEC3 in dBFS, the echo's delay, mic gaps, output latency): ${echoSeconds(echo.seconds)}`);
  }

  const durationMs = now() - call.startedAt;
  const lines = (Array.isArray(transcript) ? transcript : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
    .slice(-200)
    .map((t) => ({ role: t.role as 'user' | 'assistant', text: clip(t.text.trim(), 2000) }));
  const base = error ? `Voice call ended · ${callLength(durationMs)} · ${clip(error, 120)}` : `Voice call ended · ${callLength(durationMs)}`;
  const record: VoiceCallRecord = { id: callId, phase: 'ended', durationMs, transcript: lines };
  // Into the bot's current chat: if they started a new chat during the call, the record (with
  // the transcript) shows there rather than in the cleared one. The summary follows the row itself.
  const row = appendRow(bot.id, 'event', callEvent(base, record));
  emitBot(bot.id);

  // Summarise in the background and rewrite the row.
  summarizeCall(call, lines)
    .then((r) => { if (r) updateRow(row, callEvent(`${base}. ${r.summary}`, { ...record, summary: r.summary, ...(r.title ? { title: r.title } : {}) })); })
    .catch((e) => console.warn('[voice] call summary failed:', e?.message));
  return c.json({ ok: true, seq: row.seq } satisfies VoiceEnded);
});

/** The bot's call in progress (its relay connected), the newest if there are several. */
export function liveCallOf(botId: string): string | null {
  let found: ActiveCall | null = null;
  for (const c of calls.values()) if (c.botId === botId && c.relayed && (!found || c.startedAt > found.startedAt)) found = c;
  return found?.id ?? null;
}

/** The bot was deleted: forget its calls. Their relays fail on the next thing said. */
export function dropCalls(botId: string) {
  for (const call of calls.values()) if (call.botId === botId) calls.delete(call.id);
}

/** On server start: close calls whose tab vanished without /end after 2 hours, so the map can't grow forever. */
export function initVoice() {
  setInterval(() => {
    for (const call of calls.values()) {
      if (now() - call.startedAt < 2 * 3600_000) continue;
      calls.delete(call.id);
      if (getBotRow(call.botId)) conversation(call.botId, call.generation).append('event', callEvent('Voice call ended', { id: call.id, phase: 'ended' }));
    }
  }, 10 * 60_000).unref();
}

// ---------- voice preview & dictation ----------

voiceApi.post('/preview', async (c) => {
  const user = c.get('user');
  const p = await body(c, z.object({ botId: z.string().optional(), voice: z.string().optional(), speed: z.number().optional(), text: z.string().optional() }));
  const catalog = await voiceCatalog().catch(() => null);
  if (!catalog) return c.json({ error: NO_SPEECH }, 503);
  const bot = ownBot(user.id, p.botId);
  const s = bot ? settingsOf(bot, catalog) : { voice: catalog.defaultVoice, speed: 1 };
  const voice = p.voice ? mapVoice(p.voice, catalog) : s.voice;
  const speed = p.speed !== undefined ? mapSpeed(p.speed, catalog) : s.speed;
  const text = String(p.text || `Hi, I'm ${bot?.name ?? 'your Bot'}. This is how I'll sound when we talk.`).slice(0, 400);
  let cause = '';
  const r = await speak(text, voice, speed, AbortSignal.timeout(30_000)).catch((e) => { cause = String((e as Error)?.message ?? e); return null; });
  if (!r?.ok || !r.body) {
    console.warn('[voice] preview failed', r ? r.status : cause, (await r?.text().catch(() => ''))?.slice(0, 200));
    return c.json({ error: 'Preview unavailable' }, 502);
  }
  // Raw PCM16 mono at SAMPLE_RATE, streamed as the speech service makes it.
  return c.body(r.body, 200, { 'Content-Type': `audio/pcm;rate=${SAMPLE_RATE}`, 'Cache-Control': 'no-store', 'X-Voice': voice, 'X-Speed': String(speed) });
});

voiceApi.post('/stt', async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'file required' }, 400);
  if (file.size > 25 * 1024 * 1024) return c.json({ error: 'recording too long' }, 413);
  if (file.size < 200) return c.json({ text: '' } satisfies Transcription);
  try {
    return c.json({ text: await transcribe(file, file.name || 'dictation.webm') } satisfies Transcription);
  } catch (e) {
    console.warn('[voice] dictation failed', errorText(e));
    return c.json({ error: 'Transcription failed' }, 502);
  }
});
