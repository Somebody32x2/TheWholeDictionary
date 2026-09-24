/* eslint-env serviceworker */
/**
 * Hand-written service worker. No Workbox.
 *
 * Three caches with three different lifetimes, which is the whole reason not
 * to use a generic recipe here:
 *
 *   shell   the built app, keyed by a hash of the emitted assets.
 *   corpus  the dictionary, keyed by the corpus asset hash. Shard filenames
 *           are stable, so without that key a rebuilt definition would never
 *           reach a device that already cached the shard.
 *   shards  cache-first with a hard entry cap - the one thing standing between
 *           this app and quietly filling a phone with 200k definitions.
 *
 * `__BUILD_HASH__`, `__SHELL_ASSETS__`, `__CORPUS_VERSION__` and
 * `__ASSET_VERSION__` are replaced by scripts/gen-sw.mjs after `vite build`.
 * Without that step the shell cache could never be invalidated correctly, so
 * the placeholders are left obviously broken rather than defaulted.
 */

const BUILD_HASH = '__BUILD_HASH__';
const CORPUS_VERSION = '__CORPUS_VERSION__';
const ASSET_VERSION = '__ASSET_VERSION__';
const SHELL_ASSETS = __SHELL_ASSETS__;

const SHELL_CACHE = `twd-shell-v${BUILD_HASH}`;
const CORPUS_CACHE = `twd-corpus-v${CORPUS_VERSION}-${ASSET_VERSION}`;

/**
 * ~35 KB compressed per shard, so 128 is about 4.5 MB - with the shell and
 * IndexedDB that keeps a device under ~8 MB even after walking the whole
 * dictionary. Shards are served compressed and cached compressed, which is
 * what makes that number achievable.
 */
const MAX_CACHED_SHARDS = 128;

const SCOPE = new URL(self.registration.scope).pathname;
const SHARD_RE = /\/corpus\/shard-\d{4}\.json\.gz$/;
const CORPUS_RE = /\/corpus\//;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL_ASSETS.map((asset) => new URL(asset, self.registration.scope).toString()));

    // The three files every session needs before it can show a word.
    const corpus = await caches.open(CORPUS_CACHE);
    await corpus.addAll([
      `${SCOPE}corpus/manifest.json`,
      `${SCOPE}corpus/tiers.bin.gz?v=${ASSET_VERSION}`,
      `${SCOPE}corpus/index.txt.gz?v=${ASSET_VERSION}`,
    ]).catch((err) => console.warn('[sw] corpus precache incomplete', err));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (!name.startsWith('twd-')) continue;
      if (name === SHELL_CACHE || name === CORPUS_CACHE) continue;
      await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Sync is never cached. A stale snapshot served from disk would be merged
  // into live state and could resurrect answers the user undid.
  if (url.pathname.startsWith(`${SCOPE}api/`)) return;

  if (SHARD_RE.test(url.pathname)) {
    event.respondWith(shardFirst(request));
    return;
  }
  if (CORPUS_RE.test(url.pathname)) {
    event.respondWith(corpusFirst(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigateFirst(request));
    return;
  }
  event.respondWith(shellFirst(request));
});

/**
 * Cache-first with a FIFO cap.
 *
 * FIFO rather than true LRU because the Cache API already preserves insertion
 * order, so eviction needs no second ledger that could disagree with the cache
 * after an eviction the page never saw. For a sequential walk through the
 * dictionary the two policies are identical anyway.
 */
async function shardFirst(request) {
  const cache = await caches.open(CORPUS_CACHE);
  const hit = await cache.match(request, { ignoreSearch: false });
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimShards(cache);
  }
  return response;
}

async function trimShards(cache) {
  const keys = await cache.keys();
  const shards = keys.filter((request) => SHARD_RE.test(new URL(request.url).pathname));
  const excess = shards.length - MAX_CACHED_SHARDS;
  for (let i = 0; i < excess; i++) await cache.delete(shards[i]);
}

/** manifest.json must revalidate; everything else under /corpus/ is immutable. */
async function corpusFirst(request) {
  const cache = await caches.open(CORPUS_CACHE);
  const isManifest = new URL(request.url).pathname.endsWith('/manifest.json');

  if (!isManifest) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function navigateFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(`${SCOPE}index.html`, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(`${SCOPE}index.html`) ?? await cache.match(SCOPE);
    if (hit) return hit;
    throw err;
  }
}

async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && new URL(request.url).pathname.startsWith(SCOPE)) {
    await cache.put(request, response.clone());
  }
  return response;
}
