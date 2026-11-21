import { beforeAll, expect, test } from 'vitest';

// Its own file: it shuts the test client out, which would fail every sign-in after it.
const { createApp } = await import('../src/app.js');
const { seedOwner } = await import('./helpers.js');
const { initAuth, setupCode } = await import('../src/lib/auth.js');

const app = createApp();
const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
let cookie = '';
beforeAll(async () => {
  initAuth(seedOwner());
  // A wrong setup code counts as a wrong password.
  expect((await post('/api/auth/setup', { username: 'ada', password: 'correct horse', code: 'AAAA-AAAA' })).status).toBe(403);
  cookie = (await post('/api/auth/setup', { username: 'ada', password: 'correct horse', code: setupCode() })).headers.get('set-cookie')!.split(';')[0];
});

test('ten wrong passwords shut the client out, right password or not', async () => {
  const wrong = await post('/api/auth/login', { username: 'ada', password: 'guess 0' });
  expect(wrong.status).toBe(401);
  expect(wrong.headers.get('set-cookie')).toBeNull();
  // A wrong current password when changing it counts toward the same limit.
  expect((await post('/api/auth/password', { current: 'guess 1', next: 'new password' }, cookie)).status).toBe(401);
  for (let i = 3; i < 9; i++) expect((await post('/api/auth/login', { username: 'ada', password: `guess ${i}` })).status).toBe(401);
  const tenth = await post('/api/auth/login', { username: 'ada', password: 'guess 9' });
  expect(tenth.status).toBe(429);
  expect(Number(tenth.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(((await tenth.json()) as { error: string }).error).toBe('Too many tries. Try again in 15 minutes.');
  expect((await post('/api/auth/login', { username: 'ada', password: 'correct horse' })).status).toBe(429);
  expect((await post('/api/auth/password', { current: 'correct horse', next: 'new password' }, cookie)).status).toBe(429);
});
