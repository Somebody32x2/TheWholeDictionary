/**
 * Saved-list contracts.
 *
 * The merge has to be a join for the same reason the answer merge does: two
 * devices edit a list offline and meet in either order, and neither order may
 * lose an edit. Removal is the part a naive design gets wrong - a set union
 * resurrects every unstarred word - so it is tested from both directions.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  canonicalLists,
  hasWord,
  listWords,
  mergeLists,
  newList,
  normaliseLists,
  STARRED_ID,
  withoutWord,
  withWord,
  type WordList,
} from '../shared/lists.js';
import { decodeSnapshot, emptySnapshot, encodeSnapshot } from '../shared/container.js';
import { mergeSnapshots } from '../shared/merge.js';

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

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

/** A device's view after a random sequence of edits to two shared lists. */
function randomDevice(seed: number): WordList[] {
  const rnd = mulberry32(seed);
  let lists = [newList(STARRED_ID, '', 1000), newList('shared1', 'Shared', 1000)];
  let clock = 1000 + Math.floor(rnd() * 50);
  for (let i = 0; i < 40; i++) {
    clock += Math.floor(rnd() * 3); // coarse, so equal stamps happen
    const which = rnd() < 0.5 ? 0 : 1;
    const word = WORDS[Math.floor(rnd() * WORDS.length)];
    const list = lists[which];
    lists = lists.map((l, j) => (j !== which ? l
      : rnd() < 0.6 ? withWord(list, word, clock) : withoutWord(list, word, clock)));
    if (rnd() < 0.05) {
      lists = lists.map((l, j) => (j === 1 ? { ...l, name: `Renamed ${seed}`, nameAt: clock } : l));
    }
  }
  return normaliseLists(lists);
}

test('list merge is commutative, associative and idempotent', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const a = randomDevice(seed);
    const b = randomDevice(seed + 100);
    const c = randomDevice(seed + 200);
    assert.equal(canonicalLists(mergeLists(a, b)), canonicalLists(mergeLists(b, a)), `seed ${seed}: order mattered`);
    assert.equal(
      canonicalLists(mergeLists(mergeLists(a, b), c)),
      canonicalLists(mergeLists(a, mergeLists(b, c))),
      `seed ${seed}: grouping mattered`,
    );
    const ab = mergeLists(a, b);
    assert.equal(canonicalLists(mergeLists(ab, a)), canonicalLists(ab), `seed ${seed}: not idempotent`);
  }
});

test('a later removal beats an earlier add from another device', () => {
  const base = newList(STARRED_ID, '', 1);
  const deviceA = withWord(base, 'serendipity', 100);           // starred on A
  const deviceB = withoutWord(withWord(base, 'serendipity', 100), 'serendipity', 200); // unstarred on B later
  const [merged] = mergeLists([deviceA], [deviceB]);
  assert.equal(hasWord(merged, 'serendipity'), false, 'an unstar must not be undone by a union');
});

test('a later add beats an earlier removal', () => {
  const base = newList('mine', 'Mine', 1);
  const removed = withoutWord(withWord(base, 'quixotic', 100), 'quixotic', 150);
  const readded = withWord(base, 'quixotic', 300);
  const [merged] = mergeLists([removed], [readded]);
  assert.equal(hasWord(merged, 'quixotic'), true);
});

test('toggling twice in the same millisecond still records the last toggle', () => {
  const base = newList(STARRED_ID, '', 1);
  const on = withWord(base, 'abate', 500);
  const off = withoutWord(on, 'abate', 500);          // same clock reading
  assert.equal(hasWord(off, 'abate'), false);
  const [merged] = mergeLists([on], [off]);
  assert.equal(hasWord(merged, 'abate'), false, 'the second toggle must win the merge, not tie with the first');
});

test('rename is last-writer-wins and deletion is a tombstone', () => {
  const base = newList('trip', 'Trip', 1);
  const renamedEarly = { ...base, name: 'Early', nameAt: 10 };
  const renamedLate = { ...base, name: 'Late', nameAt: 20 };
  assert.equal(mergeLists([renamedLate], [renamedEarly])[0].name, 'Late');

  const deleted = { ...withWord(base, 'alpha', 5), deletedAt: 30 };
  const stillEditing = withWord(base, 'bravo', 40);  // another device kept adding
  const [merged] = mergeLists([deleted], [stillEditing]);
  assert.ok(merged.deletedAt > 0, 'deleted on one device stays deleted');
  assert.deepEqual(listWords(merged), [], 'a tombstone carries no contents');
});

test('the starred list cannot be renamed or deleted', () => {
  const [starred] = normaliseLists([{ ...newList(STARRED_ID, '', 1), name: 'Hijacked', deletedAt: 99 }]);
  assert.equal(starred.name, 'Starred');
  assert.equal(starred.deletedAt, 0);
});

test('normalisation drops non-words, bad ids and oversized names', () => {
  const lists = normaliseLists([
    { id: 'Bad Id!', name: 'x', items: { alpha: 1 } },
    { id: 'ok1', name: 'y'.repeat(500), items: { alpha: 5, '<script>': 6, Bravo: 7, ['x'.repeat(80)]: 8 } },
  ]);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].name.length, 80);
  assert.deepEqual(Object.keys(lists[0].items), ['alpha']);
});

test('lists round-trip through the snapshot container', () => {
  const s = emptySnapshot('v1', 10);
  s.lists = [withWord(withWord(newList(STARRED_ID, '', 1), 'alpha', 2), 'bravo', 3), withWord(newList('abc', 'Mine', 4), 'echo', 5)];
  const back = decodeSnapshot(encodeSnapshot(s));
  assert.equal(canonicalLists(back.lists), canonicalLists(s.lists));
});

test('a snapshot written before lists existed still decodes', () => {
  const s = emptySnapshot('v1', 10);
  s.rating[3] = 0x22;
  const bytes = encodeSnapshot(s);
  // Strip the trailing lists section to reproduce the older layout exactly.
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const listsLen = dv.getUint32(bytes.length - 2 - 4, true); // "[]" is 2 bytes
  assert.equal(listsLen, 2);
  const legacy = bytes.slice(0, bytes.length - 6);
  const back = decodeSnapshot(legacy);
  assert.deepEqual(back.lists, []);
  assert.equal(back.rating[3], 0x22);
});

test('snapshot merge carries list edits and counts them as changes', () => {
  const a = emptySnapshot('v1', 4);
  const b = emptySnapshot('v1', 4);
  a.lists = [withWord(newList(STARRED_ID, '', 1), 'alpha', 10)];
  b.lists = [withWord(newList(STARRED_ID, '', 1), 'bravo', 20)];
  const { state, changedFromA, changedFromB } = mergeSnapshots(a, b);
  assert.deepEqual(listWords(state.lists[0]), ['alpha', 'bravo']);
  assert.ok(changedFromA > 0, 'A gained a word from B');
  assert.ok(changedFromB > 0, 'B gained a word from A');
  assert.equal(mergeSnapshots(state, state).changedFromA, 0);
});
