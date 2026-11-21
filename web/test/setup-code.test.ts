import { expect, test } from 'vitest';
import { setupCodeFrom } from '../src/lib/setupCode';

test('the setup code comes from the fragment the installer prints, and only from there', () => {
  expect(setupCodeFrom('#setup=K7QX-2M9P')).toBe('K7QX-2M9P');
  expect(setupCodeFrom('#other=1&setup=K7QX%2D2M9P')).toBe('K7QX-2M9P');
  expect(setupCodeFrom('#setup=')).toBeNull();
  expect(setupCodeFrom('#nosetup=K7QX-2M9P')).toBeNull();
  expect(setupCodeFrom('')).toBeNull();
  expect(setupCodeFrom('#setup=%E0%A4%A')).toBeNull();
});
