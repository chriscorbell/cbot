import { describe, expect, it } from 'vitest';
import { edgeIndex, matchIndex, stepIndex } from '../src/lib/listnav';

describe('stepIndex', () => {
  it('moves to the next option and wraps', () => {
    expect(stepIndex([false, false, false], 0, 1)).toBe(1);
    expect(stepIndex([false, false, false], 2, 1)).toBe(0);
    expect(stepIndex([false, false, false], 0, -1)).toBe(2);
  });
  it('skips options that cannot be picked', () => {
    expect(stepIndex([false, true, false], 0, 1)).toBe(2);
    expect(stepIndex([false, true, true], 0, 1)).toBe(0);
  });
  it('starts from the first option when nothing has focus', () => {
    expect(stepIndex([true, false, false], -1, 1)).toBe(1);
  });
  it('gives -1 when no option can be picked', () => {
    expect(stepIndex([true, true], 0, 1)).toBe(-1);
  });
});

describe('edgeIndex', () => {
  it('finds the first and last options that can be picked', () => {
    expect(edgeIndex([true, false, false, true], 'first')).toBe(1);
    expect(edgeIndex([true, false, false, true], 'last')).toBe(2);
  });
});

describe('matchIndex', () => {
  const labels = ['DeepSeek', 'Claude', 'ChatGPT', 'GitHub Copilot'];
  const none = [false, false, false, false];
  it('jumps to the next option starting with a letter, and cycles on the same letter', () => {
    expect(matchIndex(labels, none, 0, 'c')).toBe(1);
    expect(matchIndex(labels, none, 1, 'c')).toBe(2);
    expect(matchIndex(labels, none, 2, 'c')).toBe(1);
  });
  it('keeps the current option while a longer query still matches it', () => {
    expect(matchIndex(labels, none, 2, 'ch')).toBe(2);
    expect(matchIndex(labels, none, 1, 'ch')).toBe(2);
  });
  it('ignores case, skips disabled options and gives -1 without a match', () => {
    expect(matchIndex(labels, [false, true, false, false], 0, 'C')).toBe(2);
    expect(matchIndex(labels, none, 0, 'x')).toBe(-1);
  });
});
