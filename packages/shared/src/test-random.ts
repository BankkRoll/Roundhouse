/**
 * Seeded pseudo-random numbers for property-style tests, so a failing case
 * reproduces from its seed. Test-only; not exported from the package.
 *
 * @module
 */

/**
 * mulberry32: a tiny, fast PRNG with good enough distribution for tests.
 *
 * @param seed - Any 32-bit integer.
 * @returns A function returning uniform numbers in `[0, 1)`.
 */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks a uniform integer in `[min, max]`.
 *
 * @param random - Source from {@link seeded}.
 * @param min - Inclusive lower bound.
 * @param max - Inclusive upper bound.
 * @returns The integer.
 */
export function int(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Picks one element.
 *
 * @param random - Source from {@link seeded}.
 * @param items - Non-empty list.
 * @returns A uniformly chosen element.
 */
export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/**
 * Fisher–Yates shuffle into a new array.
 *
 * @param random - Source from {@link seeded}.
 * @param items - Items to shuffle.
 * @returns A shuffled copy.
 */
export function shuffle<T>(random: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
