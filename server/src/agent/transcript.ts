import { markUnread, type Conversation } from '../store.js';
import type { ActivityKind, MessageBody, ToolCallBody } from '../types.js';
import * as live from './live.js';
import { activityFor, appToolName } from './tools.js';
import type { StepEvent } from './run-events.js';

/**
 * What one turn writes into the chat, from the events of its Hermes run (GET /v1/runs/<id>/events).
 * agent/turns.ts feeds it events, then how the run ended (agent/runs.ts); it writes rows through the
 * turn's Conversation and moves the bot's live state. test/turn.test.ts pins its behaviour with scripted runs.
 *
 * Text the model writes is held until it is clear what it is:
 *
 *   nothing ──text──► holding ──≥ HOLD chars──► streaming (a row the user sees grow)
 *      ▲                │                          │
 *      └──── closed ◄───┴──────────────────────────┘
 *              as a message: the run completed (the user sees it, +1 unread)
 *              as a note:    a tool call followed, or Hermes marked it commentary (the bot talking
 *                            to itself; kept for the record, hidden in the chat, shown on the status line)
 *
 * A turn that wrote only notes answers with its last one; a final answer that never streamed comes
 * whole with the run's end. A tool that ends the turn (ask_user, stay_silent, post_to_group) makes the
 * transcript `silent`: closing text after it is dropped.
 *
 * Each tool call gets a row: running → done | error, or awaiting-approval while Hermes waits for the
 * user (agent/approvals.ts) and denied if they said no. Its status comes from what the app's own tool
 * reported through MCP (see `claim`) if it did, else from Hermes. A call still running when the turn
 * ends becomes done (the run finished) or error (the turn failed or stopped).
 */

/** Text shorter than this is not shown until it is clear whether a tool call follows it. */
const HOLD = 140;
/** Least time between two updates of a streaming row, and between two reasoning captions. */
const FLUSH_MS = 120;
const CAPTION_MS = 300;

/** Hermes' own tool lookup (it loads rarely used tools on demand): not a step worth showing. */
const TOOLBOX = new Set(['tool_search', 'tool_describe']);

export interface Outcome { status?: ToolCallBody['status']; summary?: string }

interface ToolRef { seq: number; callId: string; name: string; claimed: boolean; done: boolean }

/** An app tool call (MCP) matched to the tool row this turn made for it. */
export interface ToolClaim { transcript: TurnTranscript; seq: number }

export class TurnTranscript {
  /** A tool ended the conversation for now: closing text is dropped. */
  private silent = false;
  private readonly tools: ToolRef[] = [];
  /** What an app tool said about its own call; beats the guess from its raw output. */
  private readonly outcomes = new Map<number, Outcome>();
  private readonly outputsSeen = new Set<string>();

  // The message being written: no row yet (msgSeq null) while holding.
  private msgSeq: number | null = null;
  private text = '';
  private lastFlush = 0;

  /** A message the user can see was written this turn. */
  private shown = false;
  /** Seqs of this turn's notes, oldest first. */
  private readonly notes: number[] = [];

  private lastCaption = 0;

  /** The conversation this turn writes to; app tools the turn calls write there too (mcp.ts). */
  constructor(private readonly botId: string, readonly convo: Conversation, private readonly clock: () => number = Date.now) {}

  // ---------- events ----------

  /** Apply one event of the run (its end comes to `completed` or `failed`). */
  onRunEvent(d: StepEvent) {
    switch (d.event) {
      case 'message.delta':
        this.textDelta(d.delta);
        return;
      case 'message.interim':
        this.commentary(d.text, !!d.already_streamed);
        return;
      case 'reasoning.available':
        if (d.text.trim()) {
          live.doing(this.botId, 'thinking', { unlessAlready: true });
          this.caption(captionFrom(d.text.slice(-4000)));
        }
        return;
      case 'tool.started':
        this.toolStarted(d);
        return;
      case 'tool.completed':
        this.toolOutput(d);
        return;
      default:
        return;
    }
  }

  private textDelta(delta: string) {
    if (this.silent) return;
    // Models often open with blank lines; a message never starts with them.
    const piece = this.text ? delta : delta.trimStart();
    if (!piece) return;
    this.text += piece;
    if (this.msgSeq === null && this.text.length >= HOLD) live.doing(this.botId, 'working');
    if (this.msgSeq === null ? this.text.length >= HOLD : this.clock() - this.lastFlush > FLUSH_MS) this.flush(true);
  }

  private toolStarted(d: Extract<StepEvent, { event: 'tool.started' }>) {
    // Text written before this call was the bot thinking aloud: a note, not a message.
    this.closeMessage(true);
    const raw = d.tool ?? '';
    const { name, ours } = appToolName(raw);
    if (!ours && TOOLBOX.has(name)) {
      this.caption('Finding the right tool', true);
      return;
    }
    const act = activityFor(raw);
    const callId = d.tool_call_id ?? '';
    const row = this.convo.append('tool-call', { type: 'tool-call', callId, name, label: act.label, status: 'running' } satisfies ToolCallBody);
    if (row) this.tools.push({ seq: row.seq, callId, name, claimed: false, done: false });
    // send_to_bot names its recipient once the call reaches the app (noteArgs).
    const kind: ActivityKind = name === 'send_to_bot' ? 'messaging_named' : act.kind;
    live.doing(this.botId, kind, { detail: name === 'send_to_bot' ? undefined : act.detail, clearCaption: true });
  }

  /** Mid-turn commentary. Already streamed, it is the text being written; otherwise it comes whole. */
  private commentary(text: string, alreadyStreamed: boolean) {
    if (alreadyStreamed) {
      if (this.msgSeq !== null || this.text.trim()) this.closeMessage(true);
    } else this.note(text);
  }

  /**
   * The run completed, with its final answer: shown here only if it never streamed. `recovered`: the
   * stream broke off and the answer came from Hermes' record, so the text being written may stop
   * short of it.
   */
  completed(out: string, recovered = false) {
    const t = this.text.trim();
    if (recovered && t && out.startsWith(t)) this.text = out;
    if (this.msgSeq !== null || this.text.trim()) {
      this.closeMessage();
      return;
    }
    const last = this.notes.length ? this.convo.get(this.notes[this.notes.length - 1]) : null;
    // The answer is the note it already wrote; finish() turns that into the message.
    if (!out || (last?.body.type === 'message' && last.body.text === out)) return;
    this.say(out);
  }

  private toolOutput(d: Extract<StepEvent, { event: 'tool.completed' }>) {
    const callId = d.tool_call_id ?? '';
    if (!callId || this.outputsSeen.has(callId)) return;
    this.outputsSeen.add(callId);
    const ref = this.tools.find((r) => r.callId === callId);
    if (!ref) return;
    ref.done = true;
    const told = this.outcomes.get(ref.seq);
    const row = this.convo.get(ref.seq);
    const denied = row?.body.type === 'tool-call' && row.body.status === 'denied';
    const guess: Outcome = denied ? { status: 'denied' } : d.error ? { status: 'error', summary: errorSummary(d.preview) } : { status: 'done' };
    this.patchTool(ref.seq, told?.status && told.status !== 'running' ? told : { status: guess.status, summary: told?.summary ?? guess.summary });
    live.doing(this.botId, 'thinking');
  }

  // ---------- Hermes' approval prompts (agent/approvals.ts) ----------

  /** Hermes is waiting for the user before a tool goes ahead: the tool it is about to run, if one is running. */
  awaitingApproval(): { name: string; label: string; seq: number } | null {
    const ref = [...this.tools].reverse().find((r) => !r.done);
    live.doing(this.botId, 'waiting_for_you', { clearCaption: true });
    if (!ref) return null;
    this.patchTool(ref.seq, { status: 'awaiting-approval' });
    const row = this.convo.get(ref.seq);
    return { name: ref.name, label: row?.body.type === 'tool-call' ? row.body.label : '', seq: ref.seq };
  }

  /** The prompt was answered or ran out: the tool runs on, or was turned down. */
  approvalSettled(seq: number | null, outcome: 'allowed' | 'always' | 'denied' | 'expired') {
    const row = seq === null ? null : this.convo.get(seq);
    if (row?.body.type === 'tool-call' && row.body.status === 'awaiting-approval') {
      this.patchTool(row.seq, { status: outcome === 'denied' ? 'denied' : 'running' });
      const act = activityFor(row.body.name);
      if (outcome !== 'denied') live.doing(this.botId, act.kind, { detail: act.detail });
    }
    if (outcome === 'denied' || row === null) live.doing(this.botId, 'thinking');
  }

  // ---------- the app's tools (MCP) ----------

  /** The first unclaimed, unfinished row for a tool of this name, which an app tool call now owns. */
  claim(name: string): ToolClaim | null {
    const ref = this.tools.find((r) => !r.claimed && !r.done && r.name === name);
    if (!ref) return null;
    ref.claimed = true;
    return { transcript: this, seq: ref.seq };
  }

  /** The arguments of an app tool call, which Hermes' run stream leaves out (send_to_bot names its recipient). */
  noteArgs(seq: number, args: unknown) {
    this.patchTool(seq, { args });
  }

  /** What an app tool said about its own call. */
  noteOutcome(seq: number, outcome: Outcome) {
    this.outcomes.set(seq, outcome);
    this.patchTool(seq, outcome);
  }

  /** A tool ended the conversation for now (it asked the user, or stayed silent). */
  silence() {
    this.silent = true;
  }

  // ---------- the end ----------

  /** The run failed or was stopped: whatever was being written ends here, then a notice says why. */
  failed(stopped: boolean, error: unknown) {
    this.closeMessage();
    const why = error instanceof Error ? error.message : String(error);
    this.convo.append('notice', { type: 'notice', text: stopped ? 'Stopped.' : `Something went wrong: ${why}`, tone: stopped ? 'info' : 'error' });
  }

  /** The turn is over, however it ended. */
  finish(outcome: 'done' | 'failed' | 'stopped') {
    this.closeMessage();
    // A turn that only thought aloud still answers: its last note becomes the message.
    if (!this.shown && outcome === 'done' && !this.silent && this.notes.length) {
      const seq = this.notes[this.notes.length - 1];
      const row = this.convo.get(seq);
      if (row?.body.type === 'message') {
        this.convo.update(seq, { ...row.body, note: undefined });
        this.unread();
      }
    }
    for (const ref of this.tools) {
      if (ref.done) continue;
      const row = this.convo.get(ref.seq);
      if (row?.body.type !== 'tool-call' || row.body.status !== 'running') continue;
      this.patchTool(ref.seq, outcome === 'done' ? { status: 'done' } : { status: 'error', summary: outcome === 'stopped' ? 'Stopped' : 'Did not finish' });
    }
  }

  // ---------- writing ----------

  private flush(streaming: boolean) {
    const b: MessageBody = { type: 'message', role: 'assistant', text: this.text, streaming };
    if (this.msgSeq === null) this.msgSeq = this.convo.append('message', b)?.seq ?? null;
    else this.convo.update(this.msgSeq, b);
    this.lastFlush = this.clock();
  }

  /** Ends the message being written: as a message to the user, or as a note to itself. */
  private closeMessage(asNote = false) {
    const t = this.text.trim();
    if (asNote && t) {
      const b: MessageBody = { type: 'message', role: 'assistant', text: t, streaming: false, note: true };
      if (this.msgSeq === null) this.pushNote(this.convo.append('message', b)?.seq);
      else { this.convo.update(this.msgSeq, b); this.pushNote(this.msgSeq); }
      this.caption(noteCaption(t), true);
    } else if (t) {
      this.flush(false);
      this.shown = true;
      this.unread();
    } else if (this.msgSeq !== null) this.convo.update(this.msgSeq, { type: 'message', role: 'assistant', text: '', streaming: false });
    this.msgSeq = null;
    this.text = '';
  }

  /** A whole message to the user. */
  private say(t: string) {
    if (this.silent || !t.trim()) return;
    this.closeMessage();
    this.convo.append('message', { type: 'message', role: 'assistant', text: t.trim(), streaming: false });
    this.unread();
    this.shown = true;
  }

  /** A whole note to itself (Hermes' "commentary"). */
  private note(t: string) {
    if (this.silent || !t.trim()) return;
    this.closeMessage();
    this.pushNote(this.convo.append('message', { type: 'message', role: 'assistant', text: t.trim(), streaming: false, note: true })?.seq);
    this.caption(noteCaption(t), true);
  }

  /** Something new for the user to read; not when the chat it went to has been cleared. */
  private unread() {
    if (this.convo.isCurrent()) markUnread(this.botId);
  }

  private pushNote(seq: number | undefined) {
    if (seq !== undefined) this.notes.push(seq);
  }

  private caption(c: string | null, force = false) {
    if (!c || c === live.getLive(this.botId).caption) return;
    if (!force && this.clock() - this.lastCaption < CAPTION_MS) return;
    this.lastCaption = this.clock();
    live.caption(this.botId, c);
  }

  private patchTool(seq: number, patch: Partial<ToolCallBody>) {
    const row = this.convo.get(seq);
    if (row?.body.type === 'tool-call') this.convo.update(seq, { ...row.body, ...patch });
  }
}

/** Why a tool failed, from the start of its result that Hermes sends along (it may send none). */
function errorSummary(preview: unknown): string | undefined {
  const text = typeof preview === 'string' ? preview.trim() : '';
  if (!text) return undefined;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      if (j.error) return String(typeof j.error === 'string' ? j.error : JSON.stringify(j.error)).slice(0, 200);
      if (typeof j.exit_code === 'number' && j.exit_code !== 0) return `Exit code ${j.exit_code}`;
      if (j.success === false) return String(j.message ?? 'Failed').slice(0, 200);
    }
  } catch { /* not JSON, or cut short */ }
  return text.slice(0, 200);
}

/**
 * A short line for the live status out of the model's running reasoning: the newest bold heading,
 * else the newest finished sentence. Reasoning streams in mid-sentence, and a half-written one
 * ("I'm going") reads as a glitch, so an unfinished sentence never shows.
 */
export function captionFrom(reasoning: string): string | null {
  const titles = [...reasoning.matchAll(/\*\*([^*\n]{3,80})\*\*/g)];
  if (titles.length) return titles[titles.length - 1][1].trim();
  const text = reasoning.replace(/\s+/g, ' ');
  // Sentences that have ended: a stop followed by a space (or the end of a paragraph).
  const done = [...text.matchAll(/[^.!?]*[^.!?\s][.!?]+(?=\s|$)/g)].map((m) => m[0].trim()).filter((x) => x.length >= 4);
  const sentence = done.pop();
  if (!sentence) return null;
  if (sentence.length <= 84) return sentence;
  const cut = sentence.slice(0, 82);
  return `${cut.slice(0, Math.max(40, cut.lastIndexOf(' '))).trimEnd()}…`;
}

/** A note's first sentence, short enough for the status line. */
function noteCaption(t: string): string {
  const first = t.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0];
  return first.length > 84 ? `${first.slice(0, 82).replace(/\s+\S*$/, '')}…` : first;
}
