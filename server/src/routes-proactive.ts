import { Hono } from 'hono';
import { z } from 'zod';
import { body as readBody } from './lib/validate.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { fireCheckin, getCheckins, setCheckins } from './proactive.js';
import type { CheckinSettings, Ok } from './contract.js';
import { errorText } from './lib/errors.js';

/** /api/checkins: proactive check-in settings for the primary bot. */
export const checkinsApi = new Hono<AuthVars>();
checkinsApi.use('*', requireUser);

checkinsApi.get('/', (c) => c.json(getCheckins(c.get('user').id) satisfies CheckinSettings));

checkinsApi.put('/', async (c) => {
  const body = await readBody(c, z.object({ enabled: z.boolean().optional(), times: z.array(z.string()).optional(), timezone: z.string().optional() }));
  try {
    return c.json(setCheckins(c.get('user').id, body) satisfies CheckinSettings);
  } catch (e) {
    return c.json({ error: errorText(e) }, 400);
  }
});

/** Trigger a check-in now (for testing / "check in with me" button). */
checkinsApi.post('/now', (c) => {
  fireCheckin(c.get('user').id, true);
  return c.json({ ok: true } satisfies Ok);
});
