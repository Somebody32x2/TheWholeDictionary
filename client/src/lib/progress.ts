/**
 * The profile: four parallel typed arrays indexed by global word id, plus the
 * synced settings and cursors that travel with them.
 *
 * Arrays rather than a list of answered words because at 200k words the arrays
 * are 1.6 MB resident and mostly runs of zeros, which gzip flattens to almost
 * nothing, and because random access by id is what both the sequence walker
 * and every stats pass want. A sparse record list would need an index rebuilt
 * on load and would overtake the arrays in size well before the dictionary was
 * half finished.
 *
 * Persistence stores the four arrays as separate IndexedDB records rather than
 * an encoded container: structured-cloning a typed array is a memcpy, while
 * encoding is a full rebuild, and this runs after every answer.
 */

import {
  emptySnapshot,
  normaliseSettings,
  type Snapshot,
} from '@shared/container.js';
import {
  FLAG_PEEKED,
  FLAG_REVISED,
  DUR_CENSORED,
  encodeRating,
  isAnswered,
  toEpochMinutes,
} from '@shared/scales.js';
import * as db from './db';
import {
  normaliseLists,
  newList,
  withWord,
  withoutWord,
  hasWord,
  cleanListName,
  STARRED_ID,
  type WordList,
} from '@shared/lists.js';
import { pushRecent, flushRecent } from './device';

export type { Snapshot };

const PERSIST_DEBOUNCE_MS = 1000;
/** Depth of the undo stack. Deep enough to fix a misfire, not a session. */
const UNDO_MAX = 50;

interface WordState {
  rating: number;
  answeredAt: number;
  durMs: number;
  flags: number;
}

/**
 * One answer, as a reversible step: the word's state before and after, plus
 * where it sat in the run. The position is what lets "back" land on exactly
 * that word - in random order an id says nothing about where the run was.
 */
interface Step {
  id: number;
  position: number;
  before: WordState;
  after: WordState;
}

export interface StepResult {
  id: number;
  position: number;
  /** The response time the answer recorded, so a revisit can keep it. */
  durMs: number;
}

let state: Snapshot | null = null;
const undoStack: Step[] = [];
const redoStack: Step[] = [];

function read(s: Snapshot, id: number): WordState {
  return { rating: s.rating[id], answeredAt: s.answeredAt[id], durMs: s.durMs[id], flags: s.flags[id] };
}

function write(s: Snapshot, id: number, w: WordState): void {
  s.rating[id] = w.rating;
  s.answeredAt[id] = w.answeredAt;
  s.durMs[id] = w.durMs;
  s.flags[id] = w.flags;
}

let persistTimer: number | null = null;
let dirty = false;
let onChange: (() => void) | null = null;

export function snapshot(): Snapshot {
  if (!state) throw new Error('progress not loaded');
  return state;
}

export function isLoaded(): boolean {
  return state !== null;
}

export function subscribe(fn: () => void): void {
  onChange = fn;
}

/**
 * Load the stored profile, or start a fresh one.
 *
 * A stored profile whose length disagrees with the corpus is not silently
 * resized - that would shift every id and scramble the answers. The caller
 * runs a migration keyed on `corpusVersion` instead.
 */
export async function load(corpusVersion: string, wordCount: number): Promise<Snapshot> {
  const header = await db.get<{
    corpusVersion: string;
    wordCount: number;
    updatedAt: number;
    settings: Record<string, unknown>;
    settingsAt: Record<string, number>;
    cursor: { alphabetical: number; random: number };
  }>('state', 'header');

  const rating = await db.get<Uint8Array>('state', 'arr:rating');
  const answeredAt = await db.get<Uint32Array>('state', 'arr:answeredAt');
  const durMs = await db.get<Uint16Array>('state', 'arr:durMs');
  const flags = await db.get<Uint8Array>('state', 'arr:flags');
  const storedLists = normaliseLists(await db.get<unknown>('state', 'lists') ?? []);

  const usable = header && rating && answeredAt && durMs && flags
    && rating.length === header.wordCount
    && answeredAt.length === header.wordCount
    && durMs.length === header.wordCount
    && flags.length === header.wordCount;

  if (usable) {
    state = {
      corpusVersion: header.corpusVersion,
      wordCount: header.wordCount,
      updatedAt: header.updatedAt,
      settings: normaliseSettings(header.settings),
      settingsAt: header.settingsAt ?? {},
      cursor: header.cursor ?? { alphabetical: 0, random: 0 },
      rating, answeredAt, durMs, flags,
      lists: storedLists,
    };
    return state;
  }

  state = emptySnapshot(corpusVersion, wordCount, {
    // Minted once per profile and then never changed: random order is
    // reproducible from the seed alone, which is what makes a random-mode
    // position portable to another device.
    randomSeed: (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1,
  });
  // Lists are keyed by headword, not id, so they outlive a profile reset.
  state.lists = storedLists;
  await persistNow();
  return state;
}

/** Replace the whole profile - used by sync, import and migration. */
export async function replace(next: Snapshot): Promise<void> {
  state = next;
  undoStack.length = 0;
  redoStack.length = 0;
  await persistNow();
  onChange?.();
  // The word on screen may now be answered, and the cursor may have jumped
  // forward, so whoever is running the loop has to re-seat rather than carry
  // on from a position that belonged to the pre-merge profile.
  replacedListener?.();
}

let replacedListener: (() => void) | null = null;

export function onReplaced(fn: () => void): void {
  replacedListener = fn;
}

/**
 * Record an answer.
 *
 * `durMs` is clamped into a Uint16 with 65535 reserved as "at least this
 * long": a word left on screen while somebody answers the door is not a
 * response time, and storing it would drag every mean and every projection
 * with it. Stats treat the sentinel as censored rather than as 65 seconds.
 */
export function apply(
  id: number,
  scaleId: number,
  level: number,
  durMs: number,
  peeked: boolean,
  position: number,
): void {
  const s = snapshot();
  if (id < 0 || id >= s.wordCount) return;

  const before = read(s, id);
  const wasAnswered = isAnswered(s.rating[id]);
  const clamped = Math.max(0, Math.min(DUR_CENSORED, Math.round(durMs)));

  s.rating[id] = encodeRating(scaleId, level);
  s.answeredAt[id] = toEpochMinutes();
  s.durMs[id] = clamped;
  if (peeked) s.flags[id] |= FLAG_PEEKED;
  if (wasAnswered) s.flags[id] |= FLAG_REVISED;
  s.updatedAt = Date.now();

  undoStack.push({ id, position, before, after: read(s, id) });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  // A new answer forks history; the undone future no longer follows from it.
  redoStack.length = 0;

  if (clamped !== DUR_CENSORED) pushRecent({ id, durMs: clamped });
  markDirty();
}

/** Step back one answer. @returns the word to return to, or null at the start. */
export function undo(): StepResult | null {
  const s = snapshot();
  const step = undoStack.pop();
  if (!step) return null;
  // The REVISED bit stays: the word really was answered twice, and losing that
  // would make the flag a lie the next time the word came round.
  write(s, step.id, { ...step.before, flags: step.before.flags | (s.flags[step.id] & FLAG_REVISED) });
  s.updatedAt = Date.now();
  redoStack.push(step);
  markDirty();
  return { id: step.id, position: step.position, durMs: step.after.durMs };
}

/** Re-apply the most recently undone answer exactly as it was first given. */
export function redo(): StepResult | null {
  const s = snapshot();
  const step = redoStack.pop();
  if (!step) return null;
  write(s, step.id, step.after);
  s.updatedAt = Date.now();
  undoStack.push(step);
  markDirty();
  return { id: step.id, position: step.position, durMs: step.after.durMs };
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

export function setCursor(order: 'alphabetical' | 'random', value: number): void {
  const s = snapshot();
  if (s.cursor[order] === value) return;
  s.cursor[order] = value;
  markDirty();
}

/** Settings changes are stamped so the merge can tell a change from silence. */
export function setSetting(key: string, value: unknown): void {
  const s = snapshot();
  s.settings = normaliseSettings({ ...s.settings, [key]: value });
  s.settingsAt = { ...s.settingsAt, [key]: toEpochMinutes() };
  s.updatedAt = Date.now();
  markDirty();
  onChange?.();
}

let dirtyListener: (() => void) | null = null;

/** Sync registers here so a local answer schedules a push. */
export function onDirty(fn: () => void): void {
  dirtyListener = fn;
}

function markDirty(): void {
  dirty = true;
  onChange?.();
  dirtyListener?.();
  if (persistTimer) return;
  persistTimer = self.setTimeout(() => {
    persistTimer = null;
    persistNow().catch((err) => console.error('[progress] persist failed', err));
  }, PERSIST_DEBOUNCE_MS);
}

export async function persistNow(): Promise<void> {
  const s = snapshot();
  if (persistTimer) {
    self.clearTimeout(persistTimer);
    persistTimer = null;
  }
  dirty = false;
  await db.put('state', 'header', {
    corpusVersion: s.corpusVersion,
    wordCount: s.wordCount,
    updatedAt: s.updatedAt,
    settings: s.settings,
    settingsAt: s.settingsAt,
    cursor: s.cursor,
  });
  await db.put('state', 'arr:rating', s.rating);
  await db.put('state', 'arr:answeredAt', s.answeredAt);
  await db.put('state', 'arr:durMs', s.durMs);
  await db.put('state', 'arr:flags', s.flags);
  await db.put('state', 'lists', s.lists);
  await flushRecent();
}

export function hasUnsavedChanges(): boolean {
  return dirty;
}

/**
 * A tab being hidden is the last reliable moment before it may be discarded,
 * so the debounce is cut short there rather than hoping for another second.
 */
export function installLifecycleHooks(): void {
  const flush = () => {
    if (!state || !dirty) return;
    persistNow().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  addEventListener('pagehide', flush);
}

// ---------------------------------------------------------------------------
// Saved lists
//
// Every edit replaces the list object rather than mutating it, stamps the
// change (see shared/lists.js for why membership is timestamped), and marks
// the profile dirty so the edit persists and syncs like an answer.
// ---------------------------------------------------------------------------

/** Live lists for display: Starred first, then oldest first. */
export function lists(): WordList[] {
  return snapshot().lists
    .filter((list) => list.deletedAt === 0)
    .sort((a, b) => (a.id === STARRED_ID ? -1 : b.id === STARRED_ID ? 1 : a.createdAt - b.createdAt));
}

export function getList(id: string): WordList | undefined {
  return snapshot().lists.find((list) => list.id === id && list.deletedAt === 0);
}

function putList(list: WordList): void {
  const s = snapshot();
  const others = s.lists.filter((l) => l.id !== list.id);
  s.lists = [...others, list];
  s.updatedAt = Date.now();
  markDirty();
}

function newListId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function isStarred(word: string): boolean {
  const starred = getList(STARRED_ID);
  return starred ? hasWord(starred, word) : false;
}

/** @returns whether the word is starred afterwards. */
export function toggleStar(word: string): boolean {
  const starred = getList(STARRED_ID) ?? newList(STARRED_ID, '');
  const next = hasWord(starred, word) ? withoutWord(starred, word) : withWord(starred, word);
  putList(next);
  return hasWord(next, word);
}

export function createList(name: string): WordList {
  const list = newList(newListId(), name);
  putList(list);
  return list;
}

export function setInList(listId: string, word: string, present: boolean): void {
  const list = getList(listId);
  if (!list) return;
  if (present === hasWord(list, word)) return;
  putList(present ? withWord(list, word) : withoutWord(list, word));
}

export function renameList(listId: string, name: string): void {
  const list = getList(listId);
  const clean = cleanListName(name);
  if (!list || listId === STARRED_ID || !clean || clean === list.name) return;
  putList({ ...list, name: clean, nameAt: Date.now() });
}

export function deleteList(listId: string): void {
  const list = getList(listId);
  if (!list || listId === STARRED_ID) return;
  putList({ ...list, deletedAt: Date.now(), items: {} });
}

/** Record a publish ('' code = unpublished) so every device shows the same link. */
export function setPublished(listId: string, code: string): void {
  const list = getList(listId);
  if (!list) return;
  putList({ ...list, published: code, publishedAt: Date.now() });
}
