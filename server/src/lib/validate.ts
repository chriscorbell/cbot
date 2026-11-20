import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

/**
 * A request's JSON body, checked against a zod schema. A body that isn't JSON, or doesn't fit, ends
 * the request with 400 and `{ error }`, the shape the web app shows; an empty body counts as {}.
 * Every route that reads a body uses this, so a handler only ever sees typed input.
 */
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const bad = (why: string) => new HTTPException(400, { res: c.json({ error: `Bad request: ${why}` }, 400) });
  const text = await c.req.text().catch(() => '');
  let raw: unknown = {};
  if (text.trim()) {
    try { raw = JSON.parse(text); } catch { throw bad('the body is not JSON'); }
  }
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw bad(z.prettifyError(r.error));
  return r.data;
}
