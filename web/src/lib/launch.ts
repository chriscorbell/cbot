/**
 * What the address the app opened with asks for, taken out of it as the page loads (main.tsx), so a
 * reload or a bookmark doesn't ask again:
 *
 * - `/share?title=&text=&url=`: text another app shared with Dispatch, through the share sheet of a
 *   phone that installed it (`share_target` in public/manifest.webmanifest; Android, not iOS). It
 *   goes in the composer of the chat that opens, for the user to send or change.
 */
let shared: string | null = null;

/**
 * Shared parts as one message. Apps fill the fields differently: many put the link in `text` too,
 * and a page's title is often its first line already, so what one field repeats of another is left out.
 */
export function sharedText(title: string | null, text: string | null, url: string | null): string {
  const t = (title ?? '').trim();
  const body = (text ?? '').trim();
  const link = (url ?? '').trim();
  const parts: string[] = [];
  if (t && !body.includes(t)) parts.push(t);
  if (body) parts.push(body);
  if (link && !body.includes(link)) parts.push(link);
  return parts.join('\n');
}

export function captureLaunch() {
  const u = new URL(window.location.href);
  let changed = false;
  if (u.pathname === '/share') {
    shared = sharedText(u.searchParams.get('title'), u.searchParams.get('text'), u.searchParams.get('url')) || null;
    u.pathname = '/';
    u.search = '';
    changed = true;
  }
  if (changed) history.replaceState(history.state, '', u.pathname + u.search + u.hash);
}

/** Text shared from another app, once. */
export function takeShared(): string | null {
  const s = shared;
  shared = null;
  return s;
}
