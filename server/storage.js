/**
 * Profile storage: one gzipped snapshot and one small meta file per account,
 * sharded by the first two hex characters of the id so the directory never
 * grows flat.
 *
 * The blob is always written before the meta. A crash between the two leaves
 * the previous meta pointing at a blob that is newer than it claims, which the
 * element-wise merge absorbs without noticing; the reverse order would leave a
 * meta pointing at a blob that does not exist yet, which is data loss.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { config } from './config.js';

let bytesOnDisk = 0;
let profiles = 0;

function pathsFor(id) {
  const dir = path.join(config.dataDir, id.slice(0, 2));
  return { dir, blob: path.join(dir, `${id}.bin`), meta: path.join(dir, `${id}.json`) };
}

/** Walk the tree once at boot so the quota has a real number to work from. */
export async function init() {
  await fsp.mkdir(config.dataDir, { recursive: true });
  bytesOnDisk = 0;
  profiles = 0;
  for (const shard of await fsp.readdir(config.dataDir, { withFileTypes: true })) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
    const dir = path.join(config.dataDir, shard.name);
    for (const entry of await fsp.readdir(dir)) {
      const stat = await fsp.stat(path.join(dir, entry)).catch(() => null);
      if (!stat?.isFile()) continue;
      bytesOnDisk += stat.size;
      if (entry.endsWith('.bin')) profiles++;
    }
  }
  bytesOnDisk += await treeBytes(publishedDir());
  const removed = await sweep();
  return { profiles, bytesOnDisk, swept: removed };
}

async function treeBytes(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await treeBytes(full);
    else total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export function stats() {
  return { profiles, bytesOnDisk, quotaBytes: config.quotaBytes };
}

export function overQuota(extraBytes = 0) {
  return bytesOnDisk + extraBytes > config.quotaBytes;
}

/** @returns {{rev: number, createdAt: number, updatedAt: number, bytes: number, corpusVersion: string}|null} */
export function readMeta(id) {
  const p = pathsFor(id);
  try {
    const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
    if (!meta || typeof meta.rev !== 'number') return null;
    return meta;
  } catch {
    return null;
  }
}

/** @returns {Buffer|null} the gzipped snapshot exactly as it was stored. */
export function readSnapshot(id) {
  const p = pathsFor(id);
  try {
    return fs.readFileSync(p.blob);
  } catch {
    return null;
  }
}

export function exists(id) {
  return fs.existsSync(pathsFor(id).blob);
}

/**
 * @param {string} id
 * @param {Buffer} gzipped
 * @param {string} corpusVersion
 * @returns {{rev: number, updatedAt: number, bytes: number}}
 */
export async function writeSnapshot(id, gzipped, corpusVersion) {
  const p = pathsFor(id);
  await fsp.mkdir(p.dir, { recursive: true });

  const prev = readMeta(id);
  const prevBlobBytes = prev ? await fsp.stat(p.blob).then((s) => s.size, () => 0) : 0;
  const prevMetaBytes = prev ? await fsp.stat(p.meta).then((s) => s.size, () => 0) : 0;

  const now = Date.now();
  const meta = {
    rev: (prev?.rev ?? 0) + 1,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    bytes: gzipped.length,
    corpusVersion,
  };
  const metaBuf = Buffer.from(`${JSON.stringify(meta)}\n`, 'utf8');

  // Temp + rename so a reader never observes a half-written file, and blob
  // first so the meta is never ahead of the data it describes.
  const suffix = crypto.randomBytes(6).toString('hex');
  const blobTmp = `${p.blob}.${suffix}.tmp`;
  await fsp.writeFile(blobTmp, gzipped);
  await fsp.rename(blobTmp, p.blob);

  const metaTmp = `${p.meta}.${suffix}.tmp`;
  await fsp.writeFile(metaTmp, metaBuf);
  await fsp.rename(metaTmp, p.meta);

  if (!prev) profiles++;
  bytesOnDisk += gzipped.length + metaBuf.length - prevBlobBytes - prevMetaBytes;
  return meta;
}

export async function remove(id) {
  const p = pathsFor(id);
  let freed = 0;
  for (const file of [p.blob, p.meta]) {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) continue;
    freed += stat.size;
    await fsp.rm(file, { force: true });
  }
  if (freed > 0) {
    bytesOnDisk = Math.max(0, bytesOnDisk - freed);
    profiles = Math.max(0, profiles - 1);
  }
  return freed > 0;
}

/**
 * Delete profiles nobody has touched in PROFILE_TTL_DAYS, and any temp files
 * left behind by a crash. A phrase cannot be recovered, so an abandoned
 * profile is abandoned for good and holding it forever is just cost.
 */
export async function sweep() {
  const cutoff = Date.now() - config.profileTtlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  const shards = await fsp.readdir(config.dataDir, { withFileTypes: true }).catch(() => []);
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
    const dir = path.join(config.dataDir, shard.name);
    for (const entry of await fsp.readdir(dir).catch(() => [])) {
      if (entry.endsWith('.tmp')) {
        const stat = await fsp.stat(path.join(dir, entry)).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
          bytesOnDisk = Math.max(0, bytesOnDisk - stat.size);
          await fsp.rm(path.join(dir, entry), { force: true });
        }
        continue;
      }
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      const meta = readMeta(id);
      if (!meta || meta.updatedAt >= cutoff) continue;
      if (await remove(id)) {
        removed++;
        await removeOwnerPublications(id);
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Published lists
//
// A publication is a read-only public copy of one saved list:
//   published/<code[0:2]>/<code>.json   the public record
//   published/owners/<ownerId>.json     listId -> code, for republish/unpublish
//
// The owner is the scrypt-derived profile id, never the phrase, and it is
// never returned by the public read - it only lets the owner update or
// withdraw what they published.
// ---------------------------------------------------------------------------

/** Unambiguous lowercase alphabet: codes get read aloud and typed from screenshots. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const CODE_RE = /^[a-z0-9]{10}$/;

function publishedDir() {
  return path.join(config.dataDir, 'published');
}

function publicationPath(code) {
  return path.join(publishedDir(), code.slice(0, 2), `${code}.json`);
}

function ownerPath(ownerId) {
  return path.join(publishedDir(), 'owners', `${ownerId}.json`);
}

export function newCode() {
  let code = '';
  for (let i = 0; i < 10; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Write through a temp file so a reader never sees half a record, and keep the quota honest. */
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const prev = await fsp.stat(file).then((s) => s.size, () => 0);
  const buf = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, file);
  bytesOnDisk += buf.length - prev;
}

async function removeFile(file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return false;
  await fsp.rm(file, { force: true });
  bytesOnDisk = Math.max(0, bytesOnDisk - stat.size);
  return true;
}

export async function readPublication(code) {
  if (!CODE_RE.test(code)) return null;
  try {
    return JSON.parse(await fsp.readFile(publicationPath(code), 'utf8'));
  } catch {
    return null;
  }
}

/** @returns {Promise<Record<string, string>>} listId -> code */
export async function ownerIndex(ownerId) {
  try {
    const parsed = JSON.parse(await fsp.readFile(ownerPath(ownerId), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Create or replace the publication of one list. Republishing the same list
 * keeps its code, so a link someone already has keeps working and shows the
 * current contents.
 */
export async function savePublication({ ownerId, listId, name, words }) {
  const index = await ownerIndex(ownerId);
  const now = Date.now();
  let code = index[listId];
  const existing = code ? await readPublication(code) : null;
  if (!existing || existing.owner !== ownerId) {
    do code = newCode(); while (await readPublication(code));
  }
  const record = {
    code,
    owner: ownerId,
    listId,
    name,
    words,
    publishedAt: existing?.publishedAt ?? now,
    updatedAt: now,
  };
  // Record first, index second: a crash in between leaves an unindexed
  // publication (harmless, swept by age) rather than an index entry pointing
  // at nothing.
  await writeJson(publicationPath(code), record);
  if (index[listId] !== code) await writeJson(ownerPath(ownerId), { ...index, [listId]: code });
  return record;
}

export async function removePublication(ownerId, code) {
  const record = await readPublication(code);
  if (!record || record.owner !== ownerId) return false;
  await removeFile(publicationPath(code));
  const index = await ownerIndex(ownerId);
  const next = Object.fromEntries(Object.entries(index).filter(([, c]) => c !== code));
  if (Object.keys(next).length) await writeJson(ownerPath(ownerId), next);
  else await removeFile(ownerPath(ownerId));
  return true;
}

/** An account that is deleted or swept can no longer manage what it published. */
export async function removeOwnerPublications(ownerId) {
  const index = await ownerIndex(ownerId);
  for (const code of Object.values(index)) {
    const record = await readPublication(code);
    if (record?.owner === ownerId) await removeFile(publicationPath(code));
  }
  await removeFile(ownerPath(ownerId));
}
