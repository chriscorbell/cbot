import { db, now, type RunRecord } from '../db.js';
import { failureText, sseEvents } from '../lib/sse.js';
import { errorText } from '../lib/errors.js';
import { engineFor, gatewayIfRunning, holdGateway, runSlot, type Engine } from '../engine.js';
import type { Conversation } from '../store.js';
import { askApproval, runEnded, runMoved, type Settled } from './approvals.js';
import { eventName, runEvent, runState, startedRun, stoppedStatus, type ApprovalRequest, type StepEvent } from './run-events.js';

/**
 * A Hermes run: one turn of a bot's agent on its gateway (POST /v1/runs), whoever asked for it. A chat
 * turn (agent/turns.ts), a voice reply (voice-relay.ts) and a call's summary (voice.ts) each make a
 * HermesRun, and this file starts it, follows its events and stops it, so the three agree on what a
 * run did:
 *
 *   gateway ──start──► started ──follow──► completed   run.completed, with its final answer
 *      │                  │          ├───► failed      run.failed, or run.cancelled / run.interrupted
 *      │                  │          │                 that the caller didn't ask for (Hermes stopped it)
 *      │                  │          ├───► lost        the stream ended with no end event: Hermes'
 *      │                  │          │                 record of the run decides, completed or failed
 *      │                  │          └───► left        the caller stopped following
 *      │                  └──stop──► stopped (Hermes was asked; it ends the run on its side)
 *      └──the caller gave up before Hermes had the run: nothing to stop
 *
 * The caller's own Stop aborts `follow`'s signal, which throws. `close` is the end, however it came:
 * the gateway's warm-up slot is released, prompts still waiting expire (agent/approvals.ts), a run
 * that hasn't ended is stopped, since nobody follows it any more, and the gateway is let go. From
 * `gateway` to `close` the run holds its gateway (engine.ts holdGateway), so new provider settings
 * don't restart it under the run.
 *
 * A run is in `runs` from when Hermes has it until it is seen to end or Hermes answers its stop. The
 * gateways outlive this server, so a restart (every deploy and update) finds there the runs nobody
 * follows any more and settles them before any new run starts (settleLeftoverRuns).
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
  /** `recovered`: the stream broke before the end and the answer came from Hermes' record, so what streamed may stop short of it. */
  | { how: 'completed'; output: string; recovered?: boolean }
  | { how: 'failed'; error: string }
  | { how: 'left' };

/** Why a run whose stream ended with no end event failed. */
const LOST = 'the agent stopped answering before it finished; its gateway may have restarted or run out of memory';

/** Statuses of a run that is over (GET /v1/runs/<id>). */
const OVER = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Who asked for the run. */
export type Surface = RunRecord['surface'];

const headers = (e: Engine, json: boolean) => ({
  ...(json ? { 'content-type': 'application/json' } : { accept: 'text/event-stream' }),
  ...(e.key ? { authorization: `Bearer ${e.key}` } : {}),
});

const remember = db.prepare<[string, string, number, string]>('INSERT OR REPLACE INTO runs(id,bot_id,surface,started_at) SELECT ?, id, ?, ? FROM bots WHERE id=?');
const forget = db.prepare<[string]>('DELETE FROM runs WHERE id=?');

/** What GET /v1/runs/<id> says of a run, or null when the gateway doesn't answer or doesn't know it. */
async function stateOf(engine: Engine, id: string) {
  const res = await fetch(`${engine.url}/v1/runs/${id}`, { headers: headers(engine, true), signal: AbortSignal.timeout(5_000) }).catch(() => null);
  return res?.ok ? runState(await res.json().catch(() => null)) : null;
}

/** Asks Hermes to stop a run. The status it answered, or null when it didn't answer or refused. */
async function requestStop(engine: Engine, id: string, what: string): Promise<string | null> {
  const res = await fetch(`${engine.url}/v1/runs/${id}/stop`, { method: 'POST', headers: headers(engine, true), body: '{}', signal: AbortSignal.timeout(10_000) })
    .catch((e: unknown) => {
      console.warn(`[hermes] couldn't stop ${what} ${id}; it may still be running: ${errorText(e)}`);
      return null;
    });
  if (!res) return null;
  if (!res.ok) {
    console.warn(`[hermes] Hermes refused to stop ${what} ${id} (HTTP ${res.status}); it may still be running`);
    return null;
  }
  return stoppedStatus(await res.json().catch(() => null));
}

/** Settles once the runs the last process left are settled; new runs wait for it. */
let leftovers: Promise<unknown> = Promise.resolve();

/** A run the last process left, settled: `answer` is its final answer if Hermes finished it meanwhile. */
export interface Leftover { botId: string; surface: Surface; answer: string | null }

/**
 * On server start: the runs the last process started and never saw end. Their events went to a
 * process that is gone, so nobody follows them. One Hermes still has going is stopped; one it finished
 * meanwhile hands back its answer. By run id.
 */
export function settleLeftoverRuns(): Promise<Map<string, Leftover>> {
  const left = db.prepare<[], RunRecord>('SELECT * FROM runs').all();
  const settled = (async () => {
    const out = new Map<string, Leftover>();
    await Promise.all(left.map(async (r) => {
      let answer: string | null = null;
      let keep = false;
      const engine = gatewayIfRunning(r.bot_id);
      const state = engine ? await stateOf(engine, r.id) : null;
      if (engine && state?.status === 'completed') answer = state.output.trim();
      else if (engine && !(state && OVER.has(state.status))) {
        // Going, or the gateway didn't say (it may only be slow): asked to stop either way.
        const stopped = await requestStop(engine, r.id, `the ${r.surface} run the last process left`);
        if (stopped !== null) console.log(`[hermes] ${r.bot_id}: stopped the ${r.surface} run ${r.id}, which nobody follows since the restart`);
        // One Hermes says is still going but wouldn't stop stays, for the next start to try again.
        else if (state) keep = true;
      }
      if (!keep) forget.run(r.id);
      out.set(r.id, { botId: r.bot_id, surface: r.surface, answer });
    }));
    return out;
  })();
  leftovers = settled.catch(() => {});
  return settled;
}

export class HermesRun {
  private engine: Engine | null = null;
  private runId: string | null = null;
  /** Settles once the request that creates the run has been answered. */
  private creating: Promise<void> | null = null;
  private slot: ((event?: unknown) => void) | null = null;
  /** Lets go of the gateway (engine.ts holdGateway). */
  private release: (() => void) | null = null;
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
    if (this.engine) return this.engine;
    if (!this.closed) this.release ??= holdGateway(this.botId);
    this.engine = await engineFor(this.botId, { held: !!this.release });
    return this.engine;
  }

  /**
   * Starts the run. Right after its gateway starts, a bot's first run goes alone for a moment
   * (runSlot). False when `signal` was aborted before Hermes had the run; throws when Hermes refuses it.
   */
  async start(req: RunRequest, signal: AbortSignal): Promise<boolean> {
    const engine = await this.gateway();
    if (signal.aborted) return false;
    // Not beside a run the last process left on the same session.
    await leftovers;
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
      remember.run(id, this.surface, now(), this.botId);
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
    // Set while the caller's handler runs: what it throws is the caller's, not a broken stream.
    let handling = false;
    try {
      for await (const raw of sseEvents(res.body)) {
        const ev = runEvent(raw.data);
        if (!ev) continue;
        this.slot?.(eventName(ev));
        // A prompt may have ended without an answer (Hermes' own timeout) once the run moves on.
        if (ev.event !== 'approval.request' && ev.event !== 'approval.responded') runMoved(id);
        switch (ev.event) {
          case 'run.completed':
            this.over();
            return { how: 'completed', output: typeof ev.output === 'string' ? ev.output.trim() : '' };
          case 'run.failed':
            this.over();
            return { how: 'failed', error: typeof ev.error === 'string' && ev.error ? ev.error : 'the agent run failed' };
          case 'run.cancelled':
          case 'run.interrupted':
            // Not a Stop from here (that aborts `signal`): Hermes, or something else, stopped the run.
            this.over();
            return { how: 'failed', error: typeof ev.error === 'string' && ev.error ? ev.error : 'the run was stopped' };
          default:
            handling = true;
            if (onEvent(ev)) return { how: 'left' };
            handling = false;
        }
      }
    } catch (e) {
      if (signal.aborted || handling) throw e;
      // A gateway that dies mid-stream usually cuts the connection rather than closing it.
      console.warn(`[hermes] ${this.botId}: the events of the ${this.surface} run ${id} broke off: ${errorText(e)}`);
    }
    if (signal.aborted) throw new Error('aborted');
    return this.lost(engine, id);
  }

  /**
   * The run's events ended with no end event. A gateway killed by its slice's memory limit (units.ts)
   * leaves exactly this, and so does one that restarted; rarely, only the stream broke. Hermes' record
   * of the run decides: an answer it finished is the answer, anything else is a failure. A run Hermes
   * still has going is stopped when the caller closes it, since nobody can follow it now.
   */
  private async lost(engine: Engine, id: string): Promise<RunEnd> {
    const state = await stateOf(engine, id);
    if (state?.status === 'completed') {
      this.over();
      return { how: 'completed', output: state.output.trim(), recovered: true };
    }
    // Over: nothing is left to stop. When Hermes didn't say (gone, or only slow to answer), close()
    // still asks it to stop, and a run it can't be asked about stays in `runs` for the next start.
    if (state && OVER.has(state.status)) this.over();
    console.warn(`[hermes] ${this.botId}: the ${this.surface} run ${id} sent no end; Hermes says ${state ? state.status : 'nothing of it'}`);
    return { how: 'failed', error: LOST };
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
      const status = await requestStop(engine, id, `${this.botId}'s ${this.surface} run`);
      // Hermes has it; one it couldn't be asked about stays in `runs` for the next start to settle.
      if (status !== null) forget.run(id);
      return status ?? '';
    })();
    return this.stopping;
  }

  /** Hermes says the run is over: nothing is left to stop or settle. */
  private over() {
    this.ended = true;
    if (this.runId) forget.run(this.runId);
  }

  /** Done with the run, however it went. A run that hasn't ended is stopped: nobody follows it any more. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.slot?.();
    if (this.runId) {
      // Its prompts can't be answered once nobody follows the run.
      runEnded(this.runId);
      if (!this.ended) void this.stop();
    }
    this.release?.();
  }
}
