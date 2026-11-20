/** A random item of `options` other than `last`, unless `last` is the only one there is. */
export function pickOther<T>(options: readonly T[], last?: T, random: () => number = Math.random): T {
  const pool = options.length > 1 ? options.filter((o) => o !== last) : options;
  return pool[Math.floor(random() * pool.length)];
}
