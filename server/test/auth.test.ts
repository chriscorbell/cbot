import { beforeAll, expect, test } from 'vitest';

const { createApp } = await import('../src/app.js');
const { initAuth, resetAccount, startSession } = await import('../src/lib/auth.js');
const { seedOwner } = await import('./helpers.js');
const { hub } = await import('../src/lib/hub.js');
const { db } = await import('../src/db.js');

const app = createApp();
let owner: ReturnType<typeof seedOwner>;
// A fresh install: the setup wizard comes after the account.
beforeAll(() => { owner = seedOwner(); db.prepare('UPDATE users SET setup_at=NULL').run(); });

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const setup = (username: string, password: string) => post('/api/auth/setup', { username, password });
const login = (username: string, password: string) => post('/api/auth/login', { username, password });
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];
const me = async (cookie?: string) => (await app.request('/api/auth/me', { headers: cookie ? { cookie } : {} })).json() as Promise<{ user: { id: string; username: string } | null; needsAccount: boolean; needsSetup: boolean }>;
const signedIn = async (cookie: string) => (await app.request('/api/bots', { headers: { cookie } })).status === 200;

test('an upgraded install drops sessions from the environment-credentials days when it starts', async () => {
  const old = `dispatch_session=${startSession(owner.id)}`;
  expect(await signedIn(old)).toBe(true);
  initAuth(owner);
  expect(await signedIn(old)).toBe(false);
});

test('a fresh install has no account: the app is open, the API is not, and nobody can sign in', async () => {
  expect(await me()).toEqual({ user: null, needsAccount: true, needsSetup: false });
  // createApp has no static files (index.ts adds them), so an open path falls through to 404, not 401.
  expect((await app.request('/')).status).toBe(404);
  const api = await app.request('/api/bots');
  expect(api.status).toBe(401);
  expect(api.headers.get('www-authenticate')).toBeNull();
  expect((await login('anyone', 'anything')).status).toBe(409);
  // Basic credentials are not a way in any more.
  expect((await app.request('/api/bots', { headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } })).status).toBe(401);
});

test('the first-run form checks the user name and password before creating anything', async () => {
  expect((await setup('', 'long enough')).status).toBe(400);
  expect((await setup('two words', 'long enough')).status).toBe(400);
  expect((await setup('ada', 'short')).status).toBe(400);
  expect((await me()).needsAccount).toBe(true);
});

test('the first visit creates the account and is signed in; a second can only sign in', async () => {
  const [a, b] = await Promise.all([setup('ada', 'correct horse'), setup('eve', 'battery staple')]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const first = a.status === 200 ? a : b;
  const name = a.status === 200 ? 'ada' : 'eve';
  const cookie = cookieOf(first);
  // Signed in, on to the setup wizard.
  expect(await me(cookie)).toEqual({ user: { id: owner.id, username: name, avatarUrl: null }, needsAccount: false, needsSetup: true });
  expect(await signedIn(cookie)).toBe(true);
  expect(((await (a.status === 409 ? a : b).json()) as { error: string }).error).toBe('An account already exists. Sign in instead.');
  // Settle on one account for the rest of the file.
  if (name !== 'ada') { resetAccount(); expect((await setup('ada', 'correct horse')).status).toBe(200); }
});

test('signing in checks both halves and starts a session the cookie alone carries', async () => {
  expect((await login('ada', 'wrong horse')).status).toBe(401);
  expect((await login('eve', 'correct horse')).status).toBe(401);
  const res = await login('  ada ', 'correct horse');
  expect(res.status).toBe(200);
  expect(await signedIn(cookieOf(res))).toBe(true);
});

test('signing out ends that session only', async () => {
  const a = cookieOf(await login('ada', 'correct horse'));
  const b = cookieOf(await login('ada', 'correct horse'));
  const out = await post('/api/auth/logout', {}, a);
  expect(out.status).toBe(200);
  expect(out.headers.get('set-cookie')).toMatch(/^dispatch_session=;.*Max-Age=0/);
  expect(await signedIn(a)).toBe(false);
  expect(await signedIn(b)).toBe(true);
  expect((await post('/api/auth/logout', {})).status).toBe(200);
});

test('an open event stream stops before its next event once its session ends', async () => {
  const cookie = cookieOf(await login('ada', 'correct horse'));
  const res = await app.request('/api/events', { headers: { cookie } });
  const reader = res.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"hello"');
  await post('/api/auth/logout', {}, cookie);
  hub.emit(owner.id, { type: 'roster' });
  const next = await reader.read();
  expect(next.done).toBe(true);
});

test('changing the password needs the current one and signs out every other browser', async () => {
  const here = cookieOf(await login('ada', 'correct horse'));
  const there = cookieOf(await login('ada', 'correct horse'));
  expect((await post('/api/auth/password', { current: 'nope', next: 'new password' })).status).toBe(401);
  const wrong = await post('/api/auth/password', { current: 'nope', next: 'new password' }, here);
  expect(wrong.status).toBe(401);
  expect(((await wrong.json()) as { error: string }).error).toBe('That isn’t your current password.');
  expect((await post('/api/auth/password', { current: 'correct horse', next: 'short' }, here)).status).toBe(400);
  expect((await post('/api/auth/password', { current: 'correct horse', next: 'new password' }, here)).status).toBe(200);
  expect(await signedIn(here)).toBe(true);
  expect(await signedIn(there)).toBe(false);
  expect((await login('ada', 'correct horse')).status).toBe(401);
  expect((await login('ada', 'new password')).status).toBe(200);
});

test('resetting the account signs everyone out and brings back the first-run form; the data stays', async () => {
  db.prepare('UPDATE users SET setup_at=1').run();
  const cookie = cookieOf(await login('ada', 'new password'));
  resetAccount();
  expect(await signedIn(cookie)).toBe(false);
  expect(await me()).toEqual({ user: null, needsAccount: true, needsSetup: false });
  const again = await setup('ada', 'another one');
  expect(again.status).toBe(200);
  // The bots are still there, so the setup wizard doesn't come back.
  expect(await me(cookieOf(again))).toMatchObject({ user: { id: owner.id }, needsSetup: false });
});
