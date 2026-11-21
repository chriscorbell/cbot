import { z } from 'zod';

/**
 * Reading a Hermes gateway's event streams (a run's events, in agent/runs.ts).
 * The data is JSON of unknown shape here; agent/run-events.ts checks what a run's events say.
 */

export interface StreamEvent { type: string; data: unknown }

const Typed = z.object({ type: z.string() });

/** The events of a text/event-stream body, JSON-decoded. Keepalives and `[DONE]` are skipped, and so is data that isn't JSON, with a warning. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let event = '';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue; // a keepalive comment
      const raw = data.join('\n');
      if (raw === '[DONE]') continue;
      try {
        const json: unknown = JSON.parse(raw);
        yield { type: event || Typed.safeParse(json).data?.type || '', data: json };
      } catch {
        // Hermes sends JSON; anything else means its stream changed, which should show in the log.
        console.warn(`[sse] skipped an event that isn't JSON${event ? ` (${event})` : ''}: ${raw.slice(0, 200)}`);
      }
    }
  }
}

// How a gateway (or an OpenAI-style server) words a refusal: {error: {message}}, {message} or {error: "..."}.
const Refusal = z.object({
  error: z.union([z.string(), z.object({ message: z.string().optional() })]).optional().catch(undefined),
  message: z.string().optional().catch(undefined),
});

/** Why a gateway refused a request, in words for the chat. */
export async function failureText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const r = Refusal.safeParse(JSON.parse(raw));
    if (r.success) {
      const { error, message } = r.data;
      const m = (typeof error === 'object' ? error.message : undefined) || message || (typeof error === 'string' ? error : undefined);
      if (m) return m;
    }
  } catch { /* plain text */ }
  if (res.status === 401 || res.status === 403) return 'the engine did not accept our key';
  return raw.slice(0, 300) || `the engine answered ${res.status}`;
}
