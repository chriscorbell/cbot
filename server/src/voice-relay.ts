// The realtime relay for voice calls, a WebSocket at /api/voice/relay/<callId>.
//
// The browser (web/src/voice/call.ts) speaks a subset of the OpenAI Realtime event protocol, and the
// relay answers it from local pieces and the bot's own agent:
//   microphone PCM ─► the speech service's live recognizer ─► speech_started, partial, final
//   each final transcript ─► a turn of the bot's Hermes agent, on the call's own conversation, told
//                            first what is new in the bot's text chat (agent/catchup.ts)
//   each finished sentence of the turn's text ─► the speech service's text-to-speech ─► response.output_audio.delta
// A turn can take a while: the model reasons, and it may search, browse or run commands. The browser
// plays a quiet loop whenever a turn is running and nothing is being said. While a tool runs, `dispatch.activity` names
// it for the call bar. When the bot calls end_call, `dispatch.hangup` follows its last words.
//
// Talking over the bot pauses its speech at once, and the utterance's final transcript decides what
// that was. With no words in it (a cough, a noise, the bot's own voice coming back through the
// microphone) the browser plays on from where it paused. So it does when the words are the end of
// what the bot was saying, its own voice heard back from the speakers. Other words stop the speech and decide the turn
// (planAnswer): while one of its tools is running, they are steered into the turn, which has work in
// progress; otherwise the turn is stopped, and if it was still thinking it is asked again with
// everything said.
//
// A Reply's flags, in the order they usually change: announced (its item went out), speaking (a
// sentence is being synthesised), modelDone (Hermes finished the turn), hangup (end_call), then
// state active → done (all spoken) or cancelled (stopped). `held` keeps the next sentence from
// starting while the user talks.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticate } from './lib/auth.js';
import { engineFor, runSlot, type Engine } from './engine.js';
import { failureText, sseEvents } from './lib/sse.js';
import { activityFor, appToolName } from './agent/tools.js';
import { askApproval, runEnded, runMoved } from './agent/approvals.js';
import { conversation, getBotRow } from './store.js';
import { SAMPLE_RATE, listenUrl, speak } from './speech.js';
import { claimCall, type ActiveCall } from './voice.js';
import { chatNews } from './agent/catchup.js';
import type { ClientEvent, RealtimeResponse, RelayEvent, SpeechEvent } from './voice-protocol.js';

type Json = Record<string, any>;

/** Wall-clock times for the latency log. `endOfSpeech` is when the user's last word ended. */
interface Timing { start: number; endOfSpeech?: number; final?: number; firstToken?: number; firstAudio?: number }

/** One answer: a turn of the bot's agent (or a canned greeting), the sentences cut from it, and their speech. */
interface Reply {
  id: string;
  /** The assistant item being spoken. A new one starts when the user talks over the reply and it carries on. */
  itemId: string;
  items: number;
  /** What the user said that this reply answers, for asking again if it is stopped before it starts. */
  said: string[];
  /** The app's notes that went with it (the greeting, news from the text chat), asked again with it. */
  notes: string[];
  abort: AbortController;
  /** The sentence being spoken right now; aborted on barge-in without ending the turn. */
  tts: AbortController | null;
  state: 'active' | 'done' | 'cancelled';
  /** The Hermes run behind the reply, once it exists, and its stop request. */
  runId: string | null;
  engine: Engine | null;
  stopped: Promise<boolean> | null;
  /** Settles once the request that creates the run has been answered (or was never sent). */
  created: Promise<void> | null;
  /** Tool calls running now: words the user says meanwhile are steered into the turn. */
  tools: Set<string>;
  /** The tool started last, which an approval prompt is about. */
  lastTool: { name: string; label: string } | null;
  /** Model text not yet cut into sentences. */
  buffer: string;
  /** Sentences waiting for the speech service, which makes one at a time. */
  sentences: string[];
  spoken: string[];
  /** When the browser starts playing each spoken sentence (wall clock, estimated). */
  starts: number[];
  /** The text of the item being spoken. */
  itemText: string;
  modelDone: boolean;
  /** A TTS request is streaming. */
  speaking: boolean;
  /** response.output_item.added went out for `itemId`. */
  announced: boolean;
  /** The agent called end_call: speak what came before it, then hang up. */
  hangup: boolean;
  /** The user is talking: hold the sentences until they stop or are heard out. */
  held: boolean;
  timing: Timing;
}

/** What a stopped reply asks again with the next one when its run never started. */
type Asked = Pick<Reply, 'said' | 'notes'>;

/** The browser's player starts this far after the first chunk arrives (PcmPlayer in web/src/voice/audio.ts). */
const PLAYER_LEAD_MS = 60;

const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|etc|e\.g|i\.e|a\.m|p\.m|approx)\.$/i;

/**
 * Cuts the finished sentences off the front of `text`. A sentence ends at . ! ? or … (with any
 * closing quote or bracket) followed by white space, or at a line break.
 */
export function cutSentences(text: string): [string[], string] {
  const out: string[] = [];
  let from = 0;
  const end = /[.!?…]+["'”’)\]]*\s+|\n+/g;
  for (let m; (m = end.exec(text)); ) {
    if (m[0][0] === '.' && ABBREVIATION.test(text.slice(from, m.index + 1))) continue;
    const sentence = text.slice(from, m.index + m[0].length).trim();
    if (sentence) out.push(sentence);
    from = m.index + m[0].length;
  }
  return [out, text.slice(from)];
}

/** What text-to-speech should read: no markdown marks, links or list bullets, one line. */
export const speakable = (s: string) => s
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
  .replace(/[*#`_~]+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the user's next words do to the reply in progress:
 *   steer          a tool is running: add the words to the turn, which keeps its work
 *   stop-thinking  the model is still working (no tool running): stop it and ask again, with what was said before
 *   stop-speaking  the answer is complete and being spoken: stop it and answer the new words
 *   new            nothing is in progress
 */
export function planAnswer(r: Pick<Reply, 'state' | 'modelDone' | 'tools' | 'runId'> | null): 'steer' | 'stop-thinking' | 'stop-speaking' | 'new' {
  if (!r || r.state !== 'active') return 'new';
  if (!r.modelDone && r.tools.size && r.runId) return 'steer';
  return r.modelDone ? 'stop-speaking' : 'stop-thinking';
}

/** Words for comparing what the recognizer heard with what the bot said: lower case, no punctuation. */
const words = (s: string): string[] => s.toLowerCase().replace(/[’']/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Whether `heard` is the bot's voice coming back through the microphone: its words are in `saying`,
 * in order. One word in four may differ, since the recognizer mishears speech from a loudspeaker
 * and the bot's text spells out what its voice reads aloud ("3" for "three").
 */
export function isEcho(heard: string, saying: string): boolean {
  const h = words(heard);
  const s = words(saying);
  let at = 0;
  let found = 0;
  for (const w of h) {
    const i = s.indexOf(w, at);
    if (i < 0) continue;
    found++;
    at = i + 1;
  }
  return h.length > 0 && found >= h.length - Math.floor(h.length / 4);
}

/** Words that only acknowledge whoever is talking: "yeah", "mm-hmm", "okay", "right". */
const ACKS = new Set(['yeah', 'yes', 'yep', 'yup', 'yah', 'ya', 'okay', 'ok', 'mhm', 'mm', 'mmm', 'hmm', 'hm', 'uh', 'huh', 'um', 'ah', 'oh', 'right', 'sure', 'cool', 'nice', 'great', 'wow', 'alright', 'gotcha', 'exactly', 'true']);

/**
 * Whether `heard` only acknowledges the bot (at most three such words). Said over the bot, that isn't
 * the user taking a turn, and a short word is also what the recognizer makes of a scrap of the bot's
 * own voice that got past the echo canceller ("Yeah.", "Cool.").
 */
export function isAck(heard: string): boolean {
  const h = words(heard);
  return h.length > 0 && h.length <= 3 && h.every((w) => ACKS.has(w));
}

export class Relay {
  private speech: WebSocket;
  private reply: Reply | null = null;
  private replies = 0;
  private ready = false;
  private closed = false;
  private speechError = '';
  /** The call has been answered. */
  private answered = false;
  /** What the bot answered the call with, until the first turn has heard about it. */
  private greeted: string | null = null;
  /** A note for the next turn about the last reply, when the user talked over it. */
  private cutNote: string | null = null;
  /** When the user's current utterance ended, for the latency log. */
  private heard: Timing | null = null;
  /** The browser's playback, mirrored: when its queued audio runs out, and whose audio it is. */
  private playhead = 0;
  private playing: Reply | null = null;
  /** When the browser paused the bot's speech for the user's current utterance (wall clock). */
  private pausedAt: number | null = null;
  /** The speech service's streaming model. A final that names it is one Parakeet found no words in. */
  private streamModel = '';

  constructor(private client: WebSocket, private call: ActiveCall) {
    this.speech = new WebSocket(listenUrl());
    this.speech.on('message', (data, isBinary) => {
      if (isBinary) return;
      try { this.onSpeech(JSON.parse(String(data))); } catch (e) { console.warn('[voice] bad speech event', e); }
    });
    this.speech.on('error', (e) => { this.speechError ||= e.message; });
    this.speech.on('close', () => this.fail(this.ready ? 'The speech service ended the call.' : `The speech service is not answering${this.speechError ? ` (${this.speechError})` : ''}.`));
    client.on('message', (data, isBinary) => {
      if (isBinary) return this.audio(data as Buffer);
      try { this.onClient(JSON.parse(String(data))); } catch (e) { console.warn('[voice] bad client event', e); }
    });
    client.on('close', () => this.close());
  }

  private send(ev: RelayEvent) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(ev));
  }

  private audio(pcm: Buffer) {
    if (this.ready && this.speech.readyState === WebSocket.OPEN && pcm.length) this.speech.send(pcm);
  }

  // ---------- from the browser ----------

  private onClient(ev: ClientEvent) {
    switch (ev.type) {
      case 'input_audio_buffer.append':
        return this.audio(Buffer.from(String(ev.audio ?? ''), 'base64'));
      case 'input_audio_buffer.clear': // the microphone was muted: drop what the user was saying
        if (this.speech.readyState === WebSocket.OPEN) this.speech.send(JSON.stringify({ type: 'reset' }));
        this.playOn();
        return;
      case 'response.create': // the call connected: answer it
        if (!this.reply && !this.answered) this.greet();
        return;
      case 'response.cancel':
        if (this.reply && (!ev.response_id || ev.response_id === this.reply.id)) {
          this.stopSpeech();
          void this.cancel(this.reply, 'client_cancelled');
        }
        return;
      case 'session.update': // the call's settings come from POST /api/voice/session
        return;
      default:
        this.send({ type: 'error', error: { type: 'invalid_request_error', code: 'unknown_event', message: `Unknown event ${String((ev as { type?: unknown }).type)}` } });
    }
  }

  // ---------- from the speech service ----------

  private onSpeech(ev: SpeechEvent) {
    const itemId = `${this.call.id}_u${'utterance' in ev ? ev.utterance : ''}`;
    switch (ev.type) {
      case 'ready':
        this.ready = true;
        this.streamModel = String(ev.model ?? '');
        this.send({ type: 'session.created', session: { id: this.call.id, model: this.call.model ?? 'hermes-agent', voice: this.call.voice, speed: this.call.speed, sample_rate: SAMPLE_RATE } });
        return;
      case 'speech_started': {
        // The browser pauses the bot's speech when this event reaches it. What the utterance was is
        // decided on its final transcript, so a cough costs the bot a moment, not the rest of its words.
        this.pausedAt ??= Date.now();
        if (this.reply) this.hold(this.reply);
        this.heard = null;
        this.send({ type: 'input_audio_buffer.speech_started', item_id: itemId, audio_start_ms: ev.start_ms, audio_ms: ev.audio_ms });
        return;
      }
      case 'partial':
        this.send({ type: 'conversation.item.input_audio_transcription.updated', item_id: itemId, transcript: ev.text });
        return;
      case 'speech_stopped':
        // The service's clock is the audio it has received, which arrives in real time.
        this.heard = { start: 0, endOfSpeech: Date.now() - (ev.audio_ms - ev.end_ms) };
        this.send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: ev.end_ms, audio_ms: ev.audio_ms });
        return;
      case 'final': {
        const text = String(ev.text ?? '').trim();
        const timing = this.heard ? { ...this.heard, start: Date.now(), final: Date.now() } : undefined;
        this.heard = null;
        // Over the bot's speech, two kinds of words don't count. Words only the streaming model heard:
        // Parakeet, which decodes the whole utterance, found none, and the stream's guess at a short
        // sound is how a noise became "That's" and cut the bot off. And the bot's own words: with
        // speakers and a microphone in the same room, some of its voice gets past the browser's echo
        // canceller, and the recognizer hears it as the user saying what the bot was saying. Nor do
        // words that only acknowledge it ("yeah", "okay"), unless the bot was asking a question.
        const ignored = !text || !this.talking() ? null
          : this.streamModel && ev.model === this.streamModel ? 'only the streaming model heard'
          : isEcho(text, this.sayingAtPause()) ? 'that repeat what the bot was saying'
          : isAck(text) && !this.askingAtPause() ? 'that only acknowledge it'
          : null;
        if (ignored) {
          console.log(`[voice] ${this.call.id}: ${text.split(/\s+/).length} word(s) over the bot's speech ${ignored}; ignored`);
          this.send({ type: 'conversation.item.deleted', item_id: itemId });
          this.playOn();
          return;
        }
        this.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text });
        if (text) {
          this.stopSpeech();
          this.answer(text, timing);
        } else {
          this.playOn();
        }
        return;
      }
      case 'speech_dropped':
        this.playOn();
        this.send({ type: 'conversation.item.deleted', item_id: itemId });
        return;
      case 'error':
        this.speechError = String(ev.message ?? '');
        console.warn('[voice] speech service:', this.speechError);
    }
  }

  // ---------- turns ----------

  /**
   * The user said something. While a tool runs, the words are steered into the turn: Hermes hands
   * them to the agent when the tool batch ends, before its next model call. Otherwise the turn is
   * stopped (its finished tool calls stay in the agent's history) and a new one answers.
   */
  private answer(text: string, timing?: Timing) {
    const r = this.reply;
    const plan = planAnswer(r);
    if (plan === 'steer') {
      void this.steer(r!, text, timing);
      return;
    }
    let earlier: Promise<Asked | null> = Promise.resolve(null);
    if (plan !== 'new') {
      // Words the stopped turn never got to (it was still queued) are asked again with the new ones.
      const kept = this.cancel(r!, 'turn_detected');
      if (plan === 'stop-thinking') earlier = kept.then((k) => (k ? null : r!));
    }
    this.startTurn(text, timing, earlier);
  }

  private newReply(said: string[], timing?: Timing): Reply {
    const n = ++this.replies;
    const r: Reply = {
      id: `resp_${n}`, itemId: `${this.call.id}_a${n}`, items: 1, said, notes: [], abort: new AbortController(), tts: null, state: 'active',
      runId: null, engine: null, stopped: null, created: null, tools: new Set(), lastTool: null,
      buffer: '', sentences: [], spoken: [], starts: [], itemText: '', modelDone: false, speaking: false, announced: false,
      hangup: false, held: false, timing: { ...timing, start: Date.now() },
    };
    this.reply = r;
    this.send({ type: 'response.created', response: { id: r.id, object: 'realtime.response', status: 'in_progress', output: [] } });
    return r;
  }

  /** The bot answers the call with its canned greeting, at once. */
  private greet() {
    this.answered = true;
    this.greeted = this.call.greeting;
    const r = this.newReply([]);
    r.modelDone = true;
    this.say(r, [this.call.greeting]);
  }

  private startTurn(text: string, timing: Timing | undefined, earlier: Promise<Asked | null>) {
    if (this.closed) return;
    const r = this.newReply([text], timing);
    const notes: string[] = [];
    if (this.greeted) {
      notes.push(`[The call just connected and you answered: "${this.greeted}"]`);
      this.greeted = null;
    }
    const news = chatNews(this.call.botId, this.call.id, this.call.chat, this.call.firstName);
    if (news) notes.push(news);
    if (this.cutNote) notes.push(this.cutNote);
    this.cutNote = null;
    void earlier.then((prev) => {
      r.said = [...(prev?.said ?? []), text];
      r.notes = [...(prev?.notes ?? []), ...notes];
      return this.run(r, [...r.notes, r.said.join(' ')].join('\n'));
    });
  }

  /** A request to the bot's gateway. */
  private hermes(engine: Engine, path: string, body?: Json, signal?: AbortSignal) {
    return fetch(`${engine.url}${path}`, {
      method: body ? 'POST' : 'GET',
      signal,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : { accept: 'text/event-stream' }),
        ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  /**
   * One turn of the bot's agent as a Hermes run on the call's own session, then its events. A run,
   * unlike a streamed /v1/responses request, can be stopped and steered.
   */
  private async run(r: Reply, input: string) {
    if (r.state !== 'active') return;
    let created = () => {};
    r.created = new Promise<void>((res) => { created = res; });
    let slot: ((event?: unknown) => void) | null = null;
    try {
      const engine = await engineFor(this.call.botId);
      if (r.state !== 'active') return;
      // Right after its gateway starts, a bot's first run goes alone for a moment (runSlot).
      slot = await runSlot(this.call.botId);
      if (r.state !== 'active') return;
      r.engine = engine;
      // Not aborted with the reply: a run Hermes created but nobody knows the id of would hold the
      // call's session until it finished. A reply cancelled meanwhile stops the run once it exists.
      const res = await this.hermes(engine, '/v1/runs', {
        model: this.call.model || 'hermes-agent',
        ...(this.call.provider ? { provider: this.call.provider } : {}),
        input,
        instructions: this.call.instructions,
        session_id: this.call.conversation,
        model_options: { reasoning_effort: this.call.effort },
      }, AbortSignal.timeout(30_000));
      if (!res.ok) throw new Error(await failureText(res));
      r.runId = String(((await res.json()) as Json).run_id ?? '') || null;
      if (!r.runId) throw new Error('Hermes started no run');
      created();
      if (r.state !== 'active') return;
      const events = await this.hermes(engine, `/v1/runs/${r.runId}/events`, undefined, r.abort.signal);
      if (!events.ok || !events.body) throw new Error(await failureText(events));
      for await (const ev of sseEvents(events.body)) {
        slot((ev.data as Json | undefined)?.event);
        if (r.state !== 'active') return;
        if (this.onRunEvent(r, ev.data)) break;
      }
    } catch (e: any) {
      if (r.state !== 'active') return; // cancelled
      console.warn(`[voice] ${this.call.id} ${r.id}: the turn failed: ${e?.message ?? e}`);
      this.send({ type: 'error', error: { type: 'server_error', code: 'model_error', message: 'The bot did not answer.' } });
      // Say so rather than going quiet.
      if (!r.spoken.length && !r.sentences.length) r.buffer = 'Sorry, I couldn’t get an answer just then.';
    } finally {
      slot?.();
      created();
      // Its prompts can't be answered once nobody follows the run.
      if (r.runId) runEnded(r.runId);
    }
    if (r.state !== 'active' || r.modelDone) return;
    this.say(r, [r.buffer]); // the last words, with or without a full stop
    r.buffer = '';
    r.modelDone = true;
    void this.pump(r);
  }

  /** Handles one event of the run. True when the run is over. */
  private onRunEvent(r: Reply, d: any): boolean {
    if (r.runId && d?.event !== 'approval.request' && d?.event !== 'approval.responded') runMoved(r.runId);
    switch (d?.event) {
      case 'message.delta': {
        if (typeof d.delta !== 'string' || r.hangup) return false;
        r.timing.firstToken ??= Date.now();
        const [done, rest] = cutSentences(r.buffer + d.delta);
        r.buffer = rest;
        this.say(r, done);
        return false;
      }
      case 'tool.started': {
        // Text before a tool call is finished: speak it now.
        if (r.buffer) {
          this.say(r, [r.buffer]);
          r.buffer = '';
        }
        r.tools.add(String(d.tool_call_id ?? d.tool ?? ''));
        const raw = String(d.tool ?? '');
        const { name, ours } = appToolName(raw);
        if (ours && name === 'end_call') {
          // Nothing the agent writes after this is said: finish once the goodbye has been spoken.
          r.hangup = true;
          r.modelDone = true;
          void this.pump(r);
          return false;
        }
        r.lastTool = { name, label: activityFor(raw).label };
        if (name !== 'tool_search' && name !== 'tool_describe') this.send({ type: 'dispatch.activity', response_id: r.id, label: r.lastTool.label });
        return false;
      }
      case 'tool.completed':
        r.tools.delete(String(d.tool_call_id ?? d.tool ?? ''));
        return false;
      case 'approval.request': {
        // Hermes asks before an action: the card shows in the bot's chat and the call waits for the
        // answer there (agent/approvals.ts), for as long as Hermes waits.
        const bot = getBotRow(this.call.botId);
        const tool = r.lastTool;
        const asked = bot && r.engine && r.runId ? askApproval({
          convo: conversation(bot.id, bot.generation), engine: r.engine, runId: r.runId, event: d, tool,
          onSettled: (o) => { if (r.state === 'active') this.send({ type: 'dispatch.activity', response_id: r.id, label: o === 'denied' ? '' : tool?.label ?? '' }); },
        }) : null;
        console.log(`[voice] ${this.call.id} ${r.id}: ${asked ? 'asked in the chat' : 'could not ask'} before: ${clip(String(d.command ?? d.description ?? ''), 160)}`);
        if (asked) this.send({ type: 'dispatch.activity', response_id: r.id, label: 'Waiting for you in the chat' });
        return false;
      }
      case 'approval.responded':
        return false;
      case 'run.completed': {
        // Text that never streamed (rare) is in the run's output.
        const out = typeof d.output === 'string' ? d.output.trim() : '';
        if (out && !r.hangup && !r.buffer && !r.spoken.length && !r.sentences.length) {
          const [done, rest] = cutSentences(`${out}\n`);
          this.say(r, [...done, rest]);
        }
        return true;
      }
      case 'run.cancelled':
      case 'run.interrupted':
        return true;
      case 'run.failed':
        throw new Error(String(d.error ?? 'the run failed'));
      default:
        return false;
    }
  }

  /** Tells the running turn what the user just said. Falls back to a new turn if it won't take it. */
  private async steer(r: Reply, text: string, timing?: Timing) {
    this.cutNote = null; // what was cut off was said before this work; it doesn't matter now
    const res = await this.hermes(r.engine!, `/v1/runs/${r.runId}/steer`, { input: `[Said on the call while you were working]\n${text}` }).catch(() => null);
    if (res?.ok && r.state === 'active') {
      console.log(`[voice] ${this.call.id} ${r.id}: steered "${clip(text, 80)}" into the running turn`);
      this.release(r);
      return;
    }
    console.log(`[voice] ${this.call.id} ${r.id}: the run took no steer (HTTP ${res?.status ?? 'error'}); asking again`);
    // Something newer may own the call by now (another utterance started a turn while this steer was
    // in flight): decide again against that reply, so two replies never run at once.
    if (this.reply !== r) return this.answer(text, timing);
    if (r.state === 'active') void this.cancel(r, 'turn_detected');
    this.startTurn(text, timing, Promise.resolve(null));
  }

  /** Stops the turn's run. True when the user's words stay in the agent's history (the run had started). */
  private stopRun(r: Reply): Promise<boolean> {
    r.stopped ??= (async () => {
      await r.created;
      if (!r.engine || !r.runId) return false;
      const res = await this.hermes(r.engine, `/v1/runs/${r.runId}/stop`, {}).catch(() => null);
      const status = res?.ok ? String(((await res.json().catch(() => ({}))) as Json).status ?? '') : '';
      return status !== 'cancelled' && status !== '';
    })();
    return r.stopped;
  }

  private say(r: Reply, sentences: string[]) {
    for (const s of sentences) {
      const text = speakable(s);
      if (text) r.sentences.push(text);
    }
    void this.pump(r);
  }

  /** Speaks the queued sentences one after another; finishes the reply once the model is done too. */
  private async pump(r: Reply) {
    if (r.speaking || r.held) return;
    r.speaking = true;
    while (r.state === 'active' && !r.held && r.sentences.length) {
      try {
        await this.speakSentence(r, r.sentences.shift()!);
      } catch (e: any) {
        if (r.state !== 'active' || r.held) break;
        console.warn('[voice] speech failed:', e?.message ?? e);
      }
    }
    r.speaking = false;
    if (r.state === 'active' && r.modelDone && !r.held && !r.sentences.length) this.finish(r);
  }

  private announce(r: Reply) {
    if (r.announced) return;
    r.announced = true;
    this.send({ type: 'response.output_item.added', response_id: r.id, output_index: 0, item: { id: r.itemId, object: 'realtime.item', type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
  }

  private async speakSentence(r: Reply, text: string) {
    this.announce(r);
    r.spoken.push(text);
    this.send({ type: 'response.output_audio_transcript.delta', response_id: r.id, item_id: r.itemId, delta: r.itemText ? ` ${text}` : text });
    r.itemText = r.itemText ? `${r.itemText} ${text}` : text;
    const tts = new AbortController();
    r.tts = tts;
    const stop = () => tts.abort();
    r.abort.signal.addEventListener('abort', stop);
    try {
      const res = await speak(text, this.call.voice, this.call.speed, tts.signal);
      if (!res.ok || !res.body) throw new Error(`text-to-speech answered HTTP ${res.status}`);
      const reader = res.body.getReader();
      let odd: Buffer | null = null; // chunks can split a sample
      let first = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || r.state !== 'active' || tts.signal.aborted) break;
        let pcm: Buffer = odd ? Buffer.concat([odd, value]) : Buffer.from(value);
        odd = pcm.length % 2 ? Buffer.from(pcm.subarray(pcm.length - 1)) : null;
        if (odd) pcm = pcm.subarray(0, pcm.length - 1);
        if (!pcm.length) continue;
        if (!r.timing.firstAudio && r.said.length) {
          r.timing.firstAudio = Date.now();
          this.logLatency(r);
        }
        const at = this.sendAudio(r, r.itemId, pcm);
        if (first) r.starts[r.spoken.length - 1] = at;
        first = false;
      }
    } finally {
      r.abort.signal.removeEventListener('abort', stop);
      if (r.tts === tts) r.tts = null;
    }
  }

  /** Sends PCM to the browser and advances the mirror of its player. Returns when it starts playing. */
  private sendAudio(r: Reply, itemId: string, pcm: Buffer): number {
    // Where the browser's player puts this chunk: after what it has queued, or just after it arrives.
    // While it is paused, after what it holds, on the clock as it stood at the pause (playOn moves it on).
    const at = this.pausedAt !== null ? Math.max(this.playhead, this.pausedAt) : Math.max(this.playhead, Date.now() + PLAYER_LEAD_MS);
    this.playhead = at + (pcm.length / 2 / SAMPLE_RATE) * 1000;
    this.playing = r;
    this.send({ type: 'response.output_audio.delta', response_id: r.id, item_id: itemId, output_index: 0, content_index: 0, delta: pcm.toString('base64') });
    return at;
  }

  /**
   * The user started talking: no new sentence starts until they stop, and what the turn writes
   * meanwhile waits. The sentence being made goes on to the browser, which holds it behind the pause.
   */
  private hold(r: Reply) {
    if (r.state === 'active') r.held = true;
  }

  /** The user stopped without saying anything (a noise, or the microphone was muted): carry on speaking. */
  private release(r: Reply) {
    if (!r.held || r.state !== 'active') return;
    r.held = false;
    void this.pump(r);
  }

  /** Bot audio was playing, or has been queued since, behind the pause. */
  private talking(): boolean {
    return this.pausedAt !== null && this.playing !== null && this.playhead > this.pausedAt;
  }

  /**
   * What the bot was saying when the pause came: the sentence playing then, and the one before it,
   * since the recognizer also gets the half second before the user's speech started.
   */
  private sayingAtPause(): string {
    const r = this.playing;
    const at = this.pausedAt;
    if (!r || at === null) return '';
    let i = -1;
    r.starts.forEach((t, k) => { if (t <= at) i = k; });
    return i < 0 ? '' : r.spoken.slice(Math.max(0, i - 1), i + 1).join(' ');
  }

  /** The pause came in the last sentence of a finished reply, and it asks something: "yeah" answers it. */
  private askingAtPause(): boolean {
    const r = this.playing;
    const at = this.pausedAt;
    if (!r || at === null || !r.modelDone || r.buffer.trim() || r.sentences.length) return false;
    const last = r.starts.length - 1;
    return last >= 0 && r.starts[last] <= at && /\?["'”’)]*\s*$/.test(r.spoken[last] ?? '');
  }

  /**
   * What paused the bot had no words in it, or the microphone was muted: the browser plays on from
   * where it paused, and the reply goes on to its next sentence.
   */
  private playOn() {
    const at = this.pausedAt;
    this.pausedAt = null;
    if (at !== null) {
      this.send({ type: 'dispatch.playback', action: 'resume' });
      // The browser's schedule moves on by the length of the pause: its player starts again after its lead.
      const r = this.playing;
      if (r && this.playhead > at) {
        const shift = Date.now() + PLAYER_LEAD_MS - at;
        this.playhead += shift;
        r.starts = r.starts.map((t) => (t > at ? t + shift : t));
        console.log(`[voice] ${this.call.id} ${r.id}: paused ${Date.now() - at} ms by a sound with no words; playing on`);
      }
    }
    if (this.reply) this.release(this.reply);
  }

  /**
   * The user talked over the bot: the browser drops the audio it holds, and the reply its sentence in
   * progress. The turn itself is decided by `answer`.
   */
  private stopSpeech() {
    const at = this.pausedAt ?? Date.now();
    if (this.pausedAt !== null) this.send({ type: 'dispatch.playback', action: 'stop' });
    this.pausedAt = null;
    const cut = this.cutOff(at);
    if (cut) console.log(`[voice] ${this.call.id} ${cut.id}: talked over; ${cut.heard} of ${cut.spoken} sentences heard`);
    const r = this.reply;
    if (r?.state !== 'active') return;
    r.tts?.abort();
    // What was sent but not heard is gone from the browser's player; a new item follows if the turn carries on.
    if (r.announced) {
      this.send({ type: 'response.output_audio_transcript.done', response_id: r.id, item_id: r.itemId, transcript: r.itemText });
      r.announced = false;
      r.itemId = `${this.call.id}_a${this.replies}_${++r.items}`;
      r.itemText = '';
    }
  }

  private finish(r: Reply) {
    r.state = 'done';
    if (this.reply === r) this.reply = null;
    this.sendDone(r, 'completed');
    if (r.hangup) {
      // The agent would take another step after end_call; the call is over.
      this.send({ type: 'dispatch.hangup', response_id: r.id });
      void this.stopRun(r);
    }
  }

  /** Stops a reply: its speech, its event stream and its run. Resolves like stopRun, and never rejects. */
  private cancel(r: Reply, reason: 'turn_detected' | 'client_cancelled'): Promise<boolean> {
    if (r.state !== 'active') return r.stopped ?? Promise.resolve(true);
    r.state = 'cancelled';
    r.abort.abort();
    if (this.reply === r) this.reply = null;
    this.sendDone(r, 'cancelled', reason);
    return r.modelDone && !r.hangup ? Promise.resolve(true) : this.stopRun(r);
  }

  /**
   * The browser has stopped playing at `at` (barge-in). Replies are made far faster than they are
   * played, so the one still playing may have sent sentences nobody heard. The next turn gets a note
   * saying what was heard, since the agent's own history keeps everything it wrote.
   */
  private cutOff(at: number): { id: string; heard: number; spoken: number } | null {
    const r = this.playing && at < this.playhead ? this.playing : null;
    this.playing = null;
    this.playhead = 0;
    if (!r) return null;
    const heard = r.spoken.filter((_, i) => r.starts[i] !== undefined && r.starts[i] <= at);
    if (heard.length < r.spoken.length && r.said.length) {
      this.cutNote = heard.length
        ? `[${this.call.firstName} talked over your last reply. They heard only: "${clip(heard.join(' '), 600)}"]`
        : `[${this.call.firstName} talked over your last reply before hearing any of it.]`;
    }
    return { id: r.id, heard: heard.length, spoken: r.spoken.length };
  }

  private sendDone(r: Reply, status: 'completed' | 'cancelled', reason?: string) {
    const output: RealtimeResponse['output'] = [];
    if (r.announced) {
      this.send({ type: 'response.output_audio_transcript.done', response_id: r.id, item_id: r.itemId, transcript: r.itemText });
      output.push({ id: r.itemId, type: 'message', role: 'assistant', status: status === 'completed' ? 'completed' : 'incomplete', content: [{ type: 'output_audio', transcript: r.itemText }] });
    }
    this.send({ type: 'response.done', response: { id: r.id, object: 'realtime.response', status, ...(reason ? { status_details: { type: 'cancelled', reason } } : {}), output } });
  }

  private logLatency(r: Reply) {
    const t = r.timing;
    const ms = (to: number | undefined, from: number | undefined) => (to && from ? `${to - from} ms` : '?');
    const from = t.endOfSpeech ?? t.start;
    console.log(`[voice] ${this.call.id} ${r.id}: from ${t.endOfSpeech ? 'end of speech' : 'the request'}: final ${ms(t.final, from)}, first token ${ms(t.firstToken, from)}, first audio ${ms(t.firstAudio, from)}`);
  }

  // ---------- teardown ----------

  private fail(message: string) {
    if (this.closed) return;
    this.send({ type: 'error', error: { type: 'server_error', code: 'speech_unavailable', message } });
    this.client.close(1011, message.slice(0, 120));
    this.close();
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    // A turn still running would go on working for a call that has ended.
    if (this.reply) {
      const r = this.reply;
      r.state = 'cancelled';
      r.abort.abort();
      this.reply = null;
      void this.stopRun(r);
    }
    this.speech.terminate();
  }
}

export function attachVoiceRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const m = new URL(req.url ?? '/', 'http://x').pathname.match(/^\/api\/voice\/relay\/([^/]+)$/);
    if (!m) return; // not ours
    // Same check as every HTTP request: the session cookie (see lib/auth.ts).
    const user = authenticate(req.headers.cookie);
    const call = user ? claimCall(m[1], user.id) : null;
    if (!call) {
      socket.write(`HTTP/1.1 ${user ? '404 Not Found' : '401 Unauthorized'}\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => new Relay(ws, call));
  });
}
