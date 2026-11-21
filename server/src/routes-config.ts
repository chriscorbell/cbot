import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { body } from './lib/validate.js';
import { db, now, type ScreenRecord, type SkillRecord } from './db.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { emitBot, listRoutines, ownBot } from './store.js';
import { computerState, resetBotScreen } from './computer.js';
import { box } from './box.js';
import { engineHome, engineInfo, hasEngine, forgetEngineOptions, restartEngine, signInName, stopOwnScreen, syncModel } from './engine.js';
import { cancelSignIn, getSignIn, startSignIn } from './signin.js';
import { listMemories } from './engine-memory.js';
import { inlineType, type Attachment, type LibraryFile, type Skill } from './types.js';
import type { BotSettingsBundle, ComputerDetails, EngineResponse, HttpsResponse, LibraryListing, Ok, ProviderSignIn, SignInResponse, SkillResponse, UpdateResponse, UploadResponse, UrlResponse } from './contract.js';
import { mkdirOwned } from './account.js';
import { LIBRARY_ROOT } from './machine.js';
import { numbered, safeName, uploadsDir } from './library.js';
import { setRelayMode } from './vnc.js';
import { authorityPem } from './https.js';
import { checkForUpdate, startUpdate, updateState } from './updates.js';
import { TLSSocket } from 'node:tls';
import type { HttpBindings } from '@hono/node-server';
import { errorText } from './lib/errors.js';

/**
 * Bot settings, skills, library, computer controls and memory maintenance.
 * Mounted next to routes.ts in index.ts; every path here needs a signed-in user.
 */
export const configApi = new Hono<AuthVars>();

for (const p of ['/bots/*', '/skills/*', '/computer/*', '/providers/*', '/signins/*']) configApi.use(p, requireUser);

const toSkill = (s: SkillRecord): Skill => ({ id: s.id, botId: s.bot_id, name: s.name, description: s.description ?? '', body: s.body, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at });
const skillById = db.prepare<[string], SkillRecord>('SELECT * FROM skills WHERE id=?');
const listSkills = (botId: string) => db.prepare<[string], SkillRecord>('SELECT * FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(botId).map(toSkill);

// ---------- HTTPS (https.ts) ----------

/**
 * Dispatch's own HTTPS certificate. Mounted at /api/https in app.ts ahead of routes.ts, whose sign-in
 * check covers everything it is mounted under, because the certificate is open.
 */
export const httpsApi = new Hono<AuthVars>();

// Whether this page came over Dispatch's own certificate. Through Tailscale Serve it arrives as plain
// HTTP from this machine, with a certificate the browser already trusts.
httpsApi.get('/', (c) => {
  const incoming = (c.env as Partial<HttpBindings> | undefined)?.incoming;
  return c.json({ ownCertificate: !!authorityPem() && incoming?.socket instanceof TLSSocket } satisfies HttpsResponse);
});

// Open (app.ts): a device installs it before anyone signs in on it. It is a public certificate.
httpsApi.get('/certificate', (c) => {
  const pem = authorityPem();
  if (!pem) return c.json({ error: 'not found' }, 404);
  return c.body(new Uint8Array(pem), 200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="dispatch.crt"' });
});

// ---------- updates (updates.ts) ----------

configApi.get('/update', (c) => c.json({ update: updateState() } satisfies UpdateResponse));

configApi.post('/update/check', async (c) => c.json({ update: await checkForUpdate() } satisfies UpdateResponse));

// Runs the installer again; the server restarts on the new release when it's built.
configApi.post('/update', async (c) => {
  const refused = await startUpdate();
  if (refused) return c.json({ error: refused }, 409);
  return c.json({ update: updateState() } satisfies UpdateResponse);
});

// ---------- settings bundle ----------

configApi.get('/bots/:id/settings', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({
    memories: listMemories(b.id),
    skills: listSkills(b.id),
    routines: listRoutines(b.id),
  } satisfies BotSettingsBundle);
});

// ---------- skills ----------

const SkillInput = z.object({ name: z.string().optional(), description: z.string().optional(), body: z.string().optional() });

/**
 * Every skill goes into the bot's instructions on every turn and call (agent/prompt.ts), so the steps of
 * one and the size of them all are capped. A save over either cap is refused rather than cut short.
 */
const STEPS_MAX = 20_000;
const SKILLS_MAX = 50_000;
const count = (n: number) => n.toLocaleString('en-US');
const skillSize = (s: { name: string; description: string | null; body: string }) => s.name.length + (s.description ?? '').length + s.body.length;

function cleanSkill(p: z.infer<typeof SkillInput>, partial = false): { name?: string; description?: string; body?: string } | string {
  const out: { name?: string; description?: string; body?: string } = {};
  if (p.name !== undefined || !partial) {
    const name = String(p.name ?? '').trim();
    if (!name) return 'Give the skill a name';
    out.name = name.slice(0, 80);
  }
  if (p.body !== undefined || !partial) {
    const body = String(p.body ?? '').trim();
    if (!body) return 'Write the steps for this skill';
    if (body.length > STEPS_MAX) return `The steps are ${count(body.length)} characters. A skill can have up to ${count(STEPS_MAX)}.`;
    out.body = body;
  }
  if (p.description !== undefined) out.description = String(p.description).trim().slice(0, 300);
  return out;
}

/** Why saving `next` in place of skill `replacing` would make the bot's skills too big, or null. Edits that don't grow them always pass. */
function overTotal(botId: string, next: { name: string; description: string; body: string }, replacing?: SkillRecord): string | null {
  const before = db.prepare<[string], SkillRecord>('SELECT * FROM skills WHERE bot_id=?').all(botId).reduce((n, s) => n + skillSize(s), 0);
  const after = before - (replacing ? skillSize(replacing) : 0) + skillSize(next);
  if (after <= SKILLS_MAX || after <= before) return null;
  return `That would bring this bot’s skills to ${count(after)} characters, over the ${count(SKILLS_MAX)} it can have. Shorten this one or delete another.`;
}

configApi.get('/bots/:id/skills', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ skills: listSkills(b.id) }) : c.json({ error: 'not found' }, 404);
});

configApi.post('/bots/:id/skills', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  // A group chat has no turns of its own: its members' skills are their own.
  if (!b || b.kind === 'room') return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await body(c, SkillInput));
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const next = { name: s.name!, description: s.description ?? '', body: s.body! };
  const over = overTotal(b.id, next);
  if (over) return c.json({ error: over }, 400);
  const id = newId('skl');
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, b.id, next.name, next.body, next.description, now(), now());
  return c.json({ skill: toSkill(skillById.get(id)!) } satisfies SkillResponse);
});

const ownSkill = (userId: string, id: string) =>
  db.prepare<[string, string], SkillRecord>('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id, userId);

configApi.patch('/skills/:id', async (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await body(c, SkillInput), true);
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const next = { name: s.name ?? cur.name, description: s.description ?? cur.description ?? '', body: s.body ?? cur.body };
  const over = overTotal(cur.bot_id, next, cur);
  if (over) return c.json({ error: over }, 400);
  db.prepare('UPDATE skills SET name=?, body=?, description=?, updated_at=? WHERE id=?').run(next.name, next.body, next.description, now(), cur.id);
  return c.json({ skill: toSkill(skillById.get(cur.id)!) } satisfies SkillResponse);
});

configApi.delete('/skills/:id', (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM skills WHERE id=?').run(cur.id);
  return c.json({ ok: true } satisfies Ok);
});

// ---------- the agent behind a bot: model, sign-in, restart ----------

configApi.get('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ engine: await engineInfo(b.id) } satisfies EngineResponse);
});

/** Which model this bot's turns ask for, also made its Hermes' default. Empty values go back to the agent's own default. */
configApi.patch('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await body(c, z.object({ provider: z.string().nullable().optional(), model: z.string().nullable().optional() }));
  const clean = (v: string | null) => (v?.trim() ? v.trim().slice(0, 120) : null);
  if (p.provider !== undefined) db.prepare('UPDATE bots SET provider=?, updated_at=? WHERE id=?').run(clean(p.provider), now(), b.id);
  if (p.model !== undefined) db.prepare('UPDATE bots SET model=?, updated_at=? WHERE id=?').run(clean(p.model), now(), b.id);
  syncModel(b.id);
  emitBot(b.id);
  return c.json({ engine: await engineInfo(b.id) } satisfies EngineResponse);
});

// ---------- subscription sign-ins with a code (signin.ts) ----------

/**
 * Sign a bot in to ChatGPT, Grok or GitHub Copilot: answers with the link and the code once the
 * provider has given them, and the sign-in finishes by itself when the user approves. Copilot's goes
 * into Settings > Providers for every bot. Claude, the keys and the addresses have no sign-in.
 */
configApi.post('/bots/:id/engine/login', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { provider } = await body(c, z.object({ provider: z.string().max(100) }));
  if (!signInName(provider)) {
    return c.json({ error: 'Pick ChatGPT, Grok or GitHub Copilot to sign in to. Claude and the other providers are set up in Settings > Providers.' }, 400);
  }
  if (provider !== 'copilot' && !engineHome(b.id)) return c.json({ error: 'This bot has no agent.' }, 409);
  return signInAnswer(c, () => startSignIn(user.id, provider, b.id));
});

/** Settings > Providers: sign in to GitHub for the Copilot token every bot uses. */
configApi.post('/providers/copilot/login', async (c) => signInAnswer(c, () => startSignIn(c.get('user').id, 'copilot', null)));

configApi.get('/signins/:id', (c) => {
  const signIn = getSignIn(c.get('user').id, c.req.param('id'));
  if (!signIn) return c.json({ error: 'not found' }, 404);
  return c.json({ signIn } satisfies SignInResponse);
});

configApi.delete('/signins/:id', (c) => {
  if (!cancelSignIn(c.get('user').id, c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true } satisfies Ok);
});

/** A sign-in that failed before giving a code is an error, with why; otherwise its link and code. */
async function signInAnswer(c: Context<AuthVars>, start: () => Promise<ProviderSignIn>) {
  try {
    const signIn = await start();
    if (signIn.status === 'failed') return c.json({ error: signIn.error ?? 'The sign-in didn’t start.' }, 502);
    return c.json({ signIn } satisfies SignInResponse);
  } catch (e) {
    return c.json({ error: errorText(e).slice(0, 300) }, 502);
  }
}

configApi.post('/bots/:id/engine/restart', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!hasEngine(b.id)) return c.json({ error: 'This bot has no agent.' }, 409);
  try {
    await restartEngine(b.id);
    forgetEngineOptions(b.id);
    return c.json({ engine: await engineInfo(b.id) } satisfies EngineResponse);
  } catch (e) {
    return c.json({ error: errorText(e).slice(0, 300) }, 502);
  }
});

/** Stop the private screen Hermes runs for this agent, so its computer work comes back to the screen shown here. */
configApi.post('/bots/:id/engine/screen/stop', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await stopOwnScreen(b.id);
    return c.json({ engine: await engineInfo(b.id) } satisfies EngineResponse);
  } catch (e) {
    return c.json({ error: errorText(e).slice(0, 300) }, 409);
  }
});

/** Switch the viewer's open screen connection (named by `conn` when it opened) between watching and control. */
configApi.post('/bots/:id/screen/mode', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { conn, mode } = await body(c, z.object({ conn: z.string().max(64), mode: z.enum(['watch', 'control']) }));
  // Gone (the screen closed, or it never opened): the viewer reconnects in the new mode instead.
  if (!setRelayMode(user.id, b.id, conn, mode)) return c.json({ error: 'no such connection' }, 404);
  return c.json({ ok: true } satisfies Ok);
});

/** The user gives the screen back after taking control; the bot is told on its next turn. */
configApi.post('/bots/:id/handback', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET handback_at=? WHERE id=?').run(now(), b.id);
  return c.json({ ok: true } satisfies Ok);
});

// ---------- library: files under ~/dispatch/files/<botId> of the bots' account (machine.ts) ----------

const LIB_ROOT = LIBRARY_ROOT;

function safeRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Parse `ls -la --time-style=+%s` output. */
export function parseLs(out: string): LibraryFile[] {
  const files: LibraryFile[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^([-dlcbps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    let name = m[4];
    if (m[1] === 'l') name = name.replace(/ -> .*$/, '');
    if (name === '.' || name === '..') continue;
    files.push({ name, size: Number(m[2]), modifiedAt: Number(m[3]) * 1000, isDir: m[1] === 'd' });
  }
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modifiedAt - a.modifiedAt);
}

configApi.get('/bots/:id/files', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (rel === null) return c.json({ error: 'bad path' }, 400);
  try {
    const dir = `${LIB_ROOT}/${b.id}${rel ? `/${rel}` : ''}`;
    const r = await box.bash(`mkdir -p ${shq(`${LIB_ROOT}/${b.id}`)} && ls -la --time-style=+%s ${shq(dir)} 2>&1`, 30);
    if (r.exit_code !== 0) return c.json({ status: 'error', path: rel, files: [], error: (r.output ?? '').slice(0, 300) } satisfies LibraryListing);
    return c.json({ status: 'ok', path: rel, files: parseLs(r.output ?? '') } satisfies LibraryListing);
  } catch (e) {
    return c.json({ status: 'error', path: rel, files: [], error: errorText(e).slice(0, 300) } satisfies LibraryListing);
  }
});

configApi.post('/bots/:id/files/download', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { path } = await body(c, z.object({ path: z.string().default('') }));
  const rel = safeRel(path);
  if (!rel) return c.json({ error: 'bad path' }, 400);
  // The file is on this server's own disk: the browser fetches it from the route below.
  return c.json({ url: `/api/bots/${b.id}/files/raw?path=${encodeURIComponent(rel)}` } satisfies UrlResponse);
});

configApi.get('/bots/:id/files/raw', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (!rel) return c.json({ error: 'bad path' }, 400);
  const root = `${LIB_ROOT}/${b.id}`;
  let file: string;
  try {
    // Follow links before checking, so a link inside the library cannot point outside it.
    file = fs.realpathSync(`${root}/${rel}`);
    if (!file.startsWith(fs.realpathSync(root) + '/') || !fs.statSync(file).isFile()) throw new Error('outside');
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  const name = rel.split('/').pop()!;
  // ?inline=1 sends the types the app shows in place (pictures, PDFs, audio, video); everything else downloads.
  const type = c.req.query('inline') === '1' ? inlineType(name) : undefined;
  const size = fs.statSync(file).size;
  const headers: Record<string, string> = {
    'content-type': type ?? 'application/octet-stream',
    'content-disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
  };
  // One byte range, so a video can seek and the preview can read the start of a long text file. An
  // empty file has no bytes to ask for, so it is sent whole.
  const range = size ? byteRange(c.req.header('range'), size) : null;
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const stream = size ? fs.createReadStream(file, { start, end }) : Readable.from([]);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers: { ...headers, 'content-length': String(size ? end - start + 1 : 0), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) },
  });
});

/** A `Range: bytes=a-b` header, clamped to the file. Several ranges, or anything else, get the whole file. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  let start: number, end: number;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; } // the last n bytes
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Files the person attaches in the composer land in the bot's Library under uploads/ (library.ts).
 * A group's go to the group's own folder; sending the message copies them to its members.
 */
const MAX_UPLOAD = 200 * 1024 * 1024;
configApi.post('/bots/:id/files/upload', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const form = await c.req.parseBody({ all: true }).catch(() => null);
  const raw = form?.file;
  const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => typeof f !== 'string');
  if (!files.length) return c.json({ error: 'no file' }, 400);
  const dir = uploadsDir(b.id);
  mkdirOwned(dir);
  const saved: Attachment[] = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD) return c.json({ error: `${f.name} is over 200 MB` }, 413);
    // A number before the extension if one with that name is there.
    const clean = safeName(f.name);
    let name = clean;
    for (let n = 2; fs.existsSync(`${dir}/${name}`); n++) name = numbered(clean, n);
    await box.writeFile(`${dir}/${name}`, Buffer.from(await f.arrayBuffer()));
    saved.push({ name, path: `uploads/${name}`, size: f.size, type: f.type || 'application/octet-stream' });
  }
  return c.json({ files: saved } satisfies UploadResponse);
});

// ---------- computer: screens and reset ----------

configApi.get('/computer/details', (c) => {
  const userId = c.get('user').id;
  const leases = db.prepare<[string], Omit<ScreenRecord, 'user_id'>>('SELECT bot_id, screen_id, last_used_at FROM screens WHERE user_id=? ORDER BY last_used_at DESC').all(userId);
  return c.json({
    computer: computerState(userId),
    screens: leases.map((l) => ({ botId: l.bot_id, screenId: l.screen_id, lastUsedAt: l.last_used_at })),
  } satisfies ComputerDetails);
});

/** Give a bot a clean screen: close what is open and bring its browser back to its home screen. Logins stay. */
configApi.post('/bots/:id/screen/reset', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await resetBotScreen(user.id, b.id);
    hub.emit(user.id, { type: 'computer', state: computerState(user.id) });
    return c.json({ ok: true } satisfies Ok);
  } catch (e) {
    return c.json({ error: errorText(e).slice(0, 300) }, 502);
  }
});
