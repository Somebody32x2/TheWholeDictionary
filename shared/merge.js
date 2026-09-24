/**
 * Element-wise snapshot merge.
 *
 * The whole sync design rests on this being a commutative, associative,
 * idempotent join: because the outcome for word `i` depends only on the two
 * values at `i` and not on any shared history, there is no base revision to
 * track, no ordering requirement between devices, and no conflict that could
 * ever need a dialog. Push and pull are the same operation from either side,
 * and running it twice changes nothing.
 *
 * That is why the server can merge a stale `X-Base-Rev` write instead of
 * refusing it with a 409 - a late arrival cannot undo anything.
 */

/** @typedef {import('./container.js').Snapshot} Snapshot */

import { normaliseSettings, SETTING_KEYS } from './container.js';
import { canonicalLists, mergeLists } from './lists.js';

/**
 * @param {Snapshot} a
 * @param {Snapshot} b
 * @returns {{state: Snapshot, changedFromA: number, changedFromB: number}}
 */
export function mergeSnapshots(a, b) {
  if (a.wordCount !== b.wordCount) {
    throw new Error(`mergeSnapshots: wordCount mismatch ${a.wordCount} vs ${b.wordCount}`);
  }
  if (a.corpusVersion && b.corpusVersion && a.corpusVersion !== b.corpusVersion) {
    throw new Error('mergeSnapshots: corpusVersion mismatch');
  }

  const n = a.wordCount;
  const rating = new Uint8Array(n);
  const answeredAt = new Uint32Array(n);
  const durMs = new Uint16Array(n);
  const flags = new Uint8Array(n);

  const ar = a.rating, br = b.rating;
  const aa = a.answeredAt, ba = b.answeredAt;
  const ad = a.durMs, bd = b.durMs;
  const af = a.flags, bf = b.flags;

  let changedFromA = 0;
  let changedFromB = 0;

  for (let i = 0; i < n; i++) {
    const at = aa[i], bt = ba[i];
    let r, t, d;
    if (at > bt) {
      r = ar[i]; t = at; d = ad[i];
    } else if (bt > at) {
      r = br[i]; t = bt; d = bd[i];
    } else if (ar[i] !== br[i]) {
      // Same minute, different answer: the larger byte wins. Arbitrary but
      // symmetric, which is the only property that matters here.
      const takeA = ar[i] > br[i];
      r = takeA ? ar[i] : br[i]; t = at; d = takeA ? ad[i] : bd[i];
    } else {
      r = ar[i]; t = at; d = ad[i] >= bd[i] ? ad[i] : bd[i];
    }
    // Flags are monotonic facts about a word - it was peeked at, it was revised
    // - so they union rather than being carried by the winning side.
    const f = af[i] | bf[i];

    rating[i] = r; answeredAt[i] = t; durMs[i] = d; flags[i] = f;

    if (r !== ar[i] || t !== at || d !== ad[i] || f !== af[i]) changedFromA++;
    if (r !== br[i] || t !== bt || d !== bd[i] || f !== bf[i]) changedFromB++;
  }

  const { settings, settingsAt } = mergeSettings(a, b);

  // Lists join by the same rules (see shared/lists.js). A change to them is
  // folded into the change counts so every caller that asks "did the merge
  // add anything" - the server's skip-the-write shortcut, the client's
  // push-back - sees list edits as well as answers.
  const lists = mergeLists(a.lists ?? [], b.lists ?? []);
  const listsKey = canonicalLists(lists);
  if (listsKey !== canonicalLists(a.lists ?? [])) changedFromA++;
  if (listsKey !== canonicalLists(b.lists ?? [])) changedFromB++;

  /** @type {Snapshot} */
  const state = {
    corpusVersion: a.corpusVersion || b.corpusVersion,
    wordCount: n,
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    settings,
    settingsAt,
    cursor: {
      alphabetical: Math.max(a.cursor?.alphabetical ?? 0, b.cursor?.alphabetical ?? 0),
      random: Math.max(a.cursor?.random ?? 0, b.cursor?.random ?? 0),
    },
    rating,
    answeredAt,
    durMs,
    flags,
    lists,
  };
  return { state, changedFromA, changedFromB };
}

/**
 * Per-key last-write-wins over the `settingsAt` stamps.
 *
 * A key the remote side never stamped loses to a locally-changed one even
 * though both sides hold a value, which is the "silence is not a change" rule:
 * only a key someone actually moved can move the result.
 *
 * @param {Snapshot} a
 * @param {Snapshot} b
 * @returns {{settings: Record<string, unknown>, settingsAt: Record<string, number>}}
 */
export function mergeSettings(a, b) {
  const sa = normaliseSettings(a.settings);
  const sb = normaliseSettings(b.settings);
  const ta = a.settingsAt ?? {};
  const tb = b.settingsAt ?? {};
  const aWinsTies = (a.updatedAt || 0) >= (b.updatedAt || 0);

  /** @type {Record<string, unknown>} */
  const settings = {};
  /** @type {Record<string, number>} */
  const settingsAt = {};

  for (const key of SETTING_KEYS) {
    const stampA = Number(ta[key]) || 0;
    const stampB = Number(tb[key]) || 0;
    let takeA;
    if (stampA > stampB) takeA = true;
    else if (stampB > stampA) takeA = false;
    else takeA = aWinsTies;
    settings[key] = takeA ? sa[key] : sb[key];
    const stamp = Math.max(stampA, stampB);
    if (stamp > 0) settingsAt[key] = stamp;
  }
  return { settings: normaliseSettings(settings), settingsAt };
}

/**
 * True when the two snapshots are element-wise identical. Used by the client to
 * decide whether a pull actually needs persisting and whether a merge result
 * has to be pushed back.
 *
 * @param {Snapshot} a
 * @param {Snapshot} b
 */
export function snapshotsEqual(a, b) {
  if (a.wordCount !== b.wordCount) return false;
  const n = a.wordCount;
  for (let i = 0; i < n; i++) {
    if (a.rating[i] !== b.rating[i]) return false;
    if (a.answeredAt[i] !== b.answeredAt[i]) return false;
    if (a.durMs[i] !== b.durMs[i]) return false;
    if (a.flags[i] !== b.flags[i]) return false;
  }
  return true;
}
