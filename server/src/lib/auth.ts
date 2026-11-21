import type { Context, MiddlewareHandler } from 'hono';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { HttpBindings } from '@hono/node-server';
import { TLSSocket } from 'node:tls';
import type { IncomingMessage } from 'node:http';
import { db, now, type UserRecord } from '../db.js';
import { token } from './ids.js';
import type { User } from '../types.js';

/**
 * The one account, kept on the owner's row in `users`: a user name and a scrypt hash of the password.
 * A fresh install has none; the web app then asks the first visitor to create it (/api/auth/setup),
 * and only while none exists. Signing in (/api/auth/login) gives the browser a session cookie, which
 * is all any request carries after that, WebSocket upgrades included.
 */

const COOKIE = 'dispatch_session';
const TTL_MS = 30 * 24 * 3600 * 1000;
export const MIN_PASSWORD = 8;

export type AuthVars = { Variables: { user: User } };

export const toUser = (r: UserRecord): User => ({ id: r.id, username: r.username ?? '', avatarUrl: r.avatar_url });

/** The owner's id (see ensureOwner in bots.ts). Its row is read fresh each time, so a reset from the command line takes effect at once. */
let ownerId: string | null = null;
const ownerRow = () => (ownerId ? db.prepare<[string], UserRecord>('SELECT * FROM users WHERE id=?').get(ownerId) ?? null : null);

/** Whether the account exists yet. */
export const hasAccount = () => !!ownerRow()?.password_hash;

export function initAuth(u: User) {
  ownerId = u.id;
  // Every sign-in starts a session, so expired ones pile up; drop them on start.
  db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now());
  // Sessions from before there was an account (the old environment credentials) must not outlive it.
  if (!hasAccount()) db.prepare('DELETE FROM auth_sessions').run();
  if (process.env.DISPATCH_USER || process.env.DISPATCH_PASSWORD) console.warn('[auth] DISPATCH_USER and DISPATCH_PASSWORD are no longer read: the account is created in the app on the first visit');
}

// ---------- passwords ----------

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

/** "scrypt:N:r:p:salt:hash", salt and hash in base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join(':');
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [kind, N, r, p, salt, hash] = stored.split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(got, want);
}

/** Constant-time comparison; hashing first keeps the time the same whatever the lengths. */
function sameText(given: string, want: string) {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- wrong passwords ----------

/**
 * Wrong passwords, per client address: the tenth within a quarter of an hour shuts that address out
 * until the oldest ages out, right password or not, so guessing stays slow. Signing in and changing
 * the password count together. Behind a proxy every request shares one address; that is acceptable
 * for one user.
 */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map<string, number[]>();

function recentFailures(from: string): number[] {
  const t = now();
  const list = (failures.get(from) ?? []).filter((at) => t - at < FAIL_WINDOW_MS);
  if (list.length) failures.set(from, list); else failures.delete(from);
  return list;
}

/** Milliseconds until `from` may try a password again; 0 when it may now. */
export function lockedFor(from: string): number {
  const list = recentFailures(from);
  return list.length >= MAX_FAILURES ? list[0] + FAIL_WINDOW_MS - now() : 0;
}

const countFailure = (from: string) => failures.set(from, [...recentFailures(from), now()]);

/** Where a request comes from, for counting failures. Tests' requests have no socket. */
export function clientAddress(c: Context): string {
  try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
}

// ---------- sessions ----------

/** A new session for `userId`; returns its token. */
export function startSession(userId: string): string {
  const t = token();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(t, userId, now(), now() + TTL_MS);
  return t;
}

/**
 * Whether the browser reached Dispatch over HTTPS: on Dispatch's own certificate (https.ts), or through a
 * proxy that says so, as Tailscale Serve does. A cookie set over HTTPS is marked Secure, so the browser
 * never sends it over plain HTTP, where anyone on the network could read it (a typed http:// address
 * is redirected to HTTPS, but only after the browser has sent that first request).
 */
export function overHttps(c: Context): boolean {
  const incoming = (c.env as Partial<HttpBindings> | undefined)?.incoming;
  return incoming?.socket instanceof TLSSocket || c.req.header('x-forwarded-proto') === 'https';
}

function setSessionCookie(c: Context, userId: string) {
  setCookie(c, COOKIE, startSession(userId), { httpOnly: true, sameSite: 'Lax', secure: overHttps(c), path: '/', maxAge: TTL_MS / 1000 });
}

/**
 * Whether a browser sent this request from another site's page. The session cookie is SameSite=Lax,
 * which keeps it off requests from other sites, but not off pages of the same site: another port of
 * the same address counts, such as something a bot serves. And the API reads a JSON body whatever
 * its Content-Type, so a form or a no-cors fetch could post as the user. Browsers say where a request
 * comes from in Sec-Fetch-Site; one too old to send it sends Origin, which must then name this host.
 * A request with neither doesn't come from a web page (curl, the bots' Hermes), and the session
 * cookie or the MCP token decides about it as before.
 */
export function crossSite(header: (name: string) => string | undefined): boolean {
  const site = header('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = header('origin');
  if (!origin) return false;
  let from: string;
  try { from = new URL(origin).host; } catch { return true; }
  return from !== header('host') && from !== header('x-forwarded-host');
}

/** One header of a raw request (the WebSocket upgrades in vnc.ts and voice-relay.ts), the first if it came more than once. */
export function headerOf(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function userFromToken(t: string | undefined): User | null {
  if (!t) return null;
  const r = db
    .prepare<[string, number], UserRecord>('SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?')
    .get(t, now());
  return r ? toUser(r) : null;
}

/** Who a request comes from, by its session cookie. The WebSocket relays (vnc.ts, voice-relay.ts) call this with the raw header. */
export function authenticate(cookieHeader: string | undefined): User | null {
  const m = cookieHeader?.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`));
  return userFromToken(m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : undefined);
}

/** The signed-in user of a request, or null. */
export const sessionUser = (c: Context) => authenticate(c.req.header('cookie'));

export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  // app.ts checks every request; routers that use this too find the user already set.
  if (c.get('user')) return next();
  const user = sessionUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', user);
  await next();
};

// ---------- the account ----------

export type AccountResult =
  | { user: User }
  | { error: 'exists' | 'no-account' | 'wrong' | 'changed' }
  | { error: 'locked'; retryAfterMs: number };

/** The first visit: creates the account and signs this browser in. Refused once an account exists. */
export async function createAccount(c: Context, username: string, password: string): Promise<AccountResult> {
  const hash = await hashPassword(password);
  // Checked after the last await, so two first visits at once can't both create it.
  const owner = ownerRow();
  if (!owner) throw new Error('no owner row');
  if (owner.password_hash) return { error: 'exists' };
  db.prepare('UPDATE users SET username=?, password_hash=? WHERE id=?').run(username, hash, owner.id);
  db.prepare('DELETE FROM auth_sessions').run();
  setSessionCookie(c, owner.id);
  return { user: toUser(ownerRow()!) };
}

/** The sign-in form: the right user name and password start a session (the cookie rides on `c`). */
export async function signIn(c: Context, username: string, password: string): Promise<AccountResult> {
  const from = clientAddress(c);
  const wait = lockedFor(from);
  if (wait > 0) return { error: 'locked', retryAfterMs: wait };
  const owner = ownerRow();
  if (!owner?.password_hash || !owner.username) return { error: 'no-account' };
  // The password is always checked, so a wrong user name takes as long as a wrong password.
  const passOk = await passwordMatches(password, owner.password_hash);
  if (!(sameText(username, owner.username) && passOk)) {
    countFailure(from);
    const after = lockedFor(from);
    return after > 0 ? { error: 'locked', retryAfterMs: after } : { error: 'wrong' };
  }
  setSessionCookie(c, owner.id);
  return { user: toUser(owner) };
}

/** A new password for the signed-in owner. Every other session ends; this browser stays signed in. */
export async function changePassword(c: Context, current: string, next: string): Promise<AccountResult> {
  const from = clientAddress(c);
  const wait = lockedFor(from);
  if (wait > 0) return { error: 'locked', retryAfterMs: wait };
  const owner = ownerRow();
  if (!owner?.password_hash) return { error: 'no-account' };
  const before = owner.password_hash;
  if (!(await passwordMatches(current, before))) {
    countFailure(from);
    const after = lockedFor(from);
    return after > 0 ? { error: 'locked', retryAfterMs: after } : { error: 'wrong' };
  }
  const hash = await hashPassword(next);
  // Only if nobody changed it while the hashes ran.
  const done = db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?').run(hash, owner.id, before).changes > 0;
  if (!done) return { error: 'changed' };
  const mine = getCookie(c, COOKIE) ?? '';
  db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token<>?').run(owner.id, mine);
  return { user: toUser(owner) };
}

/** Ends this browser's session, whether or not it is still live, and drops its cookie. */
export function signOut(c: Context) {
  const t = getCookie(c, COOKIE);
  if (t) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(t);
  deleteCookie(c, COOKIE, { path: '/' });
}

/** Forgets the account and ends every session; the next visit creates a new one. Bots and chats stay. */
export function resetAccount() {
  db.prepare('UPDATE users SET username=NULL, password_hash=NULL').run();
  db.prepare('DELETE FROM auth_sessions').run();
}
