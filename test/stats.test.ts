/**
 * Stats contracts.
 *
 * The load-bearing one is that "heard of" is never folded into "know" or
 * "don't know", and that "seen" is kept out of every knowledge ratio. Those
 * are product decisions that a later refactor could silently undo, and the
 * only symptom would be a vocabulary number that is quietly wrong.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { coverage, estimate, paceByDay, projections, timing, wilson } from '../client/src/lib/stats';
import {
  DUR_CENSORED,
  FLAG_PEEKED,
  encodeRating,
  toEpochMinutes,
  SCALE_BINARY,
  SCALE_GRADED,
  SCALE_SEEN,
} from '../shared/scales.js';

const N = 100;

function fixture() {
  const rating = new Uint8Array(N);
  const tiers = new Uint8Array(N).fill(35);
  // 10 known, 5 don't-know, 3 heard-of, 4 seen; the rest unanswered.
  for (let i = 0; i < 10; i++) rating[i] = encodeRating(SCALE_BINARY, 2);
  for (let i = 10; i < 15; i++) rating[i] = encodeRating(SCALE_BINARY, 1);
  for (let i = 15; i < 18; i++) rating[i] = encodeRating(SCALE_GRADED, 2);
  for (let i = 18; i < 22; i++) rating[i] = encodeRating(SCALE_SEEN, 1);
  return { rating, tiers };
}

test('"heard of" is its own band and never folded into a neighbour', () => {
  const { rating, tiers } = fixture();
  const stats = coverage(rating, tiers, 80);

  assert.equal(stats.bands.known, 10);
  assert.equal(stats.bands.unknown, 5);
  assert.equal(stats.bands.partial, 3);
  assert.equal(stats.bands.seen, 4);
  assert.equal(stats.bands.unanswered, N - 22);
  assert.equal(stats.total, N);
});

test('"seen" is excluded from the knowledge ratio', () => {
  const { rating, tiers } = fixture();
  const stats = coverage(rating, tiers, 80);

  const strict = estimate(stats, false);
  // 18 rated (10 + 5 + 3), not 22: the four "seen" answers claim nothing.
  assert.equal(strict.rated, 18);
  assert.equal(strict.proportion, 10 / 18);

  const generous = estimate(stats, true);
  assert.equal(generous.proportion, 13 / 18);
  assert.ok(generous.words > strict.words, 'counting "heard of" must raise the figure');
});

test('the answer provenance table separates the scales', () => {
  const { rating, tiers } = fixture();
  const stats = coverage(rating, tiers, 80);
  assert.deepEqual(stats.byScale, { seen: 4, binary: 15, graded: 3 });
  assert.deepEqual(stats.gradedLevels, [0, 3, 0, 0]);
  assert.equal(stats.gradedExcluded, 19, 'answers from other scales are named, not hidden');
});

test('answers outside the tier ceiling are retained but not counted', () => {
  const { rating, tiers } = fixture();
  tiers.fill(80, 0, 5);            // five of the "known" answers move out of scope
  const stats = coverage(rating, tiers, 70);

  assert.equal(stats.total, N - 5);
  assert.equal(stats.bands.known, 5);
  assert.equal(stats.outOfScopeAnswered, 5, 'the answers still exist, they are just out of scope');
});

test('the Wilson interval stays inside [0,1] at the extremes', () => {
  const [lo, hi] = wilson(0, 3);
  assert.equal(lo, 0);
  assert.ok(hi > 0 && hi < 1);
  const [lo2, hi2] = wilson(3, 3);
  assert.ok(lo2 > 0 && lo2 < 1);
  assert.equal(hi2, 1);
  assert.deepEqual(wilson(0, 0), [0, 0]);
});

test('censored response times are counted separately, never averaged in', () => {
  const rating = new Uint8Array(4).fill(encodeRating(SCALE_BINARY, 2));
  const durMs = Uint16Array.from([1000, 2000, 3000, DUR_CENSORED]);
  const flags = new Uint8Array(4);
  const tiers = new Uint8Array(4).fill(35);

  const stats = timing({ rating, durMs, flags, tiers, tierMax: 80, excludePeeked: true });
  assert.equal(stats.count, 3);
  assert.equal(stats.censored, 1);
  assert.equal(stats.mean, 2000, 'a 65 s sentinel would drag this to 17 seconds');
  assert.equal(stats.max, 3000);
  assert.equal(stats.slowestId, 2);
  assert.equal(stats.totalMs, 6000);
});

test('order statistics come out of the histogram correctly', () => {
  const size = 1000;
  const rating = new Uint8Array(size).fill(encodeRating(SCALE_BINARY, 2));
  const durMs = new Uint16Array(size);
  for (let i = 0; i < size; i++) durMs[i] = i + 1;   // 1..1000 ms
  const stats = timing({
    rating, durMs, flags: new Uint8Array(size),
    tiers: new Uint8Array(size).fill(35), tierMax: 80, excludePeeked: true,
  });

  assert.equal(stats.median, 500);
  assert.equal(stats.p10, 100);
  assert.equal(stats.p90, 900);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 1000);
  assert.ok(Math.abs(stats.mean - 500.5) < 0.01);
  assert.ok(Math.abs(stats.sd - 288.67) < 0.5);
  assert.equal(stats.buckets.reduce((sum, b) => sum + b.count, 0), size);
});

test('peeked answers are excluded on request and counted when included', () => {
  const rating = new Uint8Array(2).fill(encodeRating(SCALE_BINARY, 2));
  const durMs = Uint16Array.from([1000, 9000]);
  const flags = Uint8Array.from([0, FLAG_PEEKED]);
  const tiers = new Uint8Array(2).fill(35);

  const excluded = timing({ rating, durMs, flags, tiers, tierMax: 80, excludePeeked: true });
  assert.equal(excluded.count, 1);
  assert.equal(excluded.peekedExcluded, 1);
  assert.equal(excluded.mean, 1000);

  const included = timing({ rating, durMs, flags, tiers, tierMax: 80, excludePeeked: false });
  assert.equal(included.count, 2);
  assert.equal(included.mean, 5000);
});

test('pace buckets answers into local calendar days', () => {
  const answeredAt = new Uint32Array(5);
  const now = toEpochMinutes();
  answeredAt[0] = now;
  answeredAt[1] = now;
  answeredAt[2] = now - 24 * 60;              // yesterday
  answeredAt[3] = now - 40 * 24 * 60;         // outside the window
  // index 4 stays 0: never answered

  const days = paceByDay(answeredAt, 14);
  assert.equal(days.length, 14);
  assert.equal(days[days.length - 1].count, 2, 'today');
  assert.equal(days[days.length - 2].count, 1, 'yesterday');
  assert.equal(days.reduce((sum, d) => sum + d.count, 0), 3, 'old and unanswered are excluded');
});

test('every projection names the rate it assumes', () => {
  const rows = projections({
    remaining: 1000,
    overallMeanMs: 2000,
    recentMeanMs: 1000,
    dailyMinutes: 15,
    observedPerDay: 50,
  });
  assert.deepEqual(rows.map((r) => r.label), ['all-time pace', 'recent pace', 'observed pace']);
  for (const row of rows) assert.ok(row.note.length > 0, `${row.label} has no stated assumption`);

  const [allTime, recent] = rows;
  assert.ok(
    recent.date!.getTime() < allTime.date!.getTime(),
    'a faster recent pace must finish sooner',
  );
  // 1000 words * 2 s = 2000 s of work at 15 min/day is 3 days.
  assert.equal(Math.round((allTime.date!.getTime() - Date.now()) / 86_400_000), 3);
});
