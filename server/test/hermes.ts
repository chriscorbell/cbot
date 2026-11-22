// A stand-in for a bot's Hermes gateway: answers the run API (POST /v1/runs, its events, status,
// approvals and stop) and GET /api/sessions/<id>. Each run plays the next script, written the way
// Hermes sends its run events; a promise in a script holds the stream there until it settles. A script
// with no end event ends its stream as a gateway that went away would.
import { vi } from 'vitest';

export type HermesEvent = { event: string; [k: string]: unknown };

/** A step of a script: an event to send, or a promise to wait for before sending the rest. */
export type Step = HermesEvent | Promise<unknown>;

const frame = (ev: HermesEvent) => `data: ${JSON.stringify(ev)}\n\n`;

/** Events for common shapes, so scripts read like what the model did. */
export const ev = {
  text: (delta: string): HermesEvent => ({ event: 'message.delta', delta }),
  /** Commentary beside tool calls; `streamed` when it already went out as text. */
  interim: (text: string, streamed = false): HermesEvent => ({ event: 'message.interim', text, already_streamed: streamed }),
  reasoning: (text: string): HermesEvent => ({ event: 'reasoning.available', text }),
  toolCall: (tool: string, callId: string, preview = ''): HermesEvent => ({ event: 'tool.started', tool, preview, tool_call_id: callId }),
  toolDone: (callId: string, o: { error?: boolean; preview?: string } = {}): HermesEvent =>
    ({ event: 'tool.completed', tool_call_id: callId, duration: 0, error: !!o.error, preview: o.preview ?? '' }),
  approval: (promptId: string, o: { command?: string; description?: string; choices?: string[] } = {}): HermesEvent => ({
    event: 'approval.request', kind: 'approval', prompt_id: promptId, execution_generation: 1,
    command: o.command ?? 'rm -rf /tmp/x', description: o.description ?? 'delete in root path', choices: o.choices ?? ['once', 'deny', 'session', 'always'],
  }),
  completed: (output = ''): HermesEvent => ({ event: 'run.completed', output }),
  failed: (error: string): HermesEvent => ({ event: 'run.failed', error }),
};

/** A promise and the function that settles it, to hold a stream at a point until the test says so. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
}

export interface HermesCall { method: string; path: string; body: Record<string, unknown> | undefined }

/**
 * Makes `fetch` answer requests to the engine. Every POST /v1/runs plays the next script on its event
 * stream; aborting the stream (Stop) errors it the way undici does. Returns the bodies of the runs
 * started, with every request in `calls`, the sessions that exist in `sessions`, `expire` to have
 * Hermes give up on a prompt by itself, and `states` to set what GET /v1/runs/<id> says of a run
 * (running until its script ends it).
 */
export function fakeHermes(...scripts: Step[][]) {
  const runs: Record<string, unknown>[] = [];
  const calls: HermesCall[] = [];
  const sessions = new Set<string>();
  /** Prompts Hermes is still waiting on, by run. */
  const open = new Map<string, Set<string>>();
  const plays = new Map<string, Step[]>();
  const states = new Map<string, { status: string; output?: string }>();
  const unanswered = new Set<string>();
  const unstoppable = new Set<string>();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    let m: RegExpMatchArray | null;
    if (method === 'POST' && path === '/v1/runs') {
      runs.push(body);
      const runId = `run_${runs.length}`;
      plays.set(runId, scripts.shift() ?? []);
      open.set(runId, new Set());
      if (body?.session_id) sessions.add(body.session_id);
      return json({ run_id: runId, status: 'started' }, 202);
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/runs\/([^/]+)\/events$/))) {
      const runId = m[1];
      const script = plays.get(runId) ?? [];
      const signal = init.signal;
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          const aborted = () => c.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          signal?.addEventListener('abort', aborted, { once: true });
          for (const step of script) {
            if (signal?.aborted) return;
            if (step instanceof Promise) await step;
            else {
              if (step.event === 'approval.request') open.get(runId)?.add(String(step.prompt_id));
              if (step.event.startsWith('run.')) states.set(runId, { status: step.event.slice(4), output: typeof step.output === 'string' ? step.output : '' });
              c.enqueue(enc.encode(frame(step)));
            }
          }
          if (!signal?.aborted) c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/runs\/([^/]+)$/))) {
      if (unanswered.has(m[1])) return json({ error: { message: 'busy' } }, 503);
      if (!plays.has(m[1]) && !states.has(m[1])) return json({ error: { message: `Run not found: ${m[1]}` } }, 404);
      return json({ run_id: m[1], status: 'running', ...states.get(m[1]), pending_controls: [...(open.get(m[1]) ?? [])].map((id) => ({ kind: 'approval', prompt_id: id })) });
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/runs\/([^/]+)\/approval$/))) {
      // Hermes takes exactly these three fields for a run's prompt.
      const keys = Object.keys(body ?? {}).sort().join(',');
      if (keys !== 'choice,execution_generation,request_id') return json({ error: { message: 'invalid_params' } }, 400);
      if (!open.get(m[1])?.delete(body.request_id)) return json({ error: { message: 'approval_not_pending' } }, 409);
      return json({ run_id: m[1], status: 'resolved', prompt_id: body.request_id });
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/runs\/([^/]+)\/stop$/))) {
      if (unstoppable.has(m[1])) return json({ error: { message: 'internal error' } }, 500);
      open.get(m[1])?.clear();
      return json({ run_id: m[1], status: 'stopping' });
    }
    if (method === 'GET' && (m = path.match(/^\/api\/sessions\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      return sessions.has(id) ? json({ session: { id } }) : json({ error: { message: `Session not found: ${id}` } }, 404);
    }
    return json({ error: { message: 'not found' } }, 404);
  });

  return Object.assign(runs, {
    calls,
    sessions,
    states,
    /** Runs whose state GET /v1/runs/<id> doesn't answer, as a gateway too busy to reply. */
    unanswered,
    /** Runs Hermes refuses to stop. */
    unstoppable,
    /** Hermes stops waiting for a prompt (its timeout), as if nobody answered. */
    expire: (promptId: string) => { for (const s of open.values()) s.delete(promptId); },
  });
}
