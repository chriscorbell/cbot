import { Hono } from 'hono';
import { api } from './routes.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { configApi, httpsApi } from './routes-config.js';
import { mcpApi } from './mcp.js';
import { authApi } from './routes-auth.js';
import { requireUser, type AuthVars } from './lib/auth.js';

/**
 * What needs no session: the web app's files, the health check, creating the account and signing in
 * and out, and the HTTPS certificate's authority, which a device installs before it signs in.
 */
const OPEN_API = new Set(['/api/health', '/api/auth/me', '/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/https/certificate']);
const isOpen = (path: string) => !(path === '/api' || path.startsWith('/api/')) || OPEN_API.has(path);

/**
 * The HTTP app: every route, behind sign-in. Building it starts nothing (no displays, gateways or
 * timers), so tests can call `createApp().request(...)`. index.ts serves it and starts the rest.
 */
export function createApp() {
  const app = new Hono<AuthVars>();
  // Sign-in guards the whole API except the health check and the account routes that come before a
  // session. The built web app is open, since it holds no data and draws the sign-in screen; the
  // agents' MCP endpoint has per-bot bearer tokens of its own.
  app.use('*', (c, next) => (isOpen(c.req.path) ? next() : requireUser(c, next)));
  app.get('/api/health', (c) => c.json({ ok: true, engine: 'hermes' }));
  app.route('/api/auth', authApi);
  app.route('/api/https', httpsApi);
  // The app's tools for the agent engines (MCP).
  app.route('/mcp', mcpApi);
  app.route('/api/checkins', checkinsApi);
  app.route('/api/rooms', roomsApi);
  app.route('/api', api);
  app.route('/api', configApi);
  return app;
}
