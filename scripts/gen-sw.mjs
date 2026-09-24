#!/usr/bin/env node
/**
 * Finish the service worker after `vite build`.
 *
 * Vite emits hashed filenames it decides at build time, so the shell precache
 * list cannot be written by hand, and the build hash that keys the shell cache
 * has to be derived from what was actually emitted. Skipping this step leaves
 * `__SHELL_ASSETS__` as a syntax error in dist/sw.js, which is deliberate: a
 * service worker that silently precached nothing would look like it worked
 * right up until the first offline launch.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const corpusManifest = path.join(root, 'corpus', 'manifest.json');

if (!fs.existsSync(path.join(dist, 'sw.js'))) {
  console.error('gen-sw: dist/sw.js is missing - run `vite build` first');
  process.exit(1);
}

/** Everything the app needs to boot with no network, bar the corpus itself. */
const PRECACHE_EXT = new Set(['.html', '.js', '.css', '.webmanifest', '.png', '.svg', '.woff2']);

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(dist).filter((rel) => rel !== 'sw.js' && PRECACHE_EXT.has(path.extname(rel)));
files.sort();

const hash = crypto.createHash('sha256');
for (const rel of files) {
  hash.update(rel).update(String(fs.statSync(path.join(dist, rel)).size));
}
const buildHash = hash.digest('hex').slice(0, 12);

let corpusVersion = 'none';
let assetVersion = 'none';
if (fs.existsSync(corpusManifest)) {
  const manifest = JSON.parse(fs.readFileSync(corpusManifest, 'utf8'));
  corpusVersion = manifest.corpusVersion;
  assetVersion = manifest.assetVersion;
} else {
  console.warn('gen-sw: corpus/manifest.json missing - the corpus cache will not be keyed');
}

const swPath = path.join(dist, 'sw.js');
let source = fs.readFileSync(swPath, 'utf8');
// replaceAll, not replace: the placeholders are also named in sw.js's own
// header comment, and substituting only the first occurrence would rewrite the
// prose and leave the code untouched.
source = source
  .replaceAll('__SHELL_ASSETS__', JSON.stringify(files, null, 2))
  .replaceAll('__BUILD_HASH__', buildHash)
  .replaceAll('__CORPUS_VERSION__', corpusVersion)
  .replaceAll('__ASSET_VERSION__', assetVersion);

for (const placeholder of ['__SHELL_ASSETS__', '__BUILD_HASH__', '__CORPUS_VERSION__', '__ASSET_VERSION__']) {
  if (source.includes(placeholder)) {
    console.error(`gen-sw: ${placeholder} was not substituted`);
    process.exit(1);
  }
}

fs.writeFileSync(swPath, source);
console.log(`gen-sw: ${files.length} shell assets, build ${buildHash}, corpus ${corpusVersion}/${assetVersion}`);
