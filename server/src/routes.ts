import { Hono } from 'hono';
import { z } from 'zod';
import { body } from './lib/validate.js';
import { streamSSE } from 'hono/streaming';
import { db, now, type RoutineRecord, type ScreenRecord } from './db.js';
import { hub } from './lib/hub.js';
import { requireUser, sessionUser, type AuthVars } from './lib/auth.js';
import { appendRow, clearConversation, currentRow, emitBot, getBot, getBotRow, getRow, ownBot, requireBot, listBots, getRoutine, listRoutines, listRows, updateRow } from './store.js';
import { clear, enqueue, interrupt } from './agent/turns.js';
import { answerApproval, ApprovalGone } from './agent/approvals.js';
import { allLive } from './agent/live.js';
import { computerState } from './computer.js';
import { displayNumber, libraryDir, LIBRARY_ROOT } from './machine.js';
import { displayRunning, screenshot } from './displays.js';
import { allowedActions, approvalSettings, endpointModels, forgetAllowed, syncApprovals, syncModel } from './engine.js';
import { saveProviderSettings } from './providers.js';
import { cleanSecret, cleanUrl, getSetting, SECRET_IDS, secretState, type SettingKey } from './settings.js';
import { deleteMemory, memoryBot } from './engine-memory.js';
import { createBot, deleteBot, finishSetup, moveBot, primaryBot, setupPending, showPersona, UserError, welcome } from './bots.js';
import { defaultWorkspace, nameInUse, ownWorkspace } from './workspaces.js';
import { applySchedule, runRoutine, unscheduleRoutine } from './routines.js';
import { copyToMembers, dispatchRoomMessage } from './agent/rooms.js';
import { filesNote } from './library.js';
import { voiceApi } from './voice.js';
import { eraseAndExit, takeDown } from './reset.js';
import { makeSetupCode } from './lib/auth.js';
import { runningCommit } from './updates.js';
import { searchLibraries, searchMessages } from './search.js';
import { mapSpeed, mapVoice, voiceCatalog } from './speech.js';
import { AVATAR_COLORS, AVATAR_SHAPES, EFFORTS, type ServerEvent } from './types.js';
import type { BotResponse, BotsResponse, ComputerResponse, Ok, PermissionsResponse, ResetResponse, ProvidersResponse, RoutineResponse, RoutinesResponse, RowResponse, RowsResponse, SearchResponse, SecretId, SecretState } from './contract.js';
import { errorText } from './lib/errors.js';

export const api = new Hono<AuthVars>();

// Sign-in is checked for every request in app.ts; this guards the router on its own too.
api.use('/*', requireUser);

// ---------- events (SSE) ----------

/** Events waiting for a stalled client before it is cut off; it reconnects and resyncs (web/src/lib/events.ts). */
const MAX_BACKLOG = 5000;

api.get('/events', (c) => {
  const user = c.get('user');
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => {
      if (queue.length >= MAX_BACKLOG) { stream.abort(); return; }
      queue.push(JSON.stringify(ev));
      wake?.();
    });
    stream.onAbort(() => wake?.());
    try {
      await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now(), version: runningCommit() } satisfies ServerEvent) });
      while (!stream.aborted) {
        if (!queue.length) {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([new Promise<void>((r) => (wake = r)), new Promise<void>((r) => { timer = setTimeout(r, 20_000); })]);
          clearTimeout(timer);
          wake = null;
        }
        // A session ended elsewhere (signed out, password changed, account reset) stops the stream before
        // its next event or ping; the browser's reconnect then gets a 401 and goes back to the sign-in screen.
        if (!sessionUser(c)) break;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' } satisfies ServerEvent) }); continue; }
        while (queue.length && !stream.aborted) await stream.writeSSE({ data: queue.shift()! });
      }
    } finally {
      unsub();
    }
  });
});

// ---------- search ----------

// One or two letters would match nearly everything; the search box matches bot names itself until then.
const MIN_SEARCH = 2;

api.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  if (q.length < MIN_SEARCH) return c.json({ messages: [], files: [] } satisfies SearchResponse);
  const user = c.get('user');
  const files = await searchLibraries(user.id, q, LIBRARY_ROOT);
  return c.json({ messages: searchMessages(user.id, q), files } satisfies SearchResponse);
});

// ---------- bots ----------

api.get('/bots', (c) => c.json({ bots: listBots(c.get('user').id), live: allLive(c.get('user').id) } satisfies BotsResponse));

// What the create-bot form and the setup wizard send. Unknown shapes and colours fall back to a pick in
// createBot. Without a workspace the bot goes in the user's first one.
const NewBot = z.object({
  name: z.string(), avatarShape: z.string().optional(), avatarColor: z.string().optional(),
  label: z.string().optional(), description: z.string().optional(), instructions: z.string().optional(),
  workspaceId: z.string().optional(),
});

api.post('/bots', async (c) => {
  const { workspaceId, ...p } = await body(c, NewBot);
  const user = c.get('user');
  const ws = workspaceId ? ownWorkspace(user.id, workspaceId) : defaultWorkspace(user.id);
  if (!ws) return c.json({ error: 'not found' }, 404);
  try {
    const bot = createBot(user.id, p, ws.id);
    // A new bot says hello and asks what it should help with, as its first turn. The setup wizard's
    // bot waits for the end of setup, when it has a model to answer with.
    if (bot.kind !== 'room' && !setupPending(user.id)) welcome(requireBot(bot.id), user.username);
    return c.json({ bot } satisfies BotResponse);
  } catch (e) {
    if (e instanceof UserError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

/** The setup wizard's last step (bots.ts finishSetup). `greet`: the first bot has a model, so it says hello now. */
api.post('/setup/finish', async (c) => {
  const { greet } = await body(c, z.object({ greet: z.boolean() }));
  const user = c.get('user');
  if (!primaryBot(defaultWorkspace(user.id).id)) return c.json({ error: 'Make your first bot before finishing setup.' }, 409);
  finishSetup(user, greet);
  return c.json({ ok: true } satisfies Ok);
});

/**
 * Settings > General > Reset Dispatch (reset.ts). The reply comes once every bot is down; then the data is
 * erased and the server restarts empty, so the web app waits for an answer that asks for a new account,
 * and makes it with the setup code in this reply.
 */
api.post('/reset', async (c) => {
  await body(c, z.object({ confirm: z.literal('reset') }));
  await takeDown();
  const setupCode = makeSetupCode();
  setTimeout(() => eraseAndExit(setupCode).catch((e) => { console.error('[reset] erasing failed:', e); process.exit(1); }), 300);
  return c.json({ ok: true, setupCode } satisfies ResetResponse);
});

/** What a bot's settings, look, voice and rail menu may change, and the column each one is. */
const BotPatch = z.object({
  name: z.string().optional(), label: z.string().optional(), description: z.string().optional(), instructions: z.string().optional(),
  avatarShape: z.enum(AVATAR_SHAPES).optional(), avatarColor: z.enum(AVATAR_COLORS).optional(),
  effort: z.enum(EFFORTS).optional(),
  sidebarHidden: z.boolean().optional(),
  voice: z.string().optional(), voiceSpeed: z.number().optional(),
});
const BOT_COLUMNS = {
  name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color',
  effort: 'effort', sidebarHidden: 'sidebar_hidden', voice: 'voice', voiceSpeed: 'voice_speed',
} satisfies Record<keyof z.infer<typeof BotPatch>, string>;

api.patch('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await body(c, BotPatch);
  // Voices the speech service doesn't have become its default; speeds are clamped to its range.
  if (p.voice !== undefined || p.voiceSpeed !== undefined) {
    const catalog = await voiceCatalog().catch(() => null);
    if (p.voice !== undefined) p.voice = mapVoice(p.voice, catalog);
    if (p.voiceSpeed !== undefined) p.voiceSpeed = mapSpeed(p.voiceSpeed, catalog);
  }
  // Checked after the wait above, so two renames at once can't both take a free name.
  if (p.name !== undefined) {
    const taken = nameInUse(b.workspace_id, p.name, b.id);
    if (taken) return c.json({ error: taken }, 409);
  }
  for (const [k, col] of Object.entries(BOT_COLUMNS) as [keyof typeof BOT_COLUMNS, string][]) {
    const v = p[k];
    if (v !== undefined) db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(typeof v === 'boolean' ? (v ? 1 : 0) : v, now(), b.id);
  }
  if (p.effort !== undefined) syncModel(b.id);
  showPersona(b, {
    persona: p.name !== undefined || p.label !== undefined || p.description !== undefined,
    looks: p.name !== undefined || p.label !== undefined || p.avatarShape !== undefined || p.avatarColor !== undefined,
  });
  emitBot(b.id);
  return c.json({ bot: getBot(b.id)! } satisfies BotResponse);
});

api.delete('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  await deleteBot(b);
  return c.json({ ok: true } satisfies Ok);
});

api.post('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (b.kind === 'room') return c.json({ error: 'A group chat can’t be the primary bot.' }, 400);
  // One primary bot per workspace.
  db.prepare('UPDATE bots SET is_primary = (id = ?) WHERE workspace_id=?').run(b.id, b.workspace_id);
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true } satisfies Ok);
});

/** Move a bot to another of the user's workspaces (bots.ts moveBot). */
api.post('/bots/:id/move', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { workspaceId } = await body(c, z.object({ workspaceId: z.string() }));
  const to = ownWorkspace(user.id, workspaceId);
  if (!to) return c.json({ error: 'not found' }, 404);
  try {
    moveBot(b, to);
  } catch (e) {
    if (e instanceof UserError) return c.json({ error: e.message }, 409);
    throw e;
  }
  return c.json({ bot: getBot(b.id)! } satisfies BotResponse);
});

api.post('/bots/:id/unread', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=MAX(unread,1) WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true } satisfies Ok);
});

api.post('/bots/:id/read', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=0 WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true } satisfies Ok);
});

// ---------- conversation ----------

api.get('/bots/:id/rows', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
  return c.json({ generation: b.generation, rows: listRows(b.id, { beforeSeq, limit: Number(c.req.query('limit') ?? 200) }) } satisfies RowsResponse);
});

const NewMessage = z.object({
  text: z.string().default(''),
  attachments: z.array(z.object({ name: z.coerce.string(), path: z.string(), size: z.coerce.number().catch(0), type: z.coerce.string().default('') })).default([]),
});

api.post('/bots/:id/messages', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { text: rawText, attachments: rawFiles } = await body(c, NewMessage);
  const text = rawText.trim();
  // Only files that were uploaded to this bot's Library.
  const attachments = rawFiles
    .filter((a) => /^uploads\/[^/]+$/.test(a.path) && !a.path.includes('..'))
    .slice(0, 20)
    .map((a) => ({ name: a.name.slice(0, 200), path: a.path, size: a.size, type: a.type.slice(0, 100) }));
  if (!text && !attachments.length) return c.json({ error: 'empty' }, 400);
  // Group chats dispatch to their member Bots instead of running their own loop. Each member gets
  // its own copy of the files first, so it can be told where they are.
  if (b.kind === 'room') {
    const copies = await copyToMembers(b.id, attachments);
    if (!getBotRow(b.id)) return c.json({ error: 'not found' }, 404);
    const row = appendRow(b.id, 'message', { type: 'message', role: 'user', text, ...(attachments.length ? { attachments } : {}) });
    dispatchRoomMessage(b.id, text, enqueue, copies);
    return c.json({ row } satisfies RowResponse);
  }
  const row = appendRow(b.id, 'message', { type: 'message', role: 'user', text, ...(attachments.length ? { attachments } : {}) });
  // The bot reads where the files are; they are on its own computer.
  const files = filesNote(attachments.map((a) => ({ file: `${libraryDir(b.id)}/${a.path}`, type: a.type, size: a.size })));
  enqueue(b.id, { type: 'user', text: `${text || 'Here are some files.'}${files}` });
  return c.json({ row } satisfies RowResponse);
});

api.post('/bots/:id/interrupt', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  return c.json({ ok: true } satisfies Ok);
});

api.post('/bots/:id/fresh', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  // Whatever the bot was doing or had queued belonged to the old chat.
  clear(b.id);
  clearConversation(b.id);
  emitBot(b.id);
  return c.json({ ok: true } satisfies Ok);
});

// An approval card's answer goes to the Hermes run waiting for it (agent/approvals.ts).
api.post('/approvals/:id', async (c) => {
  const { choice } = await body(c, z.object({ choice: z.enum(['once', 'always', 'deny']) }));
  try {
    await answerApproval(c.get('user').id, c.req.param('id'), choice);
  } catch (e) {
    if (e instanceof ApprovalGone) return c.json({ error: e.message }, 409);
    return c.json({ error: 'not found' }, 404);
  }
  return c.json({ ok: true } satisfies Ok);
});

api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { answer, generation } = await body(c, z.object({ answer: z.string(), generation: z.number().int().optional() }));
  // Read the card after the last await: from here to the write nothing else runs, so two answers sent
  // at once can't both find it pending. A question is answered once (pending → answered), and only
  // in the chat it was asked in (a tab still showing a cleared chat sends that chat's generation).
  const current = getBotRow(b.id)?.generation;
  if (generation !== undefined && generation !== current) return c.json({ error: 'That chat was cleared.' }, 409);
  const row = currentRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  if (row.body.status !== 'pending') return c.json({ error: 'already answered' }, 409);
  updateRow(row, { ...row.body, status: 'answered', answer });
  appendRow(b.id, 'message', { type: 'message', role: 'user', text: answer });
  enqueue(b.id, { type: 'user', text: `[Answer to "${row.body.question}"] ${answer}` });
  return c.json({ ok: true } satisfies Ok);
});

// A reaction on a message. null clears it.
api.patch('/bots/:id/rows/:seq', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await body(c, z.object({ reaction: z.string().max(16).nullable().optional(), generation: z.number().int().optional() }));
  // After the last await, so a row rewritten meanwhile (a call's summary) is not overwritten with an
  // older copy; by its generation when the client says, so a seq reused by a newer chat is not hit.
  const seq = Number(c.req.param('seq'));
  const row = p.generation !== undefined ? getRow({ botId: b.id, generation: p.generation, seq }) : currentRow(b.id, seq);
  if (!row) return c.json({ error: 'not found' }, 404);
  const next = { ...row.body };
  if (p.reaction !== undefined && next.type === 'message') {
    if (p.reaction === null) delete next.reaction;
    else next.reaction = p.reaction;
  }
  updateRow(row, next);
  return c.json({ ok: true } satisfies Ok);
});

// ---------- routines / memories ----------

const ownRoutine = (userId: string, id: string) =>
  db.prepare<[string, string], RoutineRecord>('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(id, userId);

api.get('/bots/:id/routines', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ routines: listRoutines(b.id) } satisfies RoutinesResponse) : c.json({ error: 'not found' }, 404);
});

api.patch('/routines/:id', async (c) => {
  const r = ownRoutine(c.get('user').id, c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  const { enabled } = await body(c, z.object({ enabled: z.boolean() }));
  db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, r.id);
  const next = getRoutine(r.id)!;
  applySchedule(next);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next } satisfies RoutineResponse);
});

api.post('/routines/:id/run', (c) => {
  const r = ownRoutine(c.get('user').id, c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  switch (runRoutine(r.id)) {
    case 'queued': return c.json({ ok: true } satisfies Ok);
    case 'busy': return c.json({ error: 'It’s already running.' }, 409);
    case 'off': return c.json({ error: 'Routines are turned off on this server.' }, 409);
  }
});

api.delete('/routines/:id', async (c) => {
  const r = ownRoutine(c.get('user').id, c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  unscheduleRoutine(r.id);
  db.prepare('DELETE FROM routines WHERE id=?').run(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ ok: true } satisfies Ok);
});

api.delete('/memories/:id', async (c) => {
  const botId = memoryBot(c.req.param('id'));
  if (!botId || !ownBot(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  try {
    if (!(await deleteMemory(c.req.param('id')))) return c.json({ error: 'That memory was already changed or removed. Here’s the latest.' }, 409);
  } catch (e) {
    console.warn('[memory] remove failed', botId, (e as Error).message);
    return c.json({ error: 'The bot is busy with its memory. Try again in a moment.' }, 503);
  }
  return c.json({ ok: true } satisfies Ok);
});

// ---------- computer ----------

api.get('/computer', (c) => c.json({ computer: computerState(c.get('user').id) } satisfies ComputerResponse));

/** What the bot's screen shows now, as a JPEG. 204 while the bot has no screen running. */
api.get('/bots/:id/screenshot', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const scr = db.prepare<[string], Pick<ScreenRecord, 'screen_id'>>('SELECT screen_id FROM screens WHERE bot_id=?').get(b.id);
  const n = scr ? displayNumber(scr.screen_id) : 0;
  if (!scr || !n || !(await displayRunning(n))) return c.body(null, 204);
  try {
    const jpeg = await screenshot(n);
    return c.body(new Uint8Array(jpeg), 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
  } catch (e) {
    console.warn(`[computer] screenshot of ${scr.screen_id} failed: ${errorText(e)}`);
    return c.body(null, 204);
  }
});

// ---------- permissions (Hermes' approvals, for every bot; engine.ts writes them into each config) ----------

const permissions = (userId: string): PermissionsResponse => ({ ...approvalSettings(userId), allowed: allowedActions(userId) });

api.get('/permissions', (c) => c.json(permissions(c.get('user').id) satisfies PermissionsResponse));

api.put('/permissions', async (c) => {
  const userId = c.get('user').id;
  const b = await body(c, z.object({
    mode: z.enum(['off', 'smart', 'manual']).optional(),
    deny: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
  }));
  if (b.mode) db.prepare('UPDATE users SET approval_mode=? WHERE id=?').run(b.mode, userId);
  if (b.deny) db.prepare('UPDATE users SET approval_deny=? WHERE id=?').run(JSON.stringify([...new Set(b.deny)]), userId);
  syncApprovals(userId);
  return c.json(permissions(userId) satisfies PermissionsResponse);
});

api.delete('/permissions/allowed/:entry', (c) => {
  const userId = c.get('user').id;
  forgetAllowed(userId, c.req.param('entry'));
  return c.json(permissions(userId) satisfies PermissionsResponse);
});

// ---------- providers (Settings > Providers, for every bot: keys, tokens, the self-hosted endpoint, SearXNG) ----------

async function providers(): Promise<ProvidersResponse> {
  const url = getSetting('self-hosted-url');
  return {
    secrets: Object.fromEntries(SECRET_IDS.map((id) => [id, secretState(id)])) as Record<SecretId, SecretState>,
    selfHosted: { url, ...(url ? await endpointModels('self-hosted') : { models: [], error: null }) },
    searxngUrl: getSetting('searxng-url'),
  };
}

api.get('/providers', async (c) => c.json((await providers()) satisfies ProvidersResponse));

/** Each value given is set; '' removes it. Every gateway restarts on the result before its next run, idle ones now. */
api.put('/providers', async (c) => {
  const b = await body(c, z.object({
    secrets: z.partialRecord(z.enum(SECRET_IDS as [SecretId, ...SecretId[]]), z.string().max(2000)).optional(),
    selfHostedUrl: z.string().max(2000).optional(),
    searxngUrl: z.string().max(2000).optional(),
  }));
  const patch: Partial<Record<SettingKey, string>> = {};
  for (const [id, raw] of Object.entries(b.secrets ?? {}) as [SecretId, string][]) {
    const v = raw.trim() ? cleanSecret(raw) : '';
    if (v === null) return c.json({ error: 'A key is one line of letters, numbers and symbols, with no spaces.' }, 400);
    patch[id] = v;
  }
  for (const [key, raw] of [['self-hosted-url', b.selfHostedUrl], ['searxng-url', b.searxngUrl]] as const) {
    if (raw === undefined) continue;
    const v = raw.trim() ? cleanUrl(raw) : '';
    if (v === null) return c.json({ error: 'Enter an address that starts with http:// or https://.' }, 400);
    patch[key] = v;
  }
  saveProviderSettings(patch);
  return c.json((await providers()) satisfies ProvidersResponse);
});

api.route('/voice', voiceApi);
