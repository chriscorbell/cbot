// The box scripts keep their own copies of a few of machine.ts's values; they must agree.
import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BOX_ROOT, cdpPortFor, displayFor, displayNumber, LIBRARY_ROOT, PROFILES_ROOT } from '../src/machine.js';

const dispatchlib = fs.readFileSync(path.join(import.meta.dirname, '../box/dispatchlib.py'), 'utf8');
const pyString = (name: string) => new RegExp(`^${name} = '([^']*)'`, 'm').exec(dispatchlib)?.[1];

test('the box scripts use the same folders', () => {
  expect(pyString('PROFILES')).toBe(PROFILES_ROOT);
  expect(pyString('LIBRARY')).toBe(LIBRARY_ROOT);
  expect(pyString('ROOT')).toBe(BOX_ROOT);
});

test('the box scripts compute the same DevTools port', () => {
  expect(dispatchlib).toMatch(/def cdp_port\(n\):\n {4}return 9200 \+ int\(n\)/);
  expect(cdpPortFor('default')).toBe(9299);
  expect(cdpPortFor('screen-101')).toBe(9301);
});

test('screen ids name displays', () => {
  expect(displayFor('default')).toBe(':99');
  expect(displayFor(null)).toBe(':99');
  expect(displayNumber('screen-100')).toBe(100);
});
