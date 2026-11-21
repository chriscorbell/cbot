import { beforeAll, expect, test } from 'vitest';

// Requests from other sites' pages, the session cookie over HTTPS, and the headers on every answer.
const { createApp } = await import('../src/app.js');
const { crossSite } = await import('../src/lib/auth.js');
const { auth, seedOwner } = await import('./helpers.js');

const app = createApp();
beforeAll(() => { seedOwner(); });

const from = (headers: Record<string, string>) => crossSite((name) => headers[name]);

test('a request is from another site by its Sec-Fetch-Site, else by an Origin that names another host', () => {
  expect(from({ 'sec-fetch-site': 'same-origin' })).toBe(false);
  expect(from({ 'sec-fetch-site': 'none' })).toBe(false);
  // Another port of the same address is the same site, but not the app.
  expect(from({ 'sec-fetch-site': 'same-site' })).toBe(true);
  expect(from({ 'sec-fetch-site': 'cross-site', origin: 'https://box.local:8787', host: 'box.local:8787' })).toBe(true);
  // Browsers too old for Sec-Fetch-Site: Origin against the host the browser asked for, here or before a proxy.
  expect(from({ origin: 'https://box.local:8787', host: 'box.local:8787' })).toBe(false);
  expect(from({ origin: 'https://box.tail1.ts.net', host: '127.0.0.1:8787', 'x-forwarded-host': 'box.tail1.ts.net' })).toBe(false);
  expect(from({ origin: 'http://box.local:9000', host: 'box.local:8787' })).toBe(true);
  expect(from({ origin: 'null', host: 'box.local:8787' })).toBe(true);
  // Not a web page at all: curl, or a bot's Hermes.
  expect(from({ host: 'box.local:8787' })).toBe(false);
});

test('a change from another site is refused before any route sees it, sign-ins included', async () => {
  const elsewhere = { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' };
  expect((await app.request('/api/bots/nope/read', { method: 'POST', headers: { ...auth(), ...elsewhere } })).status).toBe(403);
  const signIn = await app.request('/api/auth/login', { method: 'POST', headers: elsewhere, body: JSON.stringify({ username: 'a', password: 'b' }) });
  expect(signIn.status).toBe(403);
  expect(((await signIn.json()) as { error: string }).error).toBe('This request came from another site, so Dispatch refused it.');
  // Reading is left alone (another site can't read the answer), and the app's own pages get through.
  expect((await app.request('/api/bots', { headers: { ...auth(), 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
  expect((await app.request('/api/bots/nope/read', { method: 'POST', headers: { ...auth(), 'sec-fetch-site': 'same-origin' } })).status).toBe(404);
});

test('the session cookie is Secure when the browser came over HTTPS', async () => {
  const signUp = await app.request('/api/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ username: 'ada', password: 'correct horse' }),
  });
  expect(signUp.headers.get('set-cookie')).toMatch(/; Secure/);
  const plain = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: 'correct horse' }) });
  expect(plain.status).toBe(200);
  expect(plain.headers.get('set-cookie')).not.toMatch(/Secure/);
});

test('every answer carries the security headers', async () => {
  for (const path of ['/api/health', '/api/bots', '/']) {
    const r = await app.request(path);
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self' blob: 'wasm-unsafe-eval'");
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  }
});
