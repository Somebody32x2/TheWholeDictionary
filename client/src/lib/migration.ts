/**
 * Corpus migration.
 *
 * Word ids are positions in a sorted headword list, so any change to that list
 * shifts every id after the insertion point. A profile is therefore only
 * meaningful against the corpus version it was recorded on, and moving it
 * means re-keying every answer by headword.
 *
 * This is why `ensureIndexCached()` stores the compressed index unconditionally
 * on first launch: the *old* index is the only thing that can say what word id
 * 48,301 used to mean, and by the time the version has changed the server no
 * longer serves it.
 */

import { emptySnapshot, type Snapshot } from '@shared/container.js';
import * as corpus from './corpus';
import * as progress from './progress';

export interface MigrationResult {
  from: string;
  to: string;
  remapped: number;
  dropped: number;
  /** True when the old index was unavailable and answers could not be carried. */
  lost: boolean;
}

export async function migrateIfNeeded(): Promise<MigrationResult | null> {
  const manifest = corpus.currentManifest();
  const local = progress.snapshot();
  if (local.corpusVersion === manifest.corpusVersion && local.wordCount === manifest.wordCount) {
    return null;
  }

  const oldWords = await corpus.indexWords(local.corpusVersion);

  // The new index is normally cached a moment after boot, but a profile that
  // needs migrating has, by definition, never booted on this corpus - so it
  // is fetched here rather than assumed. Relying on the post-boot cache made
  // every real migration fail with "new headword index is not available".
  try {
    await corpus.ensureIndexCached();
  } catch {
    throw new Error('The dictionary has been updated. Connect once so this device can move your answers across to it; nothing has been changed yet.');
  }
  const newWords = await corpus.indexWords(manifest.corpusVersion);
  if (!newWords || newWords.length !== manifest.wordCount) {
    throw new Error('migration: the new headword index does not match the dictionary');
  }

  const next = emptySnapshot(manifest.corpusVersion, manifest.wordCount, local.settings);
  next.settingsAt = { ...local.settingsAt };
  next.updatedAt = Date.now();
  // Lists hold headwords rather than ids, so they carry across untouched.
  next.lists = local.lists;

  if (!oldWords || oldWords.length !== local.wordCount) {
    // Nothing can be carried across without the old index. Say so loudly
    // rather than silently presenting a blank profile as if it were fine.
    await progress.replace(next);
    return {
      from: local.corpusVersion, to: manifest.corpusVersion,
      remapped: 0, dropped: countAnswered(local), lost: true,
    };
  }

  const byWord = new Map<string, number>();
  for (let i = 0; i < newWords.length; i++) byWord.set(newWords[i], i);

  let remapped = 0;
  let dropped = 0;
  for (let oldId = 0; oldId < local.wordCount; oldId++) {
    if (local.rating[oldId] === 0 && local.flags[oldId] === 0) continue;
    const newId = byWord.get(oldWords[oldId]);
    if (newId === undefined) { dropped++; continue; }
    next.rating[newId] = local.rating[oldId];
    next.answeredAt[newId] = local.answeredAt[oldId];
    next.durMs[newId] = local.durMs[oldId];
    next.flags[newId] = local.flags[oldId];
    remapped++;
  }

  // The alphabetical cursor is a word, so it survives; the random cursor is an
  // index into a permutation of a different length, so it does not.
  const cursorWord = oldWords[Math.min(local.cursor.alphabetical, oldWords.length - 1)];
  next.cursor = { alphabetical: byWord.get(cursorWord) ?? 0, random: 0 };

  await progress.replace(next);
  return {
    from: local.corpusVersion, to: manifest.corpusVersion,
    remapped, dropped, lost: false,
  };
}

function countAnswered(state: Snapshot): number {
  let n = 0;
  for (let i = 0; i < state.wordCount; i++) if (state.rating[i] !== 0) n++;
  return n;
}
