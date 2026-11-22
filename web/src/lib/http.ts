/**
 * The one way the web app calls the server's HTTP API. Responses are typed with server/src/contract.ts
 * (@shared/contract); a failed call throws ApiError with the server's `{ error }` text.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let signedOut: (() => void) | null = null;

/** Called on any 401 except a refused password: the session is gone, so the app goes back to the sign-in screen. */
export function onSignedOut(fn: () => void) { signedOut = fn; }

async function fail(res: Response, path: string, fallback = res.statusText): Promise<never> {
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/password') signedOut?.();
  let msg = fallback;
  try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
  throw new ApiError(res.status, msg || `HTTP ${res.status}`);
}

/** A JSON request to /api<path>. */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return fail(res, path);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** A JSON request the browser sends even as the page goes away (pagehide). Nobody reads its answer. */
export function sendKeepalive(method: string, path: string, body: unknown): void {
  fetch(`/api${path}`, { method, credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}

/** A multipart upload to /api<path>. `tooLarge` is the message for a 413 without one of its own. */
export async function upload<T>(path: string, form: FormData, tooLarge?: string): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', body: form });
  if (!res.ok) return fail(res, path, res.status === 413 && tooLarge ? tooLarge : res.statusText);
  return res.json() as Promise<T>;
}

/** A binary response (audio, images) from /api<path>. */
export async function binary(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return fail(res, path);
  return res.arrayBuffer();
}

/** An image from /api<path>, or null when the server has none (204) or refuses. Throws only when the request fails. */
export async function image(path: string): Promise<Blob | null> {
  const res = await fetch(`/api${path}`, { credentials: 'include', cache: 'no-store' });
  return res.status === 200 ? res.blob() : null;
}

/** The first `limit` bytes of a file from /api<path> (all of it without a limit), and the whole file's size. */
export async function fileStart(path: string, limit?: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array<ArrayBuffer>; size: number }> {
  const res = await fetch(`/api${path}`, { credentials: 'include', signal, headers: limit ? { Range: `bytes=0-${limit - 1}` } : undefined });
  if (!res.ok) return fail(res, path);
  const all = new Uint8Array(await res.arrayBuffer());
  const bytes = limit ? all.subarray(0, limit) : all;
  return { bytes, size: Number(res.headers.get('content-range')?.split('/')[1]) || all.length };
}
