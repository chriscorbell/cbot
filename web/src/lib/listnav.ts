// Keyboard movement through a list of options, for the app's dropdowns (components/Select.tsx).

/** The next option that can be picked, moving `dir` from `from`, wrapping at the ends. -1 when none can. */
export function stepIndex(disabled: boolean[], from: number, dir: 1 | -1): number {
  const n = disabled.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return -1;
}

/** The first or last option that can be picked (Home and End). -1 when none can. */
export function edgeIndex(disabled: boolean[], end: 'first' | 'last'): number {
  return end === 'first' ? disabled.indexOf(false) : disabled.lastIndexOf(false);
}

/**
 * Type-to-jump: the next option after `from` whose label starts with `query`, wrapping; when the
 * query is one letter typed again, it cycles through the options with that letter. -1 when none match.
 */
export function matchIndex(labels: string[], disabled: boolean[], from: number, query: string): number {
  const q = query.toLowerCase();
  if (!q) return -1;
  const n = labels.length;
  // A longer query keeps the current option if it still matches; one letter moves on.
  const start = q.length > 1 ? 0 : 1;
  for (let k = start; k < n + start; k++) {
    const i = (((from + k) % n) + n) % n;
    if (!disabled[i] && labels[i].toLowerCase().startsWith(q)) return i;
  }
  return -1;
}
