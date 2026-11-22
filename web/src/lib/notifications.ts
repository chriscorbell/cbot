import { create } from 'zustand';
import { api } from './api';
import { takeLaunchBot } from './launch';
import { isAppleMobile } from './platform';
import { useStore } from '../store';

/**
 * Notifications on this device (server/src/notifications.ts has the server's side): the service worker
 * that shows them (sw.ts), the browser's push subscription, the app's badge, and telling the server
 * which chat this tab shows, so nothing is sent about a chat someone is reading on any device.
 *
 * Whether this device takes notifications is whether its browser holds a push subscription. The page
 * hands it to the server on every start, which ties it to the session this page is signed in with:
 * after signing out and in again, the device takes them again under the new session.
 */

/**
 * What Settings shows for this device:
 * - unsupported: the browser has no Web Push.
 * - install: an iPhone or iPad, which has it only in an app added to the Home Screen.
 * - insecure: the page came over plain HTTP, where browsers allow no service worker.
 * - untrusted: the service worker didn't load, most often because the browser was told to go past
 *   the certificate warning instead of trusting the certificate.
 * - blocked: notifications are blocked for Dispatch in the browser's settings.
 * - off, on: the switch.
 */
export type PushState = 'checking' | 'unsupported' | 'install' | 'insecure' | 'untrusted' | 'blocked' | 'off' | 'on';

export const usePush = create<{ state: PushState }>(() => ({ state: 'checking' }));
const setState = (state: PushState) => usePush.setState({ state });

/** This tab, to the server. Two tabs of one browser each say what they show. */
const TAB = typeof crypto !== 'undefined' && 'randomUUID' in crypto && window.isSecureContext ? crypto.randomUUID() : Math.random().toString(36).slice(2);
/** How often a tab says again that it shows a chat; the server forgets a tab after 45 s without a word. */
const REFRESH_MS = 20_000;

let registration: Promise<ServiceWorkerRegistration> | null = null;
/** The server's key, fetched ahead so turning notifications on needs no request before the browser asks. */
let publicKey: string | null = null;

const standalone = () => window.matchMedia('(display-mode: standalone)').matches;

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sameKey = (sub: PushSubscription, key: string) => {
  const have = sub.options.applicationServerKey;
  if (!have) return false;
  const a = new Uint8Array(have);
  const b = keyBytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

/** What the browser can do here, before asking it anything. */
function support(): PushState | null {
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isAppleMobile() && !standalone() ? 'install' : 'unsupported';
  // The development server serves src/sw.ts as a module under /src/, outside the scope the worker needs.
  if (import.meta.env.DEV) return 'unsupported';
  return null;
}

/** Hands the subscription to the server: on start, and after the key changed (a reset). */
async function sync(reg: ServiceWorkerRegistration) {
  let sub = await reg.pushManager.getSubscription();
  if (Notification.permission === 'denied') { setState('blocked'); return; }
  if (!sub || Notification.permission !== 'granted') { setState('off'); return; }
  const key = publicKey ?? (publicKey = (await api.notifications()).publicKey);
  if (!sameKey(sub, key)) {
    await sub.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  }
  await api.addDevice(sub.toJSON());
  setState('on');
}

/** Settings' switch, on. Asks the browser first thing in the tap: Safari asks only from one. */
export async function turnOn(): Promise<void> {
  const asked = Notification.requestPermission();
  const reg = await (registration ?? Promise.reject(new Error('Notifications can’t start in this browser.')));
  const permission = await asked;
  if (permission !== 'granted') { setState(permission === 'denied' ? 'blocked' : 'off'); return; }
  const key = publicKey ?? (publicKey = (await api.notifications()).publicKey);
  const old = await reg.pushManager.getSubscription();
  if (old && !sameKey(old, key)) await old.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await api.addDevice(sub.toJSON());
  setState('on');
}

/** Settings' switch, off: the server forgets the device, and the browser the subscription. */
export async function turnOff(): Promise<void> {
  const reg = await registration;
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.removeDevice(sub.endpoint);
    await sub.unsubscribe();
  }
  setState('off');
}

/** Settings' "Send a Test". Throws why it didn't go. */
export async function sendTest(): Promise<void> {
  const sub = await (await registration)?.pushManager.getSubscription();
  if (!sub) throw new Error('This device isn’t set up for notifications. Turn them off and on again.');
  const r = await api.testDevice(sub.endpoint);
  if (!r.ok) throw new Error(r.error ?? 'The test didn’t go.');
}

/** Opens a chat a notification asked for, once its bot is known. */
function openBot(id: string) {
  const st = useStore.getState();
  if (st.bots.some((b) => b.id === id)) { st.selectBot(id); return; }
  st.loadBots().then(() => { if (useStore.getState().bots.some((b) => b.id === id)) useStore.getState().selectBot(id); }).catch(console.error);
}

/** Notifications about a chat the user now has in front of them are old news. */
function clearShown(botId: string) {
  void registration?.then((r) => r.getNotifications({ tag: botId })).then((ns) => { for (const n of ns) n.close(); }).catch(() => {});
}

/** The chat this tab shows in front of the user: visible, focused, signed in and past setup. */
function looking(): string | null {
  const s = useStore.getState();
  return document.visibilityState === 'visible' && document.hasFocus() && s.user && !s.needsSetup ? s.selectedBotId : null;
}

/** The unread count on the app's icon, where the system shows one (an installed app). */
function badge(n: number) {
  if (!('setAppBadge' in navigator)) return;
  (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => { /* not allowed without notifications, on some systems */ });
}

/**
 * From the signed-in app (App.tsx): registers the service worker, hands the server this device's
 * subscription, opens the chat a notification asked for, and keeps the server told which chat this tab
 * shows. Returns what stops it.
 */
export function startNotifications(): () => void {
  const stops: (() => void)[] = [];
  const unsupported = support();
  if (unsupported) setState(unsupported);
  else {
    registration = navigator.serviceWorker.register('/sw.js', { scope: '/' });
    registration.then(sync).catch((e: unknown) => {
      console.warn('[notifications]', e);
      // A refused certificate fails the worker's script with a SecurityError; anything else is likely the network.
      setState(e instanceof DOMException && e.name === 'SecurityError' ? 'untrusted' : Notification.permission === 'denied' ? 'blocked' : 'off');
    });
    const onMessage = (e: MessageEvent<unknown>) => {
      const d = e.data as { type?: string; botId?: unknown } | null;
      if (d?.type === 'open-bot' && typeof d.botId === 'string') openBot(d.botId);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    stops.push(() => navigator.serviceWorker.removeEventListener('message', onMessage));
  }

  const launched = takeLaunchBot();
  if (launched) openBot(launched);

  // Which chat this tab shows: said when it changes, and again every REFRESH_MS while it does.
  let said: string | null | undefined;
  const report = (leaving = false) => {
    const now = leaving ? null : looking();
    if (now === said) return;
    said = now;
    if (now) clearShown(now);
    // A page going to the background (a phone locking, another app) may be frozen before an ordinary request leaves.
    api.presence(TAB, now, leaving || document.visibilityState === 'hidden').catch(() => { said = undefined; });
  };
  const refresh = setInterval(() => { if (said) { said = undefined; report(); } }, REFRESH_MS);
  const onChange = () => report();
  const onHide = () => report(true);
  document.addEventListener('visibilitychange', onChange);
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  window.addEventListener('pagehide', onHide);
  stops.push(() => {
    clearInterval(refresh);
    document.removeEventListener('visibilitychange', onChange);
    window.removeEventListener('focus', onChange);
    window.removeEventListener('blur', onChange);
    window.removeEventListener('pagehide', onHide);
  });

  let unread = -1;
  stops.push(useStore.subscribe((s) => {
    report();
    const n = s.bots.reduce((sum, b) => sum + b.unread, 0);
    if (n !== unread) { unread = n; badge(n); }
  }));
  report();

  return () => { for (const stop of stops) stop(); };
}
