import { failureText, sseEvents } from '../lib/sse.js';
import { errorText } from '../lib/errors.js';
import { engineFor, runSlot, type Engine } from '../engine.js';
import type { Conversation } from '../store.js';
import { askApproval, runEnded, runMoved, type Settled } from './approvals.js';
import { eventName, runEvent, startedRun, stoppedStatus, type ApprovalRequest, type StepEvent } from './run-events.js';

/**
 * A Hermes run: one turn of a bot's agent on its gateway (POST /v1/runs), whoever asked for it. A chat
 * turn (agent/turns.ts), a voice reply (voice-relay.ts) and a call's summary (voice.ts) each make a
 * HermesRun, and this file starts it, follows its events and stops it, so the three agree on what a
 * run did:
 *
 *   gateway ──start──► started ──follow──► completed   run.completed, with its final answer
 *      │                  │          ├───► failed      run.failed, or run.cancelled / run.interrupted
 *      │                  │          │                 that the caller didn't ask for (Hermes stopped it)
 *      │                  │          └───► left        the caller stopped following
 *      │                  └──stop──► stopped (Hermes was asked; it ends the run on its side)
 *      └──the caller gave up before Hermes had the run: nothing to stop
 *
 * The caller's own Stop aborts `follow`'s signal, which throws. `close` is the end, however it came:
 * the gateway's warm-up slot is released, prompts still waiting expire (agent/approvals.ts) and a run
 * that hasn't ended is stopped, since nobody follows it any more.
 */

export interface RunRequest {
  /** The bot's model choice; null runs Hermes' default. */
  model: string | null;
  provider: string | null;
  input: string;
  instructions: string;
  /** Hermes' session: the conversation the run continues. */
  session: string;
  effort: string;
}

export type RunEnd =
  | { how: 'completed'; output: string }
  | { how: 'failed'; error: string }
  | { how: 'left' };

/** Who asked for the run, for the log. */
export type Surface = 'chat' | 'voice' | 'summary';

const headers = (e: Engine, json: boolean) => ({
  ...(json ? { 'content-type': 'application/json' } : { accept: 'text/event-stream' }),
  ...(e.key ? { authorization: `Bearer ${e.key}` } : {}),
});

export class HermesRun {
  private engine: Engine | null = null;
  private runId: string | null = null;
  /** Settles once the request that creates the run has been answered. */
  private creating: Promise<void> | null = null;
  private slot: ((event?: unknown) => void) | null = null;
  /** Hermes said the run ended: there is nothing left to stop. */
  private ended = false;
  private stopping: Promise<string> | null = null;
  private closed = false;

  constructor(readonly botId: string, readonly surface: Surface) {}

  /** Hermes' id for the run, once it has one. */
  get id(): string | null {
    return this.runId;
  }

  /** The bot's gateway, started if it isn't running. */
  async gateway(): Promise<Engine> {
    this.engine ??= await engineFor(this.botId);
    return this.engine;
  }

  /**
   * Starts the run. Right after its gateway starts, a bot's first run goes alone for a moment
   * (runSlot). False when `signal` was aborted before Hermes had the run; throws when Hermes refuses it.
   */
  async start(req: RunRequest, signal: AbortSignal): Promise<boolean> {
    const engine = await this.gateway();
    if (signal.aborted) return false;
    this.slot = await runSlot(this.botId);
    if (signal.aborted) return false;
    let answered!: () => void;
    this.creating = new Promise<void>((res) => { answered = res; });
    try {
      // Not aborted with the caller: a run Hermes started that nobody knows the id of could not be stopped.
      const res = await fetch(`${engine.url}/v1/runs`, {
        method: 'POST',
        headers: headers(engine, true),
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: req.model || 'hermes-agent',
          ...(req.provider ? { provider: req.provider } : {}),
          input: req.input,
          instructions: req.instructions,
          session_id: req.session,
          model_options: { reasoning_effort: req.effort },
        }),
      });
      if (!res.ok) throw new Error(await failureText(res));
      const id = startedRun(await res.json());
      if (!id) throw new Error('Hermes started no run');
      this.runId = id;
      return true;
    } finally {
      answered();
    }
  }

  /**
   * Follows the run's events until it ends, handing every event but its end to `onEvent`, which
   * returns true to stop following. Throws when `signal` is aborted (the caller's Stop) or the
   * stream can't be opened.
   */
  async follow(signal: AbortSignal, onEvent: (ev: StepEvent) => boolean | void): Promise<RunEnd> {
    const engine = this.engine;
    const id = this.runId;
    if (!engine || !id) throw new Error('the run never started');
    const res = await fetch(`${engine.url}/v1/runs/${id}/events`, { headers: headers(engine, false), signal });
    if (!res.ok || !res.body) throw new Error(await failureText(res));
    for await (const raw of sseEvents(res.body)) {
      const ev = runEvent(raw.data);
      if (!ev) continue;
      this.slot?.(eventName(ev));
      // A prompt may have ended without an answer (Hermes' own timeout) once the run moves on.
      if (ev.event !== 'approval.request' && ev.event !== 'approval.responded') runMoved(id);
      switch (ev.event) {
        case 'run.completed':
          this.ended = true;
          return { how: 'completed', output: typeof ev.output === 'string' ? ev.output.trim() : '' };
        case 'run.failed':
          this.ended = true;
          return { how: 'failed', error: typeof ev.error === 'string' && ev.error ? ev.error : 'the agent run failed' };
        case 'run.cancelled':
        case 'run.interrupted':
          // Not a Stop from here (that aborts `signal`): Hermes, or something else, stopped the run.
          this.ended = true;
          return { how: 'failed', error: typeof ev.error === 'string' && ev.error ? ev.error : 'the run was stopped' };
        default:
          if (onEvent(ev)) return { how: 'left' };
      }
    }
    return { how: 'completed', output: '' };
  }

  /** Hermes asks before an action: the card shows in `convo` (agent/approvals.ts). The approval's id, or null when it can't be asked. */
  askApproval(event: ApprovalRequest, o: { convo: Conversation; tool: { name: string; label: string } | null; onSettled?: (outcome: Settled) => void }): string | null {
    if (!this.engine || !this.runId) return null;
    return askApproval({ convo: o.convo, engine: this.engine, runId: this.runId, event, tool: o.tool, onSettled: o.onSettled });
  }

  /** Hands the running turn more input; Hermes gives it to the agent before its next model call. */
  async steer(input: string): Promise<{ ok: boolean; why: string }> {
    if (!this.engine || !this.runId) return { ok: false, why: 'the run never started' };
    const res = await fetch(`${this.engine.url}/v1/runs/${this.runId}/steer`, { method: 'POST', headers: headers(this.engine, true), body: JSON.stringify({ input }) })
      .catch((e: unknown) => errorText(e));
    if (typeof res === 'string') return { ok: false, why: res };
    return { ok: res.ok, why: `HTTP ${res.status}` };
  }

  /**
   * Asks Hermes to stop the run, once; if the request creating it is still out, once it is answered.
   * Resolves with the status Hermes answered ('cancelled' when there was nothing left to stop), or ''
   * when there was no run or no answer. Never rejects.
   */
  stop(): Promise<string> {
    this.stopping ??= (async () => {
      await this.creating;
      const engine = this.engine;
      const id = this.runId;
      if (!engine || !id) return '';
      const res = await fetch(`${engine.url}/v1/runs/${id}/stop`, { method: 'POST', headers: headers(engine, true), body: '{}', signal: AbortSignal.timeout(10_000) })
        .catch((e: unknown) => {
          console.warn(`[hermes] ${this.botId}: couldn't stop the ${this.surface} run ${id}; it may still be running: ${errorText(e)}`);
          return null;
        });
      if (!res) return '';
      if (!res.ok) {
        console.warn(`[hermes] ${this.botId}: Hermes refused to stop the ${this.surface} run ${id} (HTTP ${res.status}); it may still be running`);
        return '';
      }
      return stoppedStatus(await res.json().catch(() => null));
    })();
    return this.stopping;
  }

  /** Done with the run, however it went. A run that hasn't ended is stopped: nobody follows it any more. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.slot?.();
    if (!this.runId) return;
    // Its prompts can't be answered once nobody follows the run.
    runEnded(this.runId);
    if (!this.ended) void this.stop();
  }
}
