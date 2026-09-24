/**
 * The sync engine.
 *
 * Much smaller than it would otherwise be, because `mergeSnapshots` is
 * commutative and idempotent: there is no base snapshot to keep, no conflict
 * to present, and no ordering requirement between devices. Push and pull are
 * the same join from either end, so the engine only has to decide *when* to
 * talk, never *what to do when both sides changed*.
 *
 * Nothing here is on the critical path of answering a word. Every failure
 * leaves the app fully usable offline and only moves the corner dot to amber.
 */

import { decodeSnapshot, encodeSnapshot } from '@shared/container.js';
import { mergeSnapshots } from '@shared/merge.js';
import { listWords, type WordList } from '@shared/lists.js';
import * as db from './db';
import * as progress from './progress';
import { gunzip, gzip } from './gzip';

const API = `${import.meta.env.BASE_URL}api`;

/** Quiet period after the last answer before a push goes out. */
const PUSH_DEBOUNCE_MS = 1200;
/** ...shortened to this when the user has not answered anything for a while. */
const PUSH_LEAD_MS = 300;
const PUSH_QUIET_MS = 4000;
const META_POLL_MS = 60_000;
const META_MIN_GAP_MS = 4000;

export type SyncStatus = 'off' | 'pending' | 'synced' | 'error';

export interface SyncState {
  status: SyncStatus;
  key: string | null;
  rev: number;
  lastError: string | null;
  lastSyncedAt: number | null;
}

const state: SyncState = {
  status: 'off',
  key: null,
  rev: 0,
  lastError: null,
  lastSyncedAt: null,
};

/**
 * A set, not a single slot. Both the corner dot and the account sheet watch
 * sync state, and a single-listener hook meant whichever mounted last
 * silently unsubscribed the other - the dot simply stopped updating.
 */
const listeners = new Set<(s: SyncState) => void>();
let pushTimer: number | null = null;
let pollTimer: number | null = null;
let lastMetaCheck = 0;
let lastAnswerAt = 0;
let busy = false;
let pendingPush = false;
/** Set when the server reports a corpus the client does not have. */
let migrationHook: (() => Promise<boolean>) | null = null;

export function onChange(fn: (s: SyncState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function onCorpusMismatch(fn: () => Promise<boolean>): void {
  migrationHook = fn;
}

export function current(): SyncState {
  return state;
}

function emit(patch: Partial<SyncState>): void {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

export async function init(): Promise<void> {
  const key = await db.get<string>('state', 'syncKey');
  const rev = await db.get<number>('state', 'syncRev');
  if (key) emit({ key, rev: rev ?? 0, status: 'pending' });

  progress.onDirty(() => {
    lastAnswerAt = Date.now();
    schedulePush();
  });

  addEventListener('online', () => { if (state.key) void checkRemote(true); });
  addEventListener('focus', () => { if (state.key) void checkRemote(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.key) void checkRemote();
  });
  startPolling();
  if (state.key) await checkRemote(true);
}

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = self.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!state.key) return;
    void checkRemote();
  }, META_POLL_MS);
}

/** @returns the four words, which the caller must show the user exactly once. */
export async function createAccount(): Promise<string> {
  const res = await fetch(`${API}/account`, { method: 'POST' });
  if (!res.ok) throw new Error(await errorText(res));
  const body = await res.json() as { words: string };
  await signIn(body.words);
  return body.words;
}

export async function signIn(words: string): Promise<void> {
  const key = words.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^[a-z]+( [a-z]+){3}$/.test(key)) throw new Error('A sync phrase is exactly four words.');
  await db.put('state', 'syncKey', key);
  await db.put('state', 'syncRev', 0);
  emit({ key, rev: 0, status: 'pending', lastError: null });
  // Pull first: signing in on a second device must adopt what is already
  // there before this device's blank state can be pushed over it. The merge
  // makes that safe either way, but pulling first avoids a pointless upload.
  await checkRemote(true);
  await pushNow();
}

export async function signOut(): Promise<void> {
  await db.del('state', 'syncKey');
  await db.del('state', 'syncRev');
  emit({ key: null, rev: 0, status: 'off', lastError: null });
}

export async function deleteRemote(): Promise<void> {
  if (!state.key) return;
  const res = await fetch(`${API}/snapshot`, {
    method: 'DELETE',
    headers: { 'X-Sync-Key': state.key },
  });
  if (!res.ok) throw new Error(await errorText(res));
  await signOut();
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

function schedulePush(): void {
  if (!state.key) return;
  emit({ status: 'pending' });
  if (pushTimer !== null) self.clearTimeout(pushTimer);
  // A burst of answers coalesces into one upload; the first answer after a
  // pause goes out almost immediately so a quick session still syncs.
  const quiet = Date.now() - lastAnswerAt > PUSH_QUIET_MS;
  pushTimer = self.setTimeout(() => {
    pushTimer = null;
    void pushNow();
  }, quiet ? PUSH_LEAD_MS : PUSH_DEBOUNCE_MS);
}

export async function pushNow(): Promise<void> {
  if (!state.key || !progress.isLoaded()) return;
  if (busy) { pendingPush = true; return; }
  if (navigator.onLine === false) { emit({ status: 'pending' }); return; }
  busy = true;
  try {
    const body = await gzip(encodeSnapshot(progress.snapshot()));
    const res = await fetch(`${API}/snapshot`, {
      method: 'PUT',
      headers: {
        'X-Sync-Key': state.key,
        'X-Base-Rev': String(state.rev),
        'Content-Type': 'application/octet-stream',
      },
      body: body as BodyInit,
    });

    if (res.status === 409) {
      const handled = await handleCorpusMismatch();
      if (handled) { busy = false; return void pushNow(); }
      emit({ status: 'error', lastError: 'This device has a different dictionary version.' });
      return;
    }
    if (!res.ok) {
      emit({ status: 'error', lastError: await errorText(res) });
      return;
    }

    const body2 = await res.json() as { rev: number; merged: boolean };
    await setRev(body2.rev);
    if (res.headers.get('x-merged') === '1' || body2.merged) {
      // The server held answers this device has never seen; take them now
      // rather than waiting for the next poll.
      await pullInto();
    } else {
      emit({ status: 'synced', lastError: null, lastSyncedAt: Date.now() });
    }
  } catch (err) {
    emit({ status: 'pending', lastError: String((err as Error).message ?? err) });
  } finally {
    busy = false;
    if (pendingPush) { pendingPush = false; void pushNow(); }
  }
}

export async function checkRemote(force = false): Promise<void> {
  if (!state.key || !progress.isLoaded()) return;
  if (navigator.onLine === false) { emit({ status: 'pending' }); return; }
  if (!force && Date.now() - lastMetaCheck < META_MIN_GAP_MS) return;
  lastMetaCheck = Date.now();
  if (busy) return;

  busy = true;
  try {
    const res = await fetch(`${API}/meta`, { headers: { 'X-Sync-Key': state.key } });
    if (res.status === 404) {
      // The account exists but has never been written to; our own push will
      // create it. Not an error, and not worth polling for.
      emit({ status: progress.hasUnsavedChanges() ? 'pending' : 'synced' });
      return;
    }
    if (!res.ok) {
      emit({ status: 'error', lastError: await errorText(res) });
      return;
    }
    const meta = await res.json() as { rev: number; corpusVersion: string };
    if (meta.corpusVersion && meta.corpusVersion !== progress.snapshot().corpusVersion) {
      const handled = await handleCorpusMismatch();
      if (!handled) {
        emit({ status: 'error', lastError: 'This device has a different dictionary version.' });
        return;
      }
    }
    if (meta.rev !== state.rev) await pullInto();
    else emit({ status: 'synced', lastError: null, lastSyncedAt: Date.now() });
  } catch (err) {
    emit({ status: 'pending', lastError: String((err as Error).message ?? err) });
  } finally {
    busy = false;
  }
}

/** GET the remote snapshot and join it into local state. */
async function pullInto(): Promise<void> {
  if (!state.key) return;
  const res = await fetch(`${API}/snapshot`, { headers: { 'X-Sync-Key': state.key } });
  if (res.status === 404) { emit({ status: 'pending' }); return; }
  if (!res.ok) { emit({ status: 'error', lastError: await errorText(res) }); return; }

  const remote = decodeSnapshot(await gunzip(new Uint8Array(await res.arrayBuffer())));
  const local = progress.snapshot();
  if (remote.corpusVersion !== local.corpusVersion) {
    const handled = await handleCorpusMismatch();
    if (!handled) {
      emit({ status: 'error', lastError: 'This device has a different dictionary version.' });
      return;
    }
  }

  const merged = mergeSnapshots(local, remote);
  await progress.replace(merged.state);
  await setRev(Number(res.headers.get('x-rev') ?? state.rev));
  emit({ status: 'synced', lastError: null, lastSyncedAt: Date.now() });

  // The join produced something the server does not have yet - typically this
  // device's own offline answers - so send it straight back.
  if (merged.changedFromB > 0) await pushNow();
}

async function setRev(rev: number): Promise<void> {
  emit({ rev });
  await db.put('state', 'syncRev', rev);
}

async function handleCorpusMismatch(): Promise<boolean> {
  if (!migrationHook) return false;
  try {
    return await migrationHook();
  } catch (err) {
    console.error('[sync] corpus migration failed', err);
    return false;
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export interface PublishedList {
  code: string;
  name: string;
  words: string[];
  count: number;
  publishedAt: number;
  updatedAt: number;
}

/** A shareable link for a published list, on whatever origin this app is served from. */
export function publishedUrl(code: string): string {
  return `${location.origin}${import.meta.env.BASE_URL}?list=${code}`;
}

/**
 * Publish, or republish, a saved list. Needs an account: the server ties a
 * publication to its owner so only they can update or withdraw it.
 *
 * @returns the share code, which is also recorded on the list so every
 * signed-in device shows the same link.
 */
export async function publishList(list: WordList): Promise<string> {
  if (!state.key) throw new Error('Publishing needs an account. Create one or sign in first.');
  const res = await fetch(`${API}/lists`, {
    method: 'POST',
    headers: { 'X-Sync-Key': state.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listId: list.id, name: list.name, words: listWords(list) }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const body = await res.json() as { code: string };
  progress.setPublished(list.id, body.code);
  void pushNow();
  return body.code;
}

export async function unpublishList(list: WordList): Promise<void> {
  if (!state.key) throw new Error('Sign in on this device to unpublish.');
  if (list.published) {
    const res = await fetch(`${API}/lists/${list.published}`, {
      method: 'DELETE',
      headers: { 'X-Sync-Key': state.key },
    });
    // 404 means it is already gone - the goal state - so it is not an error.
    if (!res.ok && res.status !== 404) throw new Error(await errorText(res));
  }
  progress.setPublished(list.id, '');
  void pushNow();
}

/** Public read. No account needed. */
export async function fetchPublished(code: string): Promise<PublishedList> {
  const res = await fetch(`${API}/lists/${encodeURIComponent(code)}`);
  if (res.status === 404) throw new Error('This list does not exist, or its owner withdrew it.');
  if (!res.ok) throw new Error(await errorText(res));
  return await res.json() as PublishedList;
}
