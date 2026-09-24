/**
 * The set of headwords in the shipped corpus.
 *
 * Published lists are public, and a server that accepts arbitrary strings in
 * a public document is a free text host. Checking every published word
 * against the dictionary closes that: a publication can only ever be a list
 * of real headwords. Loaded once, lazily - 125k short strings is a few
 * megabytes, and servers that never see a publish never pay for it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { config } from './config.js';

let loading = null;

/** @returns {Promise<Set<string>>} */
export function headwords() {
  loading ??= (async () => {
    const gz = await fs.readFile(path.join(config.corpusDir, 'index.txt.gz'));
    const words = zlib.gunzipSync(gz).toString('utf8').split('\n').filter(Boolean);
    return new Set(words);
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}
