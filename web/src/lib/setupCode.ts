/**
 * The setup code a new account needs (server/src/lib/auth.ts). The installer prints Dispatch's address
 * with it after `#setup=`, and Reset Dispatch reloads the page the same way. It is taken out of the
 * address bar as the page loads, so it isn't left in the history or a bookmark, and kept for this tab,
 * so a reload doesn't lose it. The first-run form asks for it only when the page came without one.
 */
const KEY = 'dispatch.setupCode';
let kept = '';
const listeners = new Set<(code: string) => void>();

/** The code in an address's fragment (`#setup=ABCD-EFGH`), or null. */
export function setupCodeFrom(hash: string): string | null {
  const m = /^#(?:.*&)?setup=([^&]*)/.exec(hash);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).trim() || null; } catch { return null; }
}

function take() {
  const code = setupCodeFrom(window.location.hash);
  if (code === null) return;
  kept = code;
  try { sessionStorage.setItem(KEY, code); } catch { /* kept in memory for this page */ }
  history.replaceState(history.state, '', window.location.pathname + window.location.search);
  for (const l of listeners) l(code);
}

/**
 * From main.tsx, before the app draws: keeps the code the page was opened with and clears it from the
 * address. The link opened in a tab already showing Dispatch only changes the fragment, so that counts too.
 */
export function captureSetupCode() {
  take();
  window.addEventListener('hashchange', take);
}

/** Calls `cb` with each code that arrives while the page is open; returns the unsubscribe. */
export function onSetupCode(cb: (code: string) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The code this tab was given, or ''. */
export function givenSetupCode(): string {
  try { return sessionStorage.getItem(KEY) ?? kept; } catch { return kept; }
}

/** Once the account exists, the code is spent. */
export function forgetSetupCode() {
  kept = '';
  try { sessionStorage.removeItem(KEY); } catch { /* nothing kept */ }
}

/** Reset Dispatch: a fresh page for the fresh install, opened with its setup code as the installer's link is. */
export function reloadWithSetupCode(code: string) {
  history.replaceState(null, '', `${window.location.pathname}#setup=${encodeURIComponent(code)}`);
  window.location.reload();
}
