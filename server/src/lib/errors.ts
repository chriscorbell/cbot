/**
 * What a catch or a rejection hands over is `unknown`: usually an Error, but a library can throw
 * anything. These read it without assuming what it is.
 */

/** The message of an Error, or the thing itself as text. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A field Node puts on its errors (an errno `code`, a child process's `stdout` or `stderr`, fetch's `cause`), or undefined. */
export function errorField(e: unknown, key: string): unknown {
  return typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined;
}
