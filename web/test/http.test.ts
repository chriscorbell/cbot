import { afterEach, expect, test, vi } from 'vitest';

const { request, onSignedOut, ApiError } = await import('../src/lib/http');

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
afterEach(() => { vi.unstubAllGlobals(); });

test('a 401 means the session is gone, except when a password is refused', async () => {
  const gone = vi.fn();
  onSignedOut(gone);
  vi.stubGlobal('fetch', answer(401, { error: 'unauthenticated' }));
  await expect(request('GET', '/bots')).rejects.toBeInstanceOf(ApiError);
  expect(gone).toHaveBeenCalledTimes(1);

  vi.stubGlobal('fetch', answer(401, { error: 'Wrong user name or password.' }));
  await expect(request('POST', '/auth/login', { username: 'a', password: 'b' })).rejects.toThrow('Wrong user name or password.');
  expect(gone).toHaveBeenCalledTimes(1);

  vi.stubGlobal('fetch', answer(401, { error: 'That isn’t your current password.' }));
  await expect(request('POST', '/auth/password', { current: 'a', next: 'bbbbbbbb' })).rejects.toThrow('That isn’t your current password.');
  expect(gone).toHaveBeenCalledTimes(1);

  vi.stubGlobal('fetch', answer(500, { error: 'boom' }));
  await expect(request('GET', '/bots')).rejects.toThrow('boom');
  expect(gone).toHaveBeenCalledTimes(1);
});
