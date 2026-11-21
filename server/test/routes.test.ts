import { beforeAll, expect, test, vi } from 'vitest';

// A posted message starts a turn, which would start the bot's screen and gateway: record it instead.
const enqueued: { botId: string; trigger: unknown }[] = [];
vi.mock('../src/agent/turns.js', async (orig) => ({
  ...(await orig<typeof import('../src/agent/turns.js')>()),
  enqueue: (botId: string, trigger: unknown) => { enqueued.push({ botId, trigger }); },
}));

// Forgetting a memory holds Hermes' lock through util-linux flock, a child process tests can't start.
vi.mock('../src/lib/flock.js', () => ({ withFileLock: async (_lock: string, _wait: number, fn: () => unknown) => fn() }));

// Libraries go in the test's data folder, not under /root.
vi.mock('../src/machine.js', async (orig) => {
  const real = await orig<typeof import('../src/machine.js')>();
  const root = `${process.env.DATA_DIR}/files`;
  return { ...real, LIBRARY_ROOT: root, libraryDir: (botId: string) => `${root}/${botId}` };
});

const fs = await import('node:fs');
const { libraryDir } = await import('../src/machine.js');
const { createApp } = await import('../src/app.js');
const { auth, json, seedBot, seedOwner } = await import('./helpers.js');

const app = createApp();
let user: ReturnType<typeof seedOwner>;
beforeAll(() => { user = seedOwner(); });

test('the health check needs no sign-in; the rest of the API does', async () => {
  const health = await app.request('/api/health');
  expect(health.status).toBe(200);
  // Outside an installed release there is no commit to name (release.sh checks it on a machine).
  expect(await health.json()).toEqual({ ok: true, commit: null });
  const res = await app.request('/api/bots');
  expect(res.status).toBe(401);
  // No basic-auth challenge: the browser would show its own password prompt over the sign-in screen.
  expect(res.headers.get('www-authenticate')).toBeNull();
  expect((await app.request('/api/bots', { headers: auth() })).status).toBe(200);
});

test('a machine the installer did not set up offers no updates', async () => {
  expect(await (await app.request('/api/update', { headers: auth() })).json()).toEqual({ update: null });
  const r = await app.request('/api/update', json({}));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: 'This install of Dispatch can’t update itself. Run the installer again on its machine.' });
});

test('the HTTPS certificate is offered only while Dispatch serves its own', async () => {
  const { env } = await import('../src/env.js');
  expect((await app.request('/api/https/certificate')).status).toBe(404);
  expect(await (await app.request('/api/https', { headers: auth() })).json()).toEqual({ ownCertificate: false });
  fs.mkdirSync(`${env.dataDir}/https`, { recursive: true });
  fs.copyFileSync(new URL('fixtures/https/ca.crt', import.meta.url), `${env.dataDir}/https/ca.crt`);
  env.https = true;
  try {
    // Open: a device installs it before anyone signs in on it.
    const res = await app.request('/api/https/certificate');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-x509-ca-cert');
    expect(await res.text()).toContain('BEGIN CERTIFICATE');
    // A request that didn't come over Dispatch's own TLS (here none did) isn't offered it.
    expect(await (await app.request('/api/https', { headers: auth() })).json()).toEqual({ ownCertificate: false });
    expect((await app.request('/api/https')).status).toBe(401);
  } finally {
    env.https = false;
  }
});

test('a message to a bot is saved as a row and becomes a user turn', async () => {
  const bot = seedBot(user.id, { name: 'Ada' });
  const res = await app.request(`/api/bots/${bot.id}/messages`, json({ text: '  hello  ' }));
  expect(res.status).toBe(200);
  const { row } = (await res.json()) as { row: { body: { text: string; role: string } } };
  expect(row.body).toMatchObject({ role: 'user', text: 'hello' });
  expect(enqueued.at(-1)).toEqual({ botId: bot.id, trigger: { type: 'user', text: 'hello' } });
});

test('a message to a group goes to its members, not to the group itself', async () => {
  const a = seedBot(user.id, { name: 'Ann' });
  const b = seedBot(user.id, { name: 'Bob' });
  const room = seedBot(user.id, { name: 'Team', kind: 'room', members: [a.id, b.id] });
  enqueued.length = 0;
  await app.request(`/api/bots/${room.id}/messages`, json({ text: '@Bob ping' }));
  expect(enqueued.map((e) => e.botId)).toEqual([b.id]);
});

test("a file attached in a group is copied into every member's Library, and the ones asked are told where", async () => {
  const a = seedBot(user.id, { name: 'Fay' });
  const b = seedBot(user.id, { name: 'Gus' });
  const room = seedBot(user.id, { name: 'Crew', kind: 'room', members: [a.id, b.id] });
  // Gus already has a file by that name, so his copy is numbered.
  fs.mkdirSync(`${libraryDir(b.id)}/uploads`, { recursive: true });
  fs.writeFileSync(`${libraryDir(b.id)}/uploads/notes.txt`, 'his own');
  const form = new FormData();
  form.append('file', new File(['hello'], 'notes.txt', { type: 'text/plain' }));
  const up = await app.request(`/api/bots/${room.id}/files/upload`, { method: 'POST', headers: auth(), body: form });
  expect(up.status).toBe(200);
  const { files } = (await up.json()) as { files: { path: string }[] };
  expect(files[0]).toMatchObject({ name: 'notes.txt', path: 'uploads/notes.txt' });

  enqueued.length = 0;
  const res = await app.request(`/api/bots/${room.id}/messages`, json({ text: '@Fay read this', attachments: files }));
  expect(res.status).toBe(200);
  expect(fs.readFileSync(`${libraryDir(a.id)}/uploads/notes.txt`, 'utf8')).toBe('hello');
  expect(fs.readFileSync(`${libraryDir(b.id)}/uploads/notes (2).txt`, 'utf8')).toBe('hello');
  expect(fs.readFileSync(`${libraryDir(b.id)}/uploads/notes.txt`, 'utf8')).toBe('his own');
  // Only Fay was asked, and she is told where her copy is.
  expect(enqueued.map((e) => e.botId)).toEqual([a.id]);
  expect((enqueued[0].trigger as { text: string }).text).toContain(`- ${libraryDir(a.id)}/uploads/notes.txt (text/plain, 5 bytes)`);
  // The group's chat shows the file from the group's own folder.
  const raw = await app.request(`/api/bots/${room.id}/files/raw?path=uploads/notes.txt`, { headers: auth() });
  expect(await raw.text()).toBe('hello');
});

test('switching the mode of a screen connection that is not open says so, so the viewer reconnects', async () => {
  const bot = seedBot(user.id, { name: 'Mo' });
  const res = await app.request(`/api/bots/${bot.id}/screen/mode`, json({ conn: 'conn-gone-1', mode: 'control' }));
  expect(res.status).toBe(404);
  expect((await app.request(`/api/bots/${bot.id}/screen/mode`, json({ conn: 'conn-gone-1', mode: 'drive' }))).status).toBe(400);
});

test('a Library file is sent in place only for the types the app previews, and in byte ranges', async () => {
  const bot = seedBot(user.id, { name: 'Lou' });
  fs.mkdirSync(libraryDir(bot.id), { recursive: true });
  fs.writeFileSync(`${libraryDir(bot.id)}/report.pdf`, '%PDF-1.7');
  fs.writeFileSync(`${libraryDir(bot.id)}/page.html`, '<script>alert(1)</script>');
  fs.writeFileSync(`${libraryDir(bot.id)}/log.txt`, '0123456789');
  fs.writeFileSync(`${libraryDir(bot.id)}/empty.txt`, '');
  const get = (name: string, inline: boolean, range?: string) =>
    app.request(`/api/bots/${bot.id}/files/raw?path=${name}${inline ? '&inline=1' : ''}`, { headers: { ...auth(), ...(range ? { range } : {}) } });

  const pdf = await get('report.pdf', true);
  expect(pdf.headers.get('content-type')).toBe('application/pdf');
  expect(pdf.headers.get('content-disposition')).toMatch(/^inline/);
  expect((await get('report.pdf', false)).headers.get('content-disposition')).toMatch(/^attachment/);
  // HTML would run as the app at its own address: it only ever downloads.
  const html = await get('page.html', true);
  expect(html.headers.get('content-type')).toBe('application/octet-stream');
  expect(html.headers.get('content-disposition')).toMatch(/^attachment/);

  const part = await get('log.txt', false, 'bytes=0-3');
  expect(part.status).toBe(206);
  expect(part.headers.get('content-range')).toBe('bytes 0-3/10');
  expect(await part.text()).toBe('0123');
  expect(await (await get('log.txt', false, 'bytes=-2')).text()).toBe('89');
  expect((await get('log.txt', false, 'bytes=20-')).status).toBe(416);
  const empty = await get('empty.txt', false, 'bytes=0-99');
  expect(empty.status).toBe(200);
  expect(await empty.text()).toBe('');
});

test("a group starts with no About, and changing its members keeps the one the user wrote", async () => {
  const a = seedBot(user.id, { name: 'Gil' });
  const b = seedBot(user.id, { name: 'Hal' });
  const c = seedBot(user.id, { name: 'Ida' });
  const made = await app.request('/api/rooms', json({ name: 'Ops', botIds: [a.id, b.id] }));
  const { id } = (await made.json()) as { id: string };
  const { requireBot } = await import('../src/store.js');
  expect(requireBot(id).description).toBe('');
  await app.request(`/api/bots/${id}`, patch({ description: 'Keeps the servers up' }));
  const put = await app.request(`/api/rooms/${id}/members`, { method: 'PUT', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ botIds: [a.id, b.id, c.id] }) });
  expect(put.status).toBe(200);
  expect(requireBot(id).description).toBe('Keeps the servers up');
});

test('a group message points its bots to the group’s instructions when it has some', async () => {
  const a = seedBot(user.id, { name: 'Jo' });
  const room = seedBot(user.id, { name: 'Desk', kind: 'room', members: [a.id] });
  const say = async () => {
    enqueued.length = 0;
    await app.request(`/api/bots/${room.id}/messages`, json({ text: 'hi' }));
    return (enqueued[0].trigger as { text: string }).text;
  };
  expect(await say()).not.toContain('Group chats');
  await app.request(`/api/bots/${room.id}`, patch({ instructions: 'One line each.' }));
  expect(await say()).toContain('Follow the instructions for this group under "Group chats" in your system prompt.');
});

test("a bot that doesn't exist, or is another user's, is not found", async () => {
  expect((await app.request('/api/bots/bot_nope/rows', { headers: auth() })).status).toBe(404);
  const { db, now } = await import('../src/db.js');
  db.prepare("INSERT INTO users(id,username,created_at) VALUES ('usr_other','other',?)").run(now());
  const theirs = seedBot('usr_other', { name: 'Theirs' });
  expect((await app.request(`/api/bots/${theirs.id}/rows`, { headers: auth() })).status).toBe(404);
  expect((await app.request(`/api/bots/${theirs.id}/messages`, json({ text: 'hi' }))).status).toBe(404);
});

const patch = (body: unknown) => ({ method: 'PATCH', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('bot settings take only values the app knows', async () => {
  const bot = seedBot(user.id, { name: 'Cy' });
  const bad = await app.request(`/api/bots/${bot.id}`, patch({ effort: 'maximum' }));
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toMatch(/effort/);
  const ok = await app.request(`/api/bots/${bot.id}`, patch({ effort: 'high', sidebarHidden: true, label: 'Research' }));
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { bot: { effort: string; sidebarHidden: boolean; label: string } }).bot).toMatchObject({ effort: 'high', sidebarHidden: true, label: 'Research' });
});

test('a group needs two different Bots', async () => {
  const a = seedBot(user.id, { name: 'Dee' });
  const res = await app.request('/api/rooms', json({ name: 'Solo', botIds: [a.id, a.id] }));
  expect(res.status).toBe(400);
});

test('a question card is answered once', async () => {
  const bot = seedBot(user.id, { name: 'Eve' });
  const { appendRow } = await import('../src/store.js');
  const card = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which?', options: ['A', 'B'], status: 'pending' });
  const first = await app.request(`/api/bots/${bot.id}/cards/${card.seq}/answer`, json({ answer: 'A' }));
  expect(first.status).toBe(200);
  const again = await app.request(`/api/bots/${bot.id}/cards/${card.seq}/answer`, json({ answer: 'B' }));
  expect(again.status).toBe(409);
});

test('two answers sent at once answer the question once', async () => {
  const bot = seedBot(user.id, { name: 'Fay' });
  const { appendRow } = await import('../src/store.js');
  const card = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which?', options: ['A', 'B'], status: 'pending' });
  enqueued.length = 0;
  const statuses = await Promise.all(['A', 'B'].map(async (answer) => (await app.request(`/api/bots/${bot.id}/cards/${card.seq}/answer`, json({ answer }))).status));
  expect(statuses.sort()).toEqual([200, 409]);
  expect(enqueued.length).toBe(1);
});

test('a body that is not JSON is refused', async () => {
  const bot = seedBot(user.id, { name: 'Gus' });
  const res = await app.request(`/api/bots/${bot.id}/messages`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: '{"text": "hi"' });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toMatch(/not JSON/);
});

test('an answer from a tab still showing a cleared chat is refused', async () => {
  const bot = seedBot(user.id, { name: 'Hal' });
  const { appendRow, clearConversation } = await import('../src/store.js');
  const card = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which?', options: ['A'], status: 'pending' });
  clearConversation(bot.id);
  appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'New one?', options: ['B'], status: 'pending' });
  const res = await app.request(`/api/bots/${bot.id}/cards/${card.seq}/answer`, json({ answer: 'A', generation: 1 }));
  expect(res.status).toBe(409);
});

test('a reaction names its row by generation, so a seq reused by a new chat is not touched', async () => {
  const bot = seedBot(user.id, { name: 'Ida' });
  const { appendRow, clearConversation, getRow } = await import('../src/store.js');
  appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: 'old' });
  clearConversation(bot.id);
  appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: 'new' });
  const res = await app.request(`/api/bots/${bot.id}/rows/1`, { method: 'PATCH', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ reaction: '👍', generation: 1 }) });
  expect(res.status).toBe(200);
  expect(getRow({ botId: bot.id, generation: 1, seq: 1 })?.body).toMatchObject({ text: 'old', reaction: '👍' });
  expect(getRow({ botId: bot.id, generation: 2, seq: 1 })?.body).not.toHaveProperty('reaction');
});

const del = { method: 'DELETE', headers: auth() };
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

test('a skill is refused over its size, or when the bot’s skills would grow past theirs; a group takes none', async () => {
  const bot = seedBot(user.id, { name: 'Sky' });
  const make = (body: string) => app.request(`/api/bots/${bot.id}/skills`, json({ name: 'Notes', body }));
  const long = await make('x'.repeat(20_001));
  expect(long.status).toBe(400);
  expect(await errorOf(long)).toMatch(/20,001 characters\. A skill can have up to 20,000/);

  for (let i = 0; i < 2; i++) expect((await make('x'.repeat(20_000))).status).toBe(200);
  const third = await make('x'.repeat(10_000));
  expect(third.status).toBe(400);
  expect(await errorOf(third)).toMatch(/50,015 characters, over the 50,000/);

  // Each counts its name too ("Notes", 5 characters). Shrinking one is fine.
  const { db } = await import('../src/db.js');
  const [first] = db.prepare<[string], { id: string }>('SELECT id FROM skills WHERE bot_id=? ORDER BY created_at').all(bot.id);
  expect((await app.request(`/api/skills/${first.id}`, patch({ body: 'short' }))).status).toBe(200);
  expect((await make('x'.repeat(9_000))).status).toBe(200);

  const room = seedBot(user.id, { name: 'Crew', kind: 'room', members: [bot.id] });
  expect((await app.request(`/api/bots/${room.id}/skills`, json({ name: 'N', body: 'b' }))).status).toBe(404);
});

test('forgetting a memory the bot has changed since the list loaded says so', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { db } = await import('../src/db.js');
  const { env } = await import('../src/env.js');
  const { listMemories } = await import('../src/engine-memory.js');
  const bot = seedBot(user.id, { name: 'Mem' });
  db.prepare("UPDATE bots SET engine='managed' WHERE id=?").run(bot.id);
  const dir = path.join(env.enginesDir, bot.id, 'memories');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'USER.md'), 'Likes tea');
  const [m] = listMemories(bot.id);
  fs.writeFileSync(path.join(dir, 'USER.md'), 'Likes green tea');
  const res = await app.request(`/api/memories/${m.id}`, del);
  expect(res.status).toBe(409);
  expect(await errorOf(res)).toMatch(/already changed or removed/);
  const [now] = listMemories(bot.id);
  expect((await app.request(`/api/memories/${now.id}`, del)).status).toBe(200);
  expect(listMemories(bot.id)).toEqual([]);
});

test('Run now on a server with routines turned off says so', async () => {
  const { db, now } = await import('../src/db.js');
  const bot = seedBot(user.id, { name: 'Run' });
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,enabled,created_at) VALUES ('rt_run',?,'r','p','0 8 * * *',1,?)").run(bot.id, now());
  const res = await app.request('/api/routines/rt_run/run', { method: 'POST', headers: auth() });
  expect(res.status).toBe(409);
  expect(await errorOf(res)).toMatch(/turned off/);
});

test('a bot signs in with a code only to ChatGPT, Grok or Copilot, and only its owner can ask after a sign-in', async () => {
  const bot = seedBot(user.id, { name: 'Ida' });
  const claude = await app.request(`/api/bots/${bot.id}/engine/login`, json({ provider: 'anthropic' }));
  expect(claude.status).toBe(400);
  expect((await app.request('/api/bots/nope/engine/login', json({ provider: 'openai-codex' }))).status).toBe(404);
  expect((await app.request('/api/signins/signin_nope', { headers: auth() })).status).toBe(404);
  expect((await app.request('/api/signins/signin_nope', { method: 'DELETE', headers: auth() })).status).toBe(404);
  // Sign-ins and the Copilot sign-in in Settings need the session like the rest.
  expect((await app.request('/api/signins/signin_nope')).status).toBe(401);
  expect((await app.request('/api/providers/copilot/login', { method: 'POST' })).status).toBe(401);
});
