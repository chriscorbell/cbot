import { Hono } from 'hono';
import { z } from 'zod';
import { body } from './lib/validate.js';
import { requireUser, sessionToken, type AuthVars } from './lib/auth.js';
import { validKeys } from './lib/webpush.js';
import { addDevice, removeDevice, setLooking, testDevice, vapidKeys } from './notifications.js';
import { ownBot } from './store.js';
import type { NotificationTestResponse, NotificationsResponse, Ok } from './contract.js';

/**
 * /api/notifications: a device turning notifications on and off, a test notification, and each tab
 * saying which chat it shows (notifications.ts has the why of each).
 */
export const notificationsApi = new Hono<AuthVars>();
notificationsApi.use('*', requireUser);

/** A push service's address, as the browser's subscription gives it. Only HTTPS: the server posts to it. */
const Endpoint = z.url({ protocol: /^https$/ }).max(2048);
const Key = z.string().max(256);

notificationsApi.get('/', (c) => c.json({ publicKey: vapidKeys().publicKey } satisfies NotificationsResponse));

notificationsApi.put('/device', async (c) => {
  const p = await body(c, z.object({ endpoint: Endpoint, keys: z.object({ p256dh: Key, auth: Key }) }));
  if (!validKeys(p.keys.p256dh, p.keys.auth)) return c.json({ error: 'Bad request: the subscription has no usable keys' }, 400);
  const session = sessionToken(c);
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  addDevice(c.get('user').id, session, { endpoint: p.endpoint, ...p.keys });
  return c.json({ ok: true } satisfies Ok);
});

notificationsApi.delete('/device', async (c) => {
  const p = await body(c, z.object({ endpoint: z.string().max(2048) }));
  removeDevice(c.get('user').id, p.endpoint);
  return c.json({ ok: true } satisfies Ok);
});

notificationsApi.post('/test', async (c) => {
  const p = await body(c, z.object({ endpoint: z.string().max(2048) }));
  const error = await testDevice(c.get('user').id, p.endpoint);
  return c.json({ ok: !error, error } satisfies NotificationTestResponse);
});

notificationsApi.put('/presence', async (c) => {
  const p = await body(c, z.object({ tab: z.string().min(1).max(64), botId: z.string().max(64).nullable() }));
  const user = c.get('user');
  if (p.botId && !ownBot(user.id, p.botId)) return c.json({ error: 'not found' }, 404);
  setLooking(user.id, p.tab, p.botId);
  return c.json({ ok: true } satisfies Ok);
});
