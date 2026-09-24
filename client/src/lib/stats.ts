/**
 * Every number the two stats pages show, computed in single passes.
 *
 * Response times are summarised through a 65,536-bucket histogram rather than
 * by sorting: `durMs` is a Uint16, so its entire domain fits in a 262 KB
 * scratch array and every order statistic is a prefix sum over it. Sorting
 * 200k values on the main thread would be visible; this is not.
 */

import {
  bandOf,
  DUR_CENSORED,
  FLAG_PEEKED,
  levelOf,
  scaleNameOf,
  fromEpochMinutes,
  type Band,
  type ScaleName,
} from '@shared/scales.js';

export interface CoverageStats {
  /** Words inside the tier ceiling. Everything below is a subset of this. */
  total: number;
  bands: Record<Band, number>;
  /** How many answers came from each scale - the key to a mixed-scale profile. */
  byScale: Record<ScaleName, number>;
  /** Counts for graded levels 1..4; index 0 is level 1. */
  gradedLevels: [number, number, number, number];
  /** Answers excluded from the graded histogram because another scale gave them. */
  gradedExcluded: number;
  perTier: TierRow[];
  /** Answers that fall outside the current ceiling: retained, not counted. */
  outOfScopeAnswered: number;
}

export interface TierRow {
  /** The selectable ceiling this row belongs to. */
  ceiling: number;
  total: number;
  answered: number;
  rated: number;
  known: number;
  partial: number;
  unknown: number;
  seen: number;
}

/** The five ceilings the settings page offers, in ascending order. */
export const TIER_CEILINGS = [35, 50, 60, 70, 80] as const;

function ceilingFor(tier: number): number {
  for (const ceiling of TIER_CEILINGS) if (tier <= ceiling) return ceiling;
  return TIER_CEILINGS[TIER_CEILINGS.length - 1];
}

export function coverage(rating: Uint8Array, tiers: Uint8Array, tierMax: number): CoverageStats {
  const bands: Record<Band, number> = { unanswered: 0, seen: 0, unknown: 0, partial: 0, known: 0 };
  const byScale: Record<ScaleName, number> = { seen: 0, binary: 0, graded: 0 };
  const gradedLevels: [number, number, number, number] = [0, 0, 0, 0];
  const rows = new Map<number, TierRow>();
  for (const ceiling of TIER_CEILINGS) {
    rows.set(ceiling, {
      ceiling, total: 0, answered: 0, rated: 0, known: 0, partial: 0, unknown: 0, seen: 0,
    });
  }

  let total = 0;
  let gradedExcluded = 0;
  let outOfScopeAnswered = 0;

  for (let i = 0; i < rating.length; i++) {
    const byte = rating[i];
    if (tiers[i] > tierMax) {
      if (byte !== 0) outOfScopeAnswered++;
      continue;
    }
    total++;
    const band = bandOf(byte);
    bands[band]++;

    const row = rows.get(ceilingFor(tiers[i]))!;
    row.total++;

    if (band === 'unanswered') continue;
    row.answered++;
    const scale = scaleNameOf(byte);
    if (scale) byScale[scale]++;
    if (scale === 'graded') gradedLevels[levelOf(byte) - 1]++;
    else gradedExcluded++;

    if (band === 'seen') row.seen++;
    else {
      row.rated++;
      if (band === 'known') row.known++;
      else if (band === 'partial') row.partial++;
      else row.unknown++;
    }
  }

  return {
    total,
    bands,
    byScale,
    gradedLevels,
    gradedExcluded,
    perTier: [...rows.values()].filter((row) => row.total > 0),
    outOfScopeAnswered,
  };
}

export interface Estimate {
  /** Rated answers only: `seen` is not a knowledge claim and is excluded. */
  rated: number;
  known: number;
  partial: number;
  proportion: number;
  words: number;
  lowWords: number;
  highWords: number;
}

/**
 * Wilson score interval at 95%.
 *
 * Not the normal approximation: with a handful of answers, or a proportion
 * near 0 or 1, the textbook interval runs past the ends of the scale and
 * would report "you know -400 words".
 */
export function wilson(successes: number, trials: number, z = 1.96): [number, number] {
  if (trials <= 0) return [0, 0];
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return [
    Math.max(0, (centre - spread) / denom),
    Math.min(1, (centre + spread) / denom),
  ];
}

/**
 * Extrapolate the sampled knowledge rate to the whole in-scope corpus.
 *
 * `countPartialAsKnown` is a caller decision, never a default: "heard of" is
 * its own band everywhere in this app, and the coverage page shows both
 * figures side by side rather than picking one.
 */
export function estimate(stats: CoverageStats, countPartialAsKnown: boolean): Estimate {
  const rated = stats.bands.unknown + stats.bands.partial + stats.bands.known;
  const known = stats.bands.known + (countPartialAsKnown ? stats.bands.partial : 0);
  const proportion = rated > 0 ? known / rated : 0;
  const [lo, hi] = wilson(known, rated);
  return {
    rated,
    known: stats.bands.known,
    partial: stats.bands.partial,
    proportion,
    words: proportion * stats.total,
    lowWords: lo * stats.total,
    highWords: hi * stats.total,
  };
}

export interface TimingStats {
  count: number;
  censored: number;
  peekedExcluded: number;
  mean: number;
  sd: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
  slowestId: number;
  totalMs: number;
  /** Log-spaced buckets for the histogram: [upperBoundMs, count]. */
  buckets: Array<{ upto: number; count: number }>;
}

const BUCKET_BOUNDS = [250, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 15000, 30000, 65535];

export interface TimingInput {
  rating: Uint8Array;
  durMs: Uint16Array;
  flags: Uint8Array;
  tiers: Uint8Array;
  tierMax: number;
  excludePeeked: boolean;
}

export function timing(input: TimingInput): TimingStats {
  const { rating, durMs, flags, tiers, tierMax, excludePeeked } = input;
  const hist = new Uint32Array(65536);
  let count = 0;
  let censored = 0;
  let peekedExcluded = 0;
  let totalMs = 0;
  let sumSq = 0;
  let min = DUR_CENSORED;
  let max = 0;
  let slowestId = -1;

  for (let i = 0; i < rating.length; i++) {
    if (rating[i] === 0) continue;
    if (tiers[i] > tierMax) continue;
    const d = durMs[i];
    // 65535 means "at least this long" - a word left on screen while the user
    // walked away. Counting it as 65.5 seconds would poison every average, so
    // it is reported separately and excluded from the moments.
    if (d === DUR_CENSORED) { censored++; continue; }
    if (excludePeeked && (flags[i] & FLAG_PEEKED)) { peekedExcluded++; continue; }
    hist[d]++;
    count++;
    totalMs += d;
    sumSq += d * d;
    if (d < min) min = d;
    if (d > max) { max = d; slowestId = i; }
  }

  if (count === 0) {
    return {
      count: 0, censored, peekedExcluded, mean: 0, sd: 0, median: 0, p10: 0, p90: 0,
      min: 0, max: 0, slowestId: -1, totalMs: 0,
      buckets: BUCKET_BOUNDS.map((upto) => ({ upto, count: 0 })),
    };
  }

  const mean = totalMs / count;
  const variance = Math.max(0, sumSq / count - mean * mean);

  const quantile = (q: number) => {
    const target = q * count;
    let seen = 0;
    for (let v = 0; v < hist.length; v++) {
      seen += hist[v];
      if (seen >= target) return v;
    }
    return max;
  };

  const buckets = BUCKET_BOUNDS.map((upto) => ({ upto, count: 0 }));
  let bucket = 0;
  let running = 0;
  for (let v = 0; v < hist.length; v++) {
    if (hist[v] === 0) continue;
    while (bucket < buckets.length - 1 && v > buckets[bucket].upto) {
      buckets[bucket].count = running;
      running = 0;
      bucket++;
    }
    running += hist[v];
  }
  buckets[bucket].count += running;

  return {
    count,
    censored,
    peekedExcluded,
    mean,
    sd: Math.sqrt(variance),
    median: quantile(0.5),
    p10: quantile(0.1),
    p90: quantile(0.9),
    min: min === DUR_CENSORED ? 0 : min,
    max,
    slowestId,
    totalMs,
    buckets,
  };
}

export interface DayCount { day: string; count: number; }

/**
 * Answers per calendar day over the trailing window, in *local* days - the
 * user's sense of "yesterday" is local, and a UTC bucket would split an
 * evening session in two for anyone west of Greenwich.
 */
export function paceByDay(answeredAt: Uint32Array, days: number): DayCount[] {
  const counts = new Map<string, number>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const oldest = today.getTime() - (days - 1) * 86_400_000;

  for (let i = 0; i < answeredAt.length; i++) {
    const minutes = answeredAt[i];
    if (minutes === 0) continue;
    const ms = fromEpochMinutes(minutes);
    if (ms < oldest) continue;
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const out: DayCount[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(oldest + i * 86_400_000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ day: key, count: counts.get(key) ?? 0 });
  }
  return out;
}

export interface Projection {
  label: string;
  /** Milliseconds per word this projection assumes. */
  msPerWord: number;
  remaining: number;
  totalMs: number;
  /** Calendar completion date, or null when the rate is zero. */
  date: Date | null;
  note: string;
}

/**
 * Every projection states the rate it assumes, because they disagree wildly
 * and a single unlabelled "finishes in 4 years" is not information.
 */
export function projections(input: {
  remaining: number;
  overallMeanMs: number;
  recentMeanMs: number;
  dailyMinutes: number;
  observedPerDay: number;
}): Projection[] {
  const { remaining, overallMeanMs, recentMeanMs, dailyMinutes, observedPerDay } = input;
  const out: Projection[] = [];
  const dayMs = 86_400_000;

  const atRate = (label: string, msPerWord: number, note: string) => {
    const totalMs = remaining * msPerWord;
    const perDayMs = dailyMinutes * 60_000;
    const date = msPerWord > 0 && perDayMs > 0
      ? new Date(Date.now() + Math.ceil(totalMs / perDayMs) * dayMs)
      : null;
    out.push({ label, msPerWord, remaining, totalMs, date, note });
  };

  atRate('all-time pace', overallMeanMs,
    `mean of every timed answer, ${dailyMinutes} min/day`);
  if (recentMeanMs > 0) {
    atRate('recent pace', recentMeanMs,
      `mean of the last 200 answers, ${dailyMinutes} min/day`);
  }

  if (observedPerDay > 0) {
    const days = Math.ceil(remaining / observedPerDay);
    out.push({
      label: 'observed pace',
      msPerWord: 0,
      remaining,
      totalMs: 0,
      date: new Date(Date.now() + days * dayMs),
      note: `${Math.round(observedPerDay)} words/day, measured over the last 14 days`,
    });
  }
  return out;
}
