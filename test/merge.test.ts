/**
 * Merge algebra. Sync correctness is exactly these properties: if the merge is
 * commutative and idempotent then push order between devices cannot matter and
 * a replayed request cannot corrupt anything, which is why the server is
 * allowed to accept a stale X-Base-Rev instead of refusing it.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { emptySnapshot, type Snapshot } from '../shared/container.js';
import { mergeSettings, mergeSnapshots, snapshotsEqual } from '../shared/merge.js';
import { encodeRating, FLAG_PEEKED, FLAG_REVISED, SCALE_BINARY, SCALE_GRADED } from '../shared/scales.js';

const N = 512;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSnapshot(seed: number, fill = 0.4): Snapshot {
  const rnd = mulberry32(seed);
  const s = emptySnapshot('v1', N);
  s.updatedAt = 1_700_000_000_000 + Math.floor(rnd() * 1_000_000);
  for (let i = 0; i < N; i++) {
    if (rnd() > fill) continue;
    const graded = rnd() < 0.5;
    s.rating[i] = graded
      ? encodeRating(SCALE_GRADED, 1 + Math.floor(rnd() * 4))
      : encodeRating(SCALE_BINARY, 1 + Math.floor(rnd() * 2));
    // Deliberately coarse so exact answeredAt ties happen often.
    s.answeredAt[i] = 100 + Math.floor(rnd() * 20);
    s.durMs[i] = Math.floor(rnd() * 65536);
    s.flags[i] = Math.floor(rnd() * 4);
  }
  return s;
}

test('merge is commutative for randomised inputs', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const a = randomSnapshot(seed);
    const b = randomSnapshot(seed + 1000);
    const ab = mergeSnapshots(a, b).state;
    const ba = mergeSnapshots(b, a).state;
    assert.ok(snapshotsEqual(ab, ba), `seed ${seed}: merge order changed the result`);
  }
});

test('merge is associative for randomised inputs', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const a = randomSnapshot(seed);
    const b = randomSnapshot(seed + 100);
    const c = randomSnapshot(seed + 200);
    const left = mergeSnapshots(mergeSnapshots(a, b).state, c).state;
    const right = mergeSnapshots(a, mergeSnapshots(b, c).state).state;
    assert.ok(snapshotsEqual(left, right), `seed ${seed}: grouping changed the result`);
  }
});

test('merge is idempotent', () => {
  const a = randomSnapshot(7);
  const b = randomSnapshot(8);
  const m = mergeSnapshots(a, b).state;
  const again = mergeSnapshots(m, a).state;
  assert.ok(snapshotsEqual(m, again));
  assert.equal(mergeSnapshots(m, m).changedFromA, 0);
});

test('answers made on different devices both survive', () => {
  const a = emptySnapshot('v1', N);
  const b = emptySnapshot('v1', N);
  a.rating[5] = encodeRating(SCALE_BINARY, 2);
  a.answeredAt[5] = 500;
  a.durMs[5] = 1200;
  b.rating[400] = encodeRating(SCALE_BINARY, 1);
  b.answeredAt[400] = 600;
  b.durMs[400] = 900;

  const { state, changedFromA, changedFromB } = mergeSnapshots(a, b);
  assert.equal(state.rating[5], encodeRating(SCALE_BINARY, 2));
  assert.equal(state.rating[400], encodeRating(SCALE_BINARY, 1));
  assert.equal(state.durMs[5], 1200);
  assert.equal(state.durMs[400], 900);
  assert.equal(changedFromA, 1);
  assert.equal(changedFromB, 1);
});

test('the later answer wins, and the larger rating byte breaks an exact tie', () => {
  const a = emptySnapshot('v1', N);
  const b = emptySnapshot('v1', N);

  a.rating[1] = encodeRating(SCALE_BINARY, 2);
  a.answeredAt[1] = 100;
  a.durMs[1] = 111;
  b.rating[1] = encodeRating(SCALE_BINARY, 1);
  b.answeredAt[1] = 101;
  b.durMs[1] = 222;

  a.rating[2] = encodeRating(SCALE_BINARY, 1);
  a.answeredAt[2] = 50;
  a.durMs[2] = 333;
  b.rating[2] = encodeRating(SCALE_GRADED, 3);
  b.answeredAt[2] = 50;
  b.durMs[2] = 444;

  const { state } = mergeSnapshots(a, b);
  assert.equal(state.rating[1], encodeRating(SCALE_BINARY, 1));
  assert.equal(state.durMs[1], 222, 'the winning side brings its own duration');
  assert.equal(state.rating[2], encodeRating(SCALE_GRADED, 3));
  assert.equal(state.durMs[2], 444);
});

test('flags union instead of being carried by the winner', () => {
  const a = emptySnapshot('v1', N);
  const b = emptySnapshot('v1', N);
  a.rating[3] = encodeRating(SCALE_BINARY, 1);
  a.answeredAt[3] = 10;
  a.flags[3] = FLAG_PEEKED;
  b.rating[3] = encodeRating(SCALE_BINARY, 2);
  b.answeredAt[3] = 99;
  b.flags[3] = FLAG_REVISED;

  const { state } = mergeSnapshots(a, b);
  assert.equal(state.rating[3], encodeRating(SCALE_BINARY, 2));
  assert.equal(state.flags[3], FLAG_PEEKED | FLAG_REVISED);
});

test('cursors advance to the furthest either device reached', () => {
  const a = emptySnapshot('v1', N);
  const b = emptySnapshot('v1', N);
  a.cursor = { alphabetical: 900, random: 10 };
  b.cursor = { alphabetical: 100, random: 777 };
  const { state } = mergeSnapshots(a, b);
  assert.deepEqual(state.cursor, { alphabetical: 900, random: 777 });
});

test('a corpusVersion mismatch is refused rather than merged', () => {
  const a = emptySnapshot('v1', N);
  const b = emptySnapshot('v2', N);
  assert.throws(() => mergeSnapshots(a, b), /corpusVersion mismatch/);
});

test('settings adopt a remotely-changed key and keep a locally-changed one', () => {
  const a = emptySnapshot('v1', 4, { scale: 'graded', tierMax: 80 });
  const b = emptySnapshot('v1', 4);
  a.settingsAt = { scale: 200, tierMax: 100 };  // local moved `scale` and `tierMax`
  b.settingsAt = { dailyMinutes: 300 };         // remote moved only `dailyMinutes`
  b.settings = { ...b.settings, dailyMinutes: 45 };

  const merged = mergeSettings(a, b);
  assert.equal(merged.settings.scale, 'graded', 'a key only the local side touched must survive');
  assert.equal(merged.settings.tierMax, 80, 'an untouched remote default must not clobber a real change');
  assert.equal(merged.settings.dailyMinutes, 45, 'a key only the remote side touched must be adopted');
  assert.deepEqual(merged.settingsAt, { scale: 200, tierMax: 100, dailyMinutes: 300 });

  const reversed = mergeSettings(b, a);
  assert.deepEqual(reversed.settings, merged.settings, 'settings merge must not depend on argument order');
});

test('the later settings stamp wins when both sides moved a key', () => {
  const a = emptySnapshot('v1', 4, { scale: 'graded' });
  const b = emptySnapshot('v1', 4, { scale: 'seen' });
  a.settingsAt = { scale: 10 };
  b.settingsAt = { scale: 11 };
  assert.equal(mergeSettings(a, b).settings.scale, 'seen');
  assert.equal(mergeSettings(b, a).settings.scale, 'seen');
});
