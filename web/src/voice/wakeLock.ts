/**
 * Keeps the screen on while a call is open (call.ts). A phone that dims and locks mid-call suspends the
 * page, and with it the microphone and the call; only an app of its own could go on talking with the
 * screen off. The browser lets go of the lock whenever the page is hidden, so it is taken again when
 * the page comes back. Where there is no Wake Lock, or it is refused (low battery), the call goes on
 * and the screen sleeps as it would.
 */
let wanted = false;
let lock: WakeLockSentinel | null = null;
let taking = false;

async function take() {
  if (!wanted || lock || taking || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  taking = true;
  try {
    const l = await navigator.wakeLock.request('screen');
    if (!wanted) { void l.release().catch(() => {}); return; }
    lock = l;
    l.addEventListener('release', () => { if (lock === l) lock = null; });
  } catch { /* refused: the screen may sleep */ } finally {
    taking = false;
  }
}

const onVisibility = () => { void take(); };

export function keepScreenOn() {
  if (wanted) return;
  wanted = true;
  document.addEventListener('visibilitychange', onVisibility);
  void take();
}

export function letScreenSleep() {
  if (!wanted) return;
  wanted = false;
  document.removeEventListener('visibilitychange', onVisibility);
  const l = lock;
  lock = null;
  void l?.release().catch(() => {});
}
