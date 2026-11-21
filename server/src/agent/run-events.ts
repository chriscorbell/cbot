import { z } from 'zod';

/**
 * What a Hermes run sends (GET /v1/runs/<id>/events) and answers (POST /v1/runs, its stop and status),
 * checked where it enters: agent/runs.ts reads runs, agent/approvals.ts their prompts.
 *
 * A known event that isn't shaped as expected is logged and passed on as `other`, which every reader
 * ignores, so the run goes on as it would without it. An event Hermes added that Dispatch doesn't know
 * is `other` too. The run's end events need nothing but their name, so no run waits on a malformed one.
 */

const id = z.string().nullish();

const Known = z.discriminatedUnion('event', [
  z.object({ event: z.literal('message.delta'), delta: z.string() }),
  /** Commentary beside tool calls; `already_streamed` when it went out as text already. */
  z.object({ event: z.literal('message.interim'), text: z.string(), already_streamed: z.boolean().nullish() }),
  z.object({ event: z.literal('reasoning.available'), text: z.string() }),
  z.object({ event: z.literal('tool.started'), tool: z.string().nullish(), tool_call_id: id }),
  /** `error` is true (or a message) when the tool failed; `preview` is the start of its output. */
  z.object({ event: z.literal('tool.completed'), tool: z.string().nullish(), tool_call_id: id, error: z.unknown().optional(), preview: z.unknown().optional() }),
  /** Hermes asks before an action. Answering it takes the prompt's id and the execution generation. */
  z.object({
    event: z.literal('approval.request'),
    prompt_id: id,
    request_id: id,
    execution_generation: z.number().nullish(),
    choices: z.array(z.string()).nullish(),
    description: z.string().nullish(),
    command: z.string().nullish(),
  }),
  z.object({ event: z.literal('approval.responded') }),
  /** `output` is the final answer, which matters only when it never streamed. */
  z.object({ event: z.literal('run.completed'), output: z.unknown().optional() }),
  z.object({ event: z.literal('run.failed'), error: z.unknown().optional() }),
  z.object({ event: z.literal('run.cancelled'), error: z.unknown().optional() }),
  z.object({ event: z.literal('run.interrupted'), error: z.unknown().optional() }),
]);

export type RunEvent = z.infer<typeof Known> | { event: 'other'; name: string };
export type ApprovalRequest = Extract<RunEvent, { event: 'approval.request' }>;
/** The events that end a run. agent/runs.ts reads them; the surfaces get the rest. */
export type EndEvent = Extract<RunEvent, { event: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.interrupted' }>;
export type StepEvent = Exclude<RunEvent, EndEvent>;

const KNOWN = new Set<string>(Known.options.map((o) => o.shape.event.value));
const Named = z.object({ event: z.string() });

const clip = (data: unknown) => JSON.stringify(data)?.slice(0, 200) ?? String(data);

/** One event of a run, checked. Null for data with no event name, which the reader skips. */
export function runEvent(data: unknown): RunEvent | null {
  const named = Named.safeParse(data);
  if (!named.success) {
    console.warn(`[hermes] skipped a run event with no name: ${clip(data)}`);
    return null;
  }
  const name = named.data.event;
  if (!KNOWN.has(name)) return { event: 'other', name };
  const ev = Known.safeParse(data);
  if (ev.success) return ev.data;
  console.warn(`[hermes] ignored a ${name} event that isn't shaped as expected (${z.prettifyError(ev.error).replace(/\s+/g, ' ')}): ${clip(data)}`);
  return { event: 'other', name };
}

/** The event's name, as runSlot (engine.ts) counts them. */
export const eventName = (ev: RunEvent) => (ev.event === 'other' ? ev.name : ev.event);

const Started = z.object({ run_id: z.string().min(1) });
/** The id of the run POST /v1/runs started, or null when the answer names none. */
export function startedRun(body: unknown): string | null {
  return Started.safeParse(body).data?.run_id ?? null;
}

const Stopped = z.object({ status: z.string() });
/** The status POST /v1/runs/<id>/stop answered with ('cancelled' when there was nothing left to stop), or ''. */
export function stoppedStatus(body: unknown): string {
  return Stopped.safeParse(body).data?.status ?? '';
}

const State = z.object({ status: z.string(), output: z.unknown().optional(), error: z.unknown().optional() });
export interface RunState { status: string; output: string; error: string }
/** Where GET /v1/runs/<id> says the run is (queued, running, completed, failed, …), with its answer or error; null when the answer can't be read. */
export function runState(body: unknown): RunState | null {
  const s = State.safeParse(body);
  if (!s.success) {
    console.warn(`[hermes] a run's status isn't shaped as expected: ${clip(body)}`);
    return null;
  }
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return { status: s.data.status, output: text(s.data.output), error: text(s.data.error) };
}

const Status = z.object({ pending_controls: z.array(z.object({ prompt_id: z.string().nullish() })).nullish() });
/** The prompts GET /v1/runs/<id> says are still waiting for an answer; null when the answer can't be read. */
export function openPrompts(body: unknown): Set<string> | null {
  const s = Status.safeParse(body);
  if (!s.success) {
    console.warn(`[hermes] a run's status isn't shaped as expected: ${clip(body)}`);
    return null;
  }
  return new Set((s.data.pending_controls ?? []).flatMap((c) => (c.prompt_id ? [c.prompt_id] : [])));
}
