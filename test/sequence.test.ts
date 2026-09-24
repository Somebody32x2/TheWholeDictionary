/**
 * Sequencing contracts.
 *
 * The two that matter: random order must be a real permutation (nothing
 * skipped, nothing repeated, or the app quietly never shows you some words),
 * and it must stay inside a small window of shards (or the first minute of a
 * random run downloads the entire dictionary).
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  GROUP_SHARDS,
  GROUP_SIZE,
  inScopeCount,
  nextFrom,
  randomIdAt,
  remainingCount,
  upcoming,
  type SequenceInput,
} from '../client/src/lib/sequence';
import { encodeRating, SCALE_BINARY } from '../shared/scales.js';

function input(wordCount: number, over: Partial<SequenceInput> = {}): SequenceInput {
  return {
    wordCount,
    tiers: new Uint8Array(wordCount).fill(35),
    rating: new Uint8Array(wordCount),
    tierMax: 80,
    skipAnswered: true,
    seed: 0xc0ffee,
    ...over,
  };
}

test('random order is a permutation of every id', () => {
  for (const wordCount of [1, 7, GROUP_SIZE, GROUP_SIZE + 1, 20_001]) {
    const seen = new Uint8Array(wordCount);
    for (let p = 0; p < wordCount; p++) {
      const id = randomIdAt(p, wordCount, 12345);
      assert.notEqual(id, null, `position ${p} of ${wordCount} produced nothing`);
      assert.ok(id! >= 0 && id! < wordCount, `id ${id} out of range`);
      assert.equal(seen[id!], 0, `id ${id} repeated at position ${p}`);
      seen[id!] = 1;
    }
    assert.equal(randomIdAt(wordCount, wordCount, 12345), null);
  }
});

test('random order is reproducible from the seed alone', () => {
  const a = Array.from({ length: 300 }, (_, p) => randomIdAt(p, 50_000, 99));
  const b = Array.from({ length: 300 }, (_, p) => randomIdAt(p, 50_000, 99));
  const other = Array.from({ length: 300 }, (_, p) => randomIdAt(p, 50_000, 100));
  assert.deepEqual(a, b, 'same seed must give the same run on another device');
  assert.notDeepEqual(a, other, 'a different seed must give a different run');
});

test('random order stays inside one shard group at a time', () => {
  // This is the whole reason for block shuffling: a flat shuffle would touch
  // a new shard on nearly every word.
  const ids = Array.from({ length: GROUP_SIZE }, (_, p) => randomIdAt(p, 100_000, 7)!);
  const shards = new Set(ids.map((id) => Math.floor(id / 1000)));
  assert.ok(
    shards.size <= GROUP_SHARDS,
    `first ${GROUP_SIZE} words touched ${shards.size} shards, expected at most ${GROUP_SHARDS}`,
  );
});

test('answered words are skipped, and are not when the setting is off', () => {
  const state = input(100);
  state.rating[0] = encodeRating(SCALE_BINARY, 2);
  state.rating[1] = encodeRating(SCALE_BINARY, 1);

  assert.deepEqual(nextFrom(state, 'alphabetical', 0), { position: 2, id: 2 });
  assert.deepEqual(
    nextFrom({ ...state, skipAnswered: false }, 'alphabetical', 0),
    { position: 0, id: 0 },
  );
});

test('the tier ceiling excludes words without deleting their answers', () => {
  const state = input(10);
  state.tiers = Uint8Array.from([35, 80, 35, 80, 35, 35, 80, 35, 35, 35]);
  state.tierMax = 35;
  state.rating[0] = encodeRating(SCALE_BINARY, 2);
  state.rating[1] = encodeRating(SCALE_BINARY, 2);

  assert.deepEqual(nextFrom(state, 'alphabetical', 0), { position: 2, id: 2 });
  assert.equal(inScopeCount(state.tiers, 35), 7);
  assert.equal(remainingCount(state), 6, 'answered id 0 is in scope; id 1 is out of scope');
  // Raising the ceiling brings the out-of-scope answer back into the count.
  assert.equal(remainingCount({ ...state, tierMax: 80 }), 8);
});

test('the sequence reports exhaustion rather than looping', () => {
  const state = input(3);
  state.rating.fill(encodeRating(SCALE_BINARY, 2));
  assert.equal(nextFrom(state, 'alphabetical', 0), null);
  assert.equal(nextFrom(state, 'random', 0), null);
});

test('prefetch looks ahead without filtering', () => {
  const state = input(50);
  state.rating.fill(encodeRating(SCALE_BINARY, 2));
  const ids = upcoming(state, 'alphabetical', 10, 5);
  assert.deepEqual(ids, [10, 11, 12, 13, 14], 'prefetch must warm shards the walk crosses');
});
