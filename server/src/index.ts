import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { env } from './env.js';
import { createApp } from './app.js';
import { attachVncRelay } from './vnc.js';
import { attachVoiceRelay } from './voice-relay.js';
import { initSpeech } from './speech.js';
import { initVoice } from './voice.js';
import { initRoutines } from './routines.js';
import { initProactive } from './proactive.js';
import { enqueue } from './agent/turns.js';
import { expireStaleApprovals } from './agent/approvals.js';
import { initEngines } from './engine.js';
import { initMemoryWatch } from './engine-memory.js';
import { initScreens } from './computer.js';
import { ensureOwner } from './bots.js';
import { initAuth } from './lib/auth.js';
import { importEnvironment } from './settings.js';
import { serveHttps } from './https.js';
import { initUpdates } from './updates.js';

/**
 * The server process: everything that starts something. Order matters:
 *  1. db.ts (imported by everything) opens the database and runs its migrations.
 *  2. Settings still in the environment are copied into the database (once), pending approvals from
 *     the last process are expired, and the owner exists (its first bot comes from the setup wizard).
 *  3. The HTTP app, the built web app and the WebSocket relays (viewer, voice) are served, over HTTPS
 *     too with HTTPS=1 (https.ts), once its certificate is ready.
 *  4. Routines and check-ins are scheduled, unless DISPATCH_NO_SCHEDULER=1.
 *  5. Gateways, screens and the speech catalog are brought back in the background, and stale
 *     voice calls are swept every 10 minutes.
 *  6. Every bot's memory files are watched, so an open Memories tab shows what the bot saves.
 *  7. On a machine the installer set up, GitHub is checked for a newer Dispatch now and then (updates.ts).
 */

// Keys and addresses that used to be read from .env, now set in Settings > Providers.
importEnvironment();

// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();

// The one user who signs in.
initAuth(ensureOwner());

const app = createApp();

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const servePlain = () => serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => console.log(`[dispatch] server on http://${env.host ?? 'localhost'}:${info.port}`)) as unknown as Server;
let server: Server;
if (env.https) {
  // Without a certificate Dispatch still works, over plain HTTP and without voice calls.
  server = await serveHttps(app.fetch).catch((e: unknown) => {
    console.error('[https] could not make a certificate; serving plain HTTP:', e);
    return servePlain();
  });
} else server = servePlain();
attachVncRelay(server);
attachVoiceRelay(server);
// DISPATCH_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines don't fire twice.
if (process.env.DISPATCH_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  initProactive(enqueue);
} else console.log('[dispatch] scheduler disabled (DISPATCH_NO_SCHEDULER=1)');
// After a server restart the displays and gateways still run and are adopted; after a reboot (or in a
// new dev container) nothing runs yet: bring back what the bots had.
initEngines();
initScreens();
initSpeech();
initVoice();
initMemoryWatch();
initUpdates();
