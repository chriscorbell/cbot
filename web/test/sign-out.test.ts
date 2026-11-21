import { afterEach, expect, test, vi } from 'vitest';

const reload = vi.fn();
vi.stubGlobal('location', { reload });
const { useStore } = await import('../src/store');

afterEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('location', { reload }); });

test('a sign-out the server never got fails, rather than reloading as if it had worked', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  await expect(useStore.getState().signOut()).rejects.toThrow();
  expect(reload).not.toHaveBeenCalled();

  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
  await useStore.getState().signOut();
  expect(reload).toHaveBeenCalledTimes(1);
});
