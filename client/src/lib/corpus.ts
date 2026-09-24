/**
 * Corpus access: manifest, tiers, headword index, and lazily-fetched shards.
 *
 * The whole dictionary is ~200k words; shipping it as one file would be a
 * multi-megabyte blocking download before the first word could be shown, and
 * caching all of it would blow the device budget. So the only things fetched
 * up front are the manifest (a few hundred bytes), the tier array (one byte
 * per word, gzipped to very little because it is long runs) and the compressed
 * headword index. Definitions arrive 1,000 words at a time, on demand.
 */

import { gunzip } from './gzip';
import * as db from './db';

export interface Manifest {
  corpusVersion: string;
  /** Hash of the payload bytes. Shard names are stable, so this busts their cache. */
  assetVersion: string;
  builtAt: string;
  wordCount: number;
  shardSize: number;
  shardCount: number;
  tierCounts: Record<string, number>;
  sources: Array<{ name: string; url: string; licence: string }>;
}

export interface WordEntry {
  id: number;
  word: string;
  defs: Array<{ pos: string; gloss: string }>;
}

interface Shard {
  from: number;
  w: string[][];
}

const BASE = import.meta.env.BASE_URL;
/** Shards held in RAM. Eight is two full screens of prefetch either side. */
const MEMO_MAX = 8;

/** Shards are served immutable for a year, so the URL carries the payload hash. */
function asset(name: string): string {
  return `${BASE}corpus/${name}?v=${currentManifest().assetVersion}`;
}

let manifest: Manifest | null = null;
let tiers: Uint8Array | null = null;
let index: string[] | null = null;

const memo = new Map<number, Shard>();
const inflight = new Map<number, Promise<Shard>>();

export function currentManifest(): Manifest {
  if (!manifest) throw new Error('corpus manifest not loaded');
  return manifest;
}

/**
 * Why the manifest could not be loaded, because the two causes need opposite
 * fixes. `missing` (a real 404 from our server) means the corpus was never
 * built. `unreachable` - a network failure, or a 5xx such as the Vite dev
 * proxy's 500 when the API is not running - means the server is down, and
 * rebuilding the corpus would be a 2.9 GB download that fixes nothing.
 */
export class ManifestError extends Error {
  constructor(readonly kind: 'missing' | 'unreachable', message: string) {
    super(message);
  }
}

/**
 * Network first, cache second.
 *
 * This is the only corpus file that is not content-addressed, because it is
 * how a client learns that `corpusVersion` moved. Serving it from a stale
 * cache would pin the app to an old dictionary forever.
 */
export async function loadManifest(): Promise<Manifest> {
  if (manifest) return manifest;
  try {
    let res: Response;
    try {
      res = await fetch(`${BASE}corpus/manifest.json`, { cache: 'no-cache' });
    } catch (err) {
      throw new ManifestError('unreachable', `manifest: ${(err as Error).message}`);
    }
    if (res.status === 404) throw new ManifestError('missing', 'manifest: HTTP 404');
    if (!res.ok) throw new ManifestError('unreachable', `manifest: HTTP ${res.status}`);
    manifest = await res.json() as Manifest;
    await db.put('corpus', 'manifest', manifest);
  } catch (err) {
    const cached = await db.get<Manifest>('corpus', 'manifest');
    if (!cached) throw err;
    manifest = cached;
  }
  return manifest;
}

export async function loadTiers(): Promise<Uint8Array> {
  if (tiers) return tiers;
  const m = currentManifest();
  const key = `tiers:${m.corpusVersion}`;
  const cached = await db.get<Uint8Array>('corpus', key);
  if (cached && cached.length === m.wordCount) {
    tiers = cached;
    return tiers;
  }
  const res = await fetch(asset('tiers.bin.gz'));
  if (!res.ok) throw new Error(`tiers: HTTP ${res.status}`);
  tiers = await gunzip(new Uint8Array(await res.arrayBuffer()));
  await db.put('corpus', key, tiers);
  return tiers;
}

/**
 * Cache the compressed headword index.
 *
 * Unconditional, and kept compressed (~900 KB rather than ~2 MB): it is only
 * read during a corpus migration, but that migration is impossible without the
 * *previous* index, so it has to be on disk before the version changes rather
 * than fetched afterwards - by then the old file is gone from the server.
 */
export async function ensureIndexCached(): Promise<void> {
  const m = currentManifest();
  const key = `index:${m.corpusVersion}`;
  if (await db.get<Uint8Array>('corpus', key)) return;
  const res = await fetch(asset('index.txt.gz'));
  if (!res.ok) throw new Error(`index: HTTP ${res.status}`);
  await db.put('corpus', key, new Uint8Array(await res.arrayBuffer()));
}

/** Headwords in id order for a given corpus version, from the cached index. */
export async function indexWords(corpusVersion?: string): Promise<string[] | null> {
  const version = corpusVersion ?? currentManifest().corpusVersion;
  if (index && version === manifest?.corpusVersion) return index;
  const bytes = await db.get<Uint8Array>('corpus', `index:${version}`);
  if (!bytes) return null;
  const words = new TextDecoder().decode(await gunzip(bytes)).split('\n');
  if (words[words.length - 1] === '') words.pop();
  if (version === manifest?.corpusVersion) index = words;
  return words;
}

async function fetchShard(shard: number): Promise<Shard> {
  const memoed = memo.get(shard);
  if (memoed) return memoed;
  const pending = inflight.get(shard);
  if (pending) return pending;

  const name = `shard-${String(shard).padStart(4, '0')}.json.gz`;
  const promise = (async () => {
    const res = await fetch(asset(name));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const raw = await gunzip(new Uint8Array(await res.arrayBuffer()));
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as Shard;
    memo.set(shard, parsed);
    // Insertion-ordered, so the first key is the least recently added.
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as number);
    return parsed;
  })();
  inflight.set(shard, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(shard);
  }
}

export async function getWord(id: number): Promise<WordEntry> {
  const m = currentManifest();
  const shard = await fetchShard(Math.floor(id / m.shardSize));
  const row = shard.w[id - shard.from];
  if (!row) throw new Error(`word ${id} missing from shard ${shard.from}`);
  const defs = row.slice(1).map((entry) => {
    const bar = entry.indexOf('|');
    return { pos: entry.slice(0, bar), gloss: entry.slice(bar + 1) };
  });
  return { id, word: row[0], defs };
}

/** Warm the shards a run is about to walk into. Fire and forget by design. */
export function prefetch(ids: number[]): void {
  const m = manifest;
  if (!m) return;
  const wanted = new Set<number>();
  for (const id of ids) wanted.add(Math.floor(id / m.shardSize));
  for (const shard of wanted) {
    if (memo.has(shard) || inflight.has(shard)) continue;
    fetchShard(shard).catch(() => {});
  }
}

/** Test seam and migration helper: forget everything held in RAM. */
export function resetCache(): void {
  manifest = null;
  tiers = null;
  index = null;
  memo.clear();
  inflight.clear();
}
