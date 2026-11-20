import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { body } from './lib/validate.js';
import { changePassword, createAccount, hasAccount, MIN_PASSWORD, requireUser, sessionUser, signIn, signOut, type AccountResult, type AuthVars } from './lib/auth.js';
import { syncPersonas } from './engine.js';
import { setupPending } from './bots.js';
import type { User } from './types.js';
import type { MeResponse, Ok } from './contract.js';

/**
 * The account and signing in and out. app.ts lets /me, /setup, /login and /logout through without a
 * session, since they are how a browser gets one; /password needs one like everything else.
 */
export const authApi = new Hono<AuthVars>();

const UserName = z.string().trim().min(1, 'Choose a user name').max(64, 'Keep the user name under 64 characters').regex(/^[^\s:]+$/, 'Use a user name without spaces or colons');
const NewPassword = z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters`).max(1000);

/** The answer for each way a password step can be refused. */
function refused(c: Context, r: Exclude<AccountResult, { user: unknown }>) {
  switch (r.error) {
    case 'locked': {
      const minutes = Math.max(1, Math.ceil(r.retryAfterMs / 60_000));
      return c.json({ error: `Too many tries. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` }, 429, { 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) });
    }
    case 'wrong': return c.json({ error: c.req.path.endsWith('/password') ? 'That isn’t your current password.' : 'Wrong user name or password.' }, 401);
    case 'exists': return c.json({ error: 'An account already exists. Sign in instead.' }, 409);
    case 'no-account': return c.json({ error: 'There is no account yet. Create one first.' }, 409);
    case 'changed': return c.json({ error: 'Your password was changed somewhere else. Try again.' }, 409);
    default: { const x: never = r; return x; }
  }
}

/** What the web app needs to know about a signed-in user to show the app or the setup wizard. */
const signedIn = (user: User): MeResponse => ({ user, needsAccount: false, needsSetup: setupPending(user.id) });

// Open: the web app asks this first, to show the app, the setup wizard, the sign-in form or the first-run form.
authApi.get('/me', (c) => {
  const user = sessionUser(c);
  return c.json((user ? signedIn(user) : { user: null, needsAccount: !hasAccount(), needsSetup: false }) satisfies MeResponse);
});

authApi.post('/setup', async (c) => {
  const { username, password } = await body(c, z.object({ username: UserName, password: NewPassword }));
  const r = await createAccount(c, username, password);
  if (!('user' in r)) return refused(c, r);
  // The bots' personas name the person they work for.
  syncPersonas(r.user.id);
  return c.json(signedIn(r.user) satisfies MeResponse);
});

authApi.post('/login', async (c) => {
  const { username, password } = await body(c, z.object({ username: z.string().trim().max(200), password: z.string().max(1000) }));
  const r = await signIn(c, username, password);
  return 'user' in r ? c.json(signedIn(r.user) satisfies MeResponse) : refused(c, r);
});

authApi.post('/logout', (c) => {
  signOut(c);
  return c.json({ ok: true } satisfies Ok);
});

authApi.post('/password', requireUser, async (c) => {
  const { current, next } = await body(c, z.object({ current: z.string().max(1000), next: NewPassword }));
  const r = await changePassword(c, current, next);
  return 'user' in r ? c.json({ ok: true } satisfies Ok) : refused(c, r);
});
