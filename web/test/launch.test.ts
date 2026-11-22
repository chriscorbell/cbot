import { afterEach, expect, test, vi } from 'vitest';
import { captureLaunch, sharedText, takeShared } from '../src/lib/launch';

/** Loads the app at `href`; answers what the address bar was changed to. */
function openAt(href: string): string[] {
  const replaced: string[] = [];
  vi.stubGlobal('window', { location: { href } });
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) });
  captureLaunch();
  return replaced;
}
afterEach(() => { vi.unstubAllGlobals(); });

test('shared text keeps each part once, however the app filled the fields', () => {
  expect(sharedText('A page', 'Look at this https://ex.com/a', 'https://ex.com/a')).toBe('A page\nLook at this https://ex.com/a');
  expect(sharedText(null, null, 'https://ex.com/a')).toBe('https://ex.com/a');
  expect(sharedText('Title', 'Title, and more', null)).toBe('Title, and more');
  expect(sharedText('  ', '', '')).toBe('');
});

test('a share opens the app at its root, with the text waiting for the composer once', () => {
  expect(openAt('https://dispatch.local:8787/share?title=Hi&text=See%20https%3A%2F%2Fex.com&url=https%3A%2F%2Fex.com')).toEqual(['/']);
  expect(takeShared()).toBe('Hi\nSee https://ex.com');
  expect(takeShared()).toBeNull();
});
