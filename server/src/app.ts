import { Hono } from 'hono';
import { api } from './routes.js';
import { workspacesApi } from './routes-workspaces.js';
import { roomsApi } from './routes-rooms.js';
import { tasksApi } from './routes-tasks.js';
import { configApi, httpsApi } from './routes-config.js';
import { mcpApi } from './mcp.js';
import { authApi } from './routes-auth.js';
import { crossSite, requireUser, type AuthVars } from './lib/auth.js';
import { db } from './db.js';
import { errorText } from './lib/errors.js';
import { runningCommit } from './updates.js';
import type { ApiError, Health } from './contract.js';

/**
 * What needs no session: the web app's files, the health check, creating the account and signing in
 * and out, and the HTTPS certificate's authority, which a device installs before it signs in.
 */
const OPEN_API = new Set(['/api/health', '/api/auth/me', '/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/https/certificate']);
const isApi = (path: string) => path === '/api' || path.startsWith('/api/');
const isOpen = (path: string) => !isApi(path) || OPEN_API.has(path);

/** A read of a real table, which a database that is missing, locked or not migrated fails. */
const healthRead = db.prepare('SELECT COUNT(*) AS n FROM users');

/** Methods that only read. Every other one changes something, so it must come from the app's own pages. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Headers on every answer. The policy lets the app run only its own scripts, so a file a bot made
 * (an SVG or HTML page) that somehow opens at the app's address runs none of its own. Its exceptions
 * are what the app needs: a blob: script for the voice call's audio worklet, WebAssembly for its echo
 * canceller (kept in a data: URL), pictures from anywhere for Markdown, and sockets for the screen
 * and calls. Only the app may frame its pages (the PDF preview frames a Library file). No referrer,
 * so a picture in a bot's message doesn't tell its host the app's address.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: ws: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * The HTTP app: every route, behind sign-in. Building it starts nothing (no displays, gateways or
 * timers), so tests can call `createApp().request(...)`. index.ts serves it and starts the rest.
 */
export function createApp() {
  const app = new Hono<AuthVars>();
  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  });
  // A change to anything, signed in or not (a sign-in too), only from the app's own pages: see crossSite.
  app.use('*', (c, next) => {
    if (!READS.has(c.req.method) && isApi(c.req.path) && crossSite((name) => c.req.header(name))) {
      return Promise.resolve(c.json({ error: 'This request came from another site, so Dispatch refused it.' }, 403));
    }
    return next();
  });
  // Sign-in guards the whole API except the health check and the account routes that come before a
  // session. The built web app is open, since it holds no data and draws the sign-in screen; the
  // agents' MCP endpoint has per-bot bearer tokens of its own.
  app.use('*', (c, next) => (isOpen(c.req.path) ? next() : requireUser(c, next)));
  // release.sh switches back to the release before when this doesn't name the new release within
  // a minute, so it answers only once the database can be read, and says which release it is.
  app.get('/api/health', (c) => {
    try {
      healthRead.get();
    } catch (e) {
      return c.json({ error: `The database can't be read: ${errorText(e)}` } satisfies ApiError, 503);
    }
    return c.json({ ok: true, commit: runningCommit() } satisfies Health);
  });
  app.route('/api/auth', authApi);
  app.route('/api/https', httpsApi);
  // The app's tools for the agent engines (MCP).
  app.route('/mcp', mcpApi);
  app.route('/api/workspaces', workspacesApi);
  app.route('/api/rooms', roomsApi);
  app.route('/api/tasks', tasksApi);
  app.route('/api', api);
  app.route('/api', configApi);
  return app;
}
