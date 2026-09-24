/**
 * Saved word lists, including the built-in "Starred" list.
 *
 * Lists live in the synced snapshot, so they need the same property as the
 * answer arrays: a merge that is commutative, associative and idempotent, so
 * two devices can edit the same list offline and meet without a conflict.
 *
 * Membership is therefore not a set but a map of signed timestamps:
 *
 *   items[word] =  t   the word was added at epoch-ms t
 *   items[word] = -t   the word was removed at epoch-ms t
 *
 * and the merge keeps whichever event is later. A plain union would make
 * removal impossible - an unstarred word would come straight back from any
 * device that still had it - and a plain intersection would lose additions.
 * Ties resolve to "present", which is arbitrary but symmetric.
 *
 * Words are stored as headwords, not corpus ids. A list then survives a
 * corpus rebuild without migration, and a published list is readable by
 * someone whose device has not downloaded the headword index.
 */

export const STARRED_ID = 'starred';
export const STARRED_NAME = 'Starred';

export const MAX_LISTS = 200;
export const MAX_LIST_NAME = 80;
export const MAX_LIST_ITEMS = 20_000;
export const LIST_ID_RE = /^[a-z0-9]{1,24}$/;
export const LIST_WORD_RE = /^[a-z][a-z'-]{0,39}$/;

/**
 * @typedef {object} WordList
 * @property {string} id
 * @property {string} name
 * @property {number} nameAt        epoch ms of the last rename
 * @property {number} createdAt     epoch ms
 * @property {number} deletedAt     epoch ms tombstone, 0 when live
 * @property {string} published     share code, '' when not published
 * @property {number} publishedAt   epoch ms of the last publish/unpublish
 * @property {Record<string, number>} items  word -> signed epoch ms
 */

/** @param {string} value */
function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LIST_NAME);
}

const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/**
 * Coerce untrusted input into valid lists. Runs on every decode, so a
 * hand-edited export or a hostile upload cannot put an oversized name, a
 * non-word, or a million entries into another device's state.
 *
 * @param {unknown} raw
 * @returns {WordList[]}
 */
export function normaliseLists(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Map<string, WordList>} */
  const byId = new Map();
  for (const entry of raw.slice(0, MAX_LISTS * 2)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id ?? '');
    if (!LIST_ID_RE.test(id)) continue;
    /** @type {Record<string, number>} */
    const items = {};
    let count = 0;
    if (entry.items && typeof entry.items === 'object') {
      for (const [word, stamp] of Object.entries(entry.items)) {
        if (count >= MAX_LIST_ITEMS) break;
        if (!LIST_WORD_RE.test(word)) continue;
        const t = num(stamp);
        if (t === 0) continue;
        items[word] = t;
        count++;
      }
    }
    const list = {
      id,
      name: id === STARRED_ID ? STARRED_NAME : (cleanName(entry.name) || 'Untitled'),
      nameAt: Math.max(0, num(entry.nameAt)),
      createdAt: Math.max(0, num(entry.createdAt)),
      deletedAt: id === STARRED_ID ? 0 : Math.max(0, num(entry.deletedAt)),
      published: /^[a-z0-9]{10}$/.test(String(entry.published ?? '')) ? String(entry.published) : '',
      publishedAt: Math.max(0, num(entry.publishedAt)),
      items,
    };
    // Duplicate ids inside one payload are merged rather than trusted in order.
    const prev = byId.get(id);
    byId.set(id, prev ? mergeList(prev, list) : list);
    if (byId.size >= MAX_LISTS) break;
  }
  return [...byId.values()];
}

/** The later event wins; a tie goes to "present". Total order, so the merge is a join. */
function mergeStamp(a, b) {
  const aa = Math.abs(a);
  const ab = Math.abs(b);
  if (aa !== ab) return aa > ab ? a : b;
  return a >= b ? a : b;
}

/**
 * @param {WordList} a
 * @param {WordList} b
 * @returns {WordList}
 */
export function mergeList(a, b) {
  /** @type {string} */
  let name;
  if (a.nameAt !== b.nameAt) name = a.nameAt > b.nameAt ? a.name : b.name;
  else name = a.name >= b.name ? a.name : b.name;

  let published;
  let publishedAt;
  if (a.publishedAt !== b.publishedAt) {
    const winner = a.publishedAt > b.publishedAt ? a : b;
    published = winner.published;
    publishedAt = winner.publishedAt;
  } else {
    published = a.published >= b.published ? a.published : b.published;
    publishedAt = a.publishedAt;
  }

  const deletedAt = Math.max(a.deletedAt, b.deletedAt);

  /** @type {Record<string, number>} */
  const items = {};
  // A deleted list keeps its tombstone but not its contents: nothing will
  // ever display them again, and carrying them forever is pure growth.
  if (deletedAt === 0) {
    for (const [word, t] of Object.entries(a.items)) items[word] = t;
    for (const [word, t] of Object.entries(b.items)) {
      items[word] = word in items ? mergeStamp(items[word], t) : t;
    }
  }

  return {
    id: a.id,
    name,
    nameAt: Math.max(a.nameAt, b.nameAt),
    createdAt: Math.min(a.createdAt || b.createdAt, b.createdAt || a.createdAt),
    deletedAt,
    published,
    publishedAt,
    items,
  };
}

/**
 * @param {WordList[]} a
 * @param {WordList[]} b
 * @returns {WordList[]}
 */
export function mergeLists(a, b) {
  /** @type {Map<string, WordList>} */
  const byId = new Map();
  for (const list of a) byId.set(list.id, list);
  for (const list of b) {
    const prev = byId.get(list.id);
    byId.set(list.id, prev ? mergeList(prev, list) : list);
  }
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** Order-independent serialisation, for "did anything change" checks. */
export function canonicalLists(lists) {
  return JSON.stringify([...lists]
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((list) => ({
      ...list,
      items: Object.fromEntries(Object.entries(list.items).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
    })));
}

/** @param {WordList} list */
export function listWords(list) {
  return Object.entries(list.items)
    .filter(([, t]) => t > 0)
    .sort(([, x], [, y]) => x - y)
    .map(([word]) => word);
}

/** @param {WordList} list @param {string} word */
export function hasWord(list, word) {
  return (list.items[word] ?? 0) > 0;
}

/** Latest edit to membership, for "has this changed since it was published". */
export function lastEdit(list) {
  let latest = Math.max(list.nameAt, list.createdAt);
  for (const t of Object.values(list.items)) latest = Math.max(latest, Math.abs(t));
  return latest;
}

/**
 * Stamps must strictly increase per word even when two edits land in the same
 * millisecond (a double-tap on the star), or the second would tie with the
 * first and "present" would win the tie regardless of what was pressed last.
 *
 * @param {WordList} list @param {string} word @param {number} now
 */
function nextStamp(list, word, now) {
  const prev = Math.abs(list.items[word] ?? 0);
  return Math.max(now, prev + 1);
}

/** @param {WordList} list @param {string} word @param {number} [now] */
export function withWord(list, word, now = Date.now()) {
  return { ...list, items: { ...list.items, [word]: nextStamp(list, word, now) } };
}

/** @param {WordList} list @param {string} word @param {number} [now] */
export function withoutWord(list, word, now = Date.now()) {
  if (!(word in list.items)) return list;
  return { ...list, items: { ...list.items, [word]: -nextStamp(list, word, now) } };
}

/** @param {string} id @param {string} name @param {number} [now] @returns {WordList} */
export function newList(id, name, now = Date.now()) {
  return {
    id,
    name: id === STARRED_ID ? STARRED_NAME : (cleanName(name) || 'Untitled'),
    nameAt: now,
    createdAt: now,
    deletedAt: 0,
    published: '',
    publishedAt: 0,
    items: {},
  };
}

export { cleanName as cleanListName };
