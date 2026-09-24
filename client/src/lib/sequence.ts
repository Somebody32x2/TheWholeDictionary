/**
 * Which word comes next.
 *
 * Two orders. Alphabetical is a plain ascending walk. Random is *block*
 * shuffled: shard groups are shuffled against each other, and ids are shuffled
 * within the active group. A flat shuffle over 200k ids would touch a new
 * shard almost every word - 200 network round trips in the first 200 answers,
 * and eventually the entire corpus resident on the device. Block shuffling
 * keeps at most one group (8 shards, ~280 KB compressed) live at a time while
 * still feeling random, and because the permutation is a pure function of the
 * profile's `randomSeed` it reproduces exactly on another device, which is
 * what makes a random-mode cursor portable.
 */

const SHARD_SIZE = 1000;
/** 8 shards, 8,000 ids: big enough not to feel like a block, small enough to cache. */
export const GROUP_SHARDS = 8;
export const GROUP_SIZE = SHARD_SIZE * GROUP_SHARDS;

/** Golden-ratio odd constant; decorrelates the per-group seed from the profile seed. */
const GROUP_SEED_MIX = 0x9e3779b1;

export type Order = 'alphabetical' | 'random';

export interface SequenceInput {
  wordCount: number;
  tiers: Uint8Array;
  rating: Uint8Array;
  tierMax: number;
  skipAnswered: boolean;
  seed: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rnd: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * The random permutation, memoised.
 *
 * Both layers are pure functions of (seed, wordCount), so they are computed
 * once and reused. Recomputing them per lookup would be an 8,000-element
 * shuffle for every single word, and `upcoming()` asks 200 times in a row.
 */
interface Permutation {
  seed: number;
  wordCount: number;
  /** Group ids in visit order, with the cumulative start position of each. */
  order: number[];
  starts: number[];
  /** The shuffled ids of the one group currently being walked. */
  activeGroup: number;
  active: Int32Array | null;
}

let perm: Permutation | null = null;

function permutationFor(wordCount: number, seed: number): Permutation {
  if (perm && perm.seed === seed && perm.wordCount === wordCount) return perm;
  const groupCount = Math.ceil(wordCount / GROUP_SIZE);
  const order = shuffle([...Array(groupCount).keys()], mulberry32(seed));
  const starts: number[] = [];
  let at = 0;
  for (const group of order) {
    starts.push(at);
    at += Math.min(GROUP_SIZE, wordCount - group * GROUP_SIZE);
  }
  perm = { seed, wordCount, order, starts, activeGroup: -1, active: null };
  return perm;
}

/**
 * The full ordering for `random` mode, materialised one group at a time.
 *
 * `position` is an index into the *permutation*, not into the corpus, so it is
 * stable across devices and across sessions as long as the seed is.
 */
export function randomIdAt(position: number, wordCount: number, seed: number): number | null {
  if (position < 0 || position >= wordCount) return null;
  const p = permutationFor(wordCount, seed);

  // starts[] is ascending, so a binary search finds the owning group.
  let lo = 0;
  let hi = p.order.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.starts[mid] <= position) lo = mid;
    else hi = mid - 1;
  }
  const group = p.order[lo];
  const from = group * GROUP_SIZE;
  const size = Math.min(GROUP_SIZE, wordCount - from);

  if (p.activeGroup !== group || !p.active) {
    const within = shuffle(
      [...Array(size).keys()],
      mulberry32((seed ^ Math.imul(group, GROUP_SEED_MIX)) >>> 0),
    );
    p.active = Int32Array.from(within);
    p.activeGroup = group;
  }
  return from + p.active[position - p.starts[lo]];
}

/**
 * Advance from `position` to the next id that passes the filters.
 *
 * Returns the position as well as the id because the caller stores the
 * position: in random mode the id alone says nothing about how far through
 * the run you are.
 *
 * @returns null when the filtered sequence is exhausted.
 */
export function nextFrom(
  input: SequenceInput,
  order: Order,
  position: number,
): { position: number; id: number } | null {
  const { wordCount, tiers, rating, tierMax, skipAnswered, seed } = input;
  for (let p = Math.max(0, position); p < wordCount; p++) {
    const id = order === 'random' ? randomIdAt(p, wordCount, seed) : p;
    if (id === null) return null;
    if (tiers[id] > tierMax) continue;
    if (skipAnswered && rating[id] !== 0) continue;
    return { position: p, id };
  }
  return null;
}

/**
 * The ids the run is about to reach, for shard prefetch. Unfiltered on purpose
 * - a skipped word still lives in a shard the walker is about to open.
 */
export function upcoming(
  input: SequenceInput,
  order: Order,
  position: number,
  count: number,
): number[] {
  const ids: number[] = [];
  for (let p = position; p < input.wordCount && ids.length < count; p++) {
    const id = order === 'random' ? randomIdAt(p, input.wordCount, input.seed) : p;
    if (id === null) break;
    ids.push(id);
  }
  return ids;
}

/** How many words the current filters leave to answer. */
export function remainingCount(input: SequenceInput): number {
  const { wordCount, tiers, rating, tierMax, skipAnswered } = input;
  let n = 0;
  for (let i = 0; i < wordCount; i++) {
    if (tiers[i] > tierMax) continue;
    if (skipAnswered && rating[i] !== 0) continue;
    n++;
  }
  return n;
}

/** Words inside the tier ceiling, answered or not: the coverage denominator. */
export function inScopeCount(tiers: Uint8Array, tierMax: number): number {
  let n = 0;
  for (let i = 0; i < tiers.length; i++) if (tiers[i] <= tierMax) n++;
  return n;
}
