/// <reference lib="webworker" />
/**
 * The service worker, served as /sw.js (vite.config.ts builds it on its own). It does one job: show the
 * notifications the server sends by Web Push (server/src/notifications.ts) and open the chat a tap
 * asks for. It caches nothing and answers no requests, so the app always comes from the server as it
 * is. lib/notifications.ts registers it and subscribes. Its own tsconfig (tsconfig.sw.json) gives it
 * the worker's types instead of the page's.
 */
import type { PushNotice } from '@shared/types';

declare const self: ServiceWorkerGlobalScope;

// A new version takes over at once: it holds no state an open page depends on.
self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

/** The server's notice, or a plain one for a message that can't be read (every push must show something). */
function noticeOf(data: PushMessageData | null): PushNotice {
  try {
    const n = data?.json() as Partial<PushNotice> | undefined;
    if (n && typeof n.title === 'string' && typeof n.body === 'string') {
      return { botId: typeof n.botId === 'string' ? n.botId : null, title: n.title, body: n.body, unread: typeof n.unread === 'number' ? n.unread : 0 };
    }
  } catch { /* not JSON */ }
  return { botId: null, title: 'Dispatch', body: 'Something new is waiting for you.', unread: 0 };
}

self.addEventListener('push', (e) => {
  const n = noticeOf(e.data);
  e.waitUntil((async () => {
    // A bot's newest notification replaces its last one, and still sounds (renotify).
    const options: NotificationOptions & { renotify?: boolean } = {
      body: n.body,
      tag: n.botId ?? 'dispatch',
      renotify: true,
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      data: { botId: n.botId },
    };
    await self.registration.showNotification(n.title, options);
    // The home-screen icon's count, where the system has one. An approval doesn't count as unread, but waits all the same.
    try { await self.navigator.setAppBadge(Math.max(n.unread, 1)); } catch { /* no badge here */ }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const botId = (e.notification.data as { botId?: string | null } | null)?.botId ?? null;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (page) {
      // The page opens the chat (lib/notifications.ts); focusing may be refused, and the message still lands.
      try { await page.focus(); } catch { /* already in front, or not allowed */ }
      if (botId) page.postMessage({ type: 'open-bot', botId });
      return;
    }
    await self.clients.openWindow(botId ? `/?bot=${encodeURIComponent(botId)}` : '/');
  })());
});

// The push service replaced the subscription: subscribe again with the same key and tell the server,
// as the page would on its next start. The request carries the session cookie like the page's do.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const key = e.oldSubscription?.options.applicationServerKey;
    if (!key) return;
    const sub = e.newSubscription ?? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON();
    await fetch('/api/notifications/device', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
  })());
});
