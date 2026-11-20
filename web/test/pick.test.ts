import { expect, test } from 'vitest';
import { pickOther } from '../src/lib/pick';

test('never repeats the last pick', () => {
  for (const r of [0, 0.3, 0.5, 0.99]) expect(pickOther(['a', 'b', 'c'], 'b', () => r)).not.toBe('b');
});

test('reaches every other option', () => {
  const seen = new Set([0, 0.34, 0.67, 0.99].map((r) => pickOther(['a', 'b', 'c', 'd'], 'a', () => r)));
  expect([...seen].sort()).toEqual(['b', 'c', 'd']);
});

test('picks from all options when there is no last pick, or only one option', () => {
  expect(pickOther(['a', 'b'], undefined, () => 0)).toBe('a');
  expect(pickOther(['a'], 'a', () => 0.5)).toBe('a');
});
