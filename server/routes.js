/**
 * The sync API. No sessions, no cookies, no CORS.
 *
 * The interesting one is PUT /snapshot: it merges server-side with the same
 * shared/merge.js the client uses. Because that merge is commutative and
 * idempotent, a stale `X-Base-Rev` is not an error - a late write cannot undo
 * a newer one - so the usual optimistic-concurrency 409 dance is gone and two
 * devices can push blind, in any order, without a conflict ever existing.
 *
 * /lists publishes a saved list as a public, read-only page.
 */

import express from 'express';
import zlib from 'node:zlib';

import { config } from './config.js';
import { clientIp, httpError, isLoopback, RateLimiter, sleep } from './util.js';
import * as auth from './auth.js';
import * as storage from './storage.js';
import { headwords } from './headwords.js';
import { decodeSnapshot, encodeSnapshot, peekHeader } from '../shared/container.js';
import { mergeSnapshots } from '../shared/merge.js';
import { cleanListName, LIST_ID_RE } from '../shared/lists.js';

/**
 * Ceiling on gunzip output. Four arrays at eight bytes per word plus a header
 * is ~2.5 MB for a 300k-word corpus; 32 MB leaves room for a much larger
 * dictionary while still refusing a compression bomb outright.
 */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export function createRouter() {
  const router = express.Router();

  const limits = {
    account: new RateLimiter(config.accountCreateMax, config.accountCreateWindowMs),
    read: new RateLimiter(config.snapshotReadMax, config.snapshotReadWindowMs),
    write: new RateLimiter(config.snapshotWriteMax, config.snapshotWriteWindowMs),
    del: new RateLimiter(config.snapshotDeleteMax, config.snapshotDeleteWindowMs),
    publish: new RateLimiter(config.publishRateMax, config.publishRateWindowMs),
  };
  const sweeper = setInterval(() => {
    for (const limiter of Object.values(limits)) limiter.sweep();
    auth.sweepFailures();
  }, 5 * 60_000);
  sweeper.unref();

  /** @param {RateLimiter} limiter */
  const limit = (limiter) => (req, _res, next) => {
    const ip = clientIp(req);
    const { allowed, retryAfterMs } = limiter.check(ip);
    if (!allowed) {
      return next(httpError(429, 'Too many requests', {
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      }));
    }
    req.rateKey = { limiter, ip };
    next();
  };

  /**
   * Resolve the phrase to a profile id.
   *
   * Mounted *before* any body parser on purpose: an unauthenticated request
   * must never be able to make this process allocate a two-megabyte buffer.
   * The regex check runs before scrypt for the same reason - junk keys are
   * refused for free, so flooding malformed phrases costs the attacker more
   * than it costs the server.
   */
  const requireAuth = async (req, _res, next) => {
    const ip = clientIp(req);
    const phrase = auth.normalise(req.headers['x-sync-key']);

    if (!auth.isWellFormed(phrase)) {
      auth.recordFailure(ip);
      return next(httpError(401, 'Invalid sync key'));
    }

    const state = auth.failureState(ip);
    if (state.refuse) {
      return next(httpError(429, 'Too many failed attempts', { retryAfterSeconds: 900 }));
    }
    if (state.delayMs) await sleep(state.delayMs);

    req.profileId = auth.idForPhrase(phrase);
    req.clientAddress = ip;
    next();
  };

  // -- health ---------------------------------------------------------------

  router.get('/health', (req, res) => {
    const body = { ok: true };
    // Operational numbers are not public: they would tell a stranger how many
    // profiles exist and how close the disk is to its ceiling.
    if (isLoopback(req)) Object.assign(body, storage.stats());
    res.json(body);
  });

  // -- account --------------------------------------------------------------

  router.post('/account', limit(limits.account), express.json({ limit: '16kb' }), (_req, res, next) => {
    if (storage.overQuota()) return next(httpError(507, 'Storage full'));
    // Generated server-side: a client that picked its own phrase would sooner
    // or later pick a guessable one, and the phrase is the entire credential.
    res.json({ words: auth.generatePhrase(), rev: 0 });
  });

  // -- meta -----------------------------------------------------------------

  router.get('/meta', limit(limits.read), requireAuth, (req, res, next) => {
    const meta = storage.readMeta(req.profileId);
    if (!meta) {
      auth.recordFailure(req.clientAddress);
      return next(httpError(404, 'empty', { rev: 0 }));
    }
    auth.clearFailures(req.clientAddress);
    req.rateKey?.limiter.pardon(req.rateKey.ip);
    res.json({
      rev: meta.rev,
      updatedAt: meta.updatedAt,
      bytes: meta.bytes,
      corpusVersion: meta.corpusVersion,
    });
  });

  // -- snapshot -------------------------------------------------------------

  router.get('/snapshot', limit(limits.read), requireAuth, (req, res, next) => {
    const meta = storage.readMeta(req.profileId);
    const blob = meta ? storage.readSnapshot(req.profileId) : null;
    if (!meta || !blob) {
      auth.recordFailure(req.clientAddress);
      return next(httpError(404, 'empty', { rev: 0 }));
    }
    auth.clearFailures(req.clientAddress);
    req.rateKey?.limiter.pardon(req.rateKey.ip);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Rev', String(meta.rev));
    res.setHeader('X-Updated-At', String(meta.updatedAt));
    res.setHeader('X-Corpus-Version', meta.corpusVersion ?? '');
    res.send(blob);
  });

  router.put(
    '/snapshot',
    limit(limits.write),
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: config.maxSnapshotBytes + 8192 }),
    async (req, res, next) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return next(httpError(400, 'Expected a gzipped snapshot body'));
      }
      if (body.length > config.maxSnapshotBytes) {
        return next(httpError(413, 'Snapshot too large', {
          maxBytes: config.maxSnapshotBytes,
          size: body.length,
        }));
      }
      if (body[0] !== GZIP_MAGIC_0 || body[1] !== GZIP_MAGIC_1) {
        return next(httpError(400, 'Body is not gzip'));
      }

      let raw;
      try {
        raw = zlib.gunzipSync(body, { maxOutputLength: MAX_INFLATED_BYTES });
      } catch {
        return next(httpError(400, 'Body is not valid gzip'));
      }

      let incoming;
      try {
        peekHeader(raw);
        incoming = decodeSnapshot(raw);
      } catch (err) {
        return next(httpError(400, `Malformed snapshot: ${err.message}`));
      }

      auth.clearFailures(req.clientAddress);

      const id = req.profileId;
      const prevMeta = storage.readMeta(id);
      const baseRev = Number.parseInt(String(req.headers['x-base-rev'] ?? ''), 10);
      if (!Number.isFinite(baseRev)) {
        return next(httpError(400, 'X-Base-Rev header is required'));
      }

      let toStore = incoming;
      let absorbed = 0;

      if (prevMeta) {
        if (prevMeta.corpusVersion && prevMeta.corpusVersion !== incoming.corpusVersion) {
          return next(httpError(409, 'corpus-version-mismatch', {
            corpusVersion: prevMeta.corpusVersion,
          }));
        }
        const storedBlob = storage.readSnapshot(id);
        if (storedBlob) {
          let stored;
          try {
            stored = decodeSnapshot(zlib.gunzipSync(storedBlob, { maxOutputLength: MAX_INFLATED_BYTES }));
          } catch (err) {
            // A corrupt blob must not brick the account; the incoming state is
            // a complete profile on its own, so take it and move on.
            console.error('[storage] unreadable snapshot, replacing', id.slice(0, 8), err.message);
            stored = null;
          }
          if (stored) {
            let merged;
            try {
              merged = mergeSnapshots(stored, incoming);
            } catch (err) {
              return next(httpError(409, 'corpus-version-mismatch', {
                corpusVersion: prevMeta.corpusVersion ?? stored.corpusVersion,
                detail: err.message,
              }));
            }
            toStore = merged.state;
            absorbed = merged.changedFromB;
            // A stale base rev is informational, not fatal: an element-wise
            // merge cannot lose a write, whatever order it arrives in.
            if (baseRev !== prevMeta.rev) {
              console.log(`[sync] stale base rev ${baseRev} != ${prevMeta.rev} for ${id.slice(0, 8)} (merged)`);
            }
            if (merged.changedFromA === 0 && sameHeader(stored, merged.state)) {
              // Nothing new. Writing anyway would bump the revision and make
              // every other device re-pull a snapshot it already has.
              res.setHeader('X-Merged', absorbed ? '1' : '0');
              return res.json({ rev: prevMeta.rev, updatedAt: prevMeta.updatedAt, merged: absorbed > 0 });
            }
          }
        }
      }

      toStore.updatedAt = Date.now();
      const gzipped = zlib.gzipSync(encodeSnapshot(toStore), { level: 6 });
      const delta = gzipped.length - (prevMeta?.bytes ?? 0);
      if (storage.overQuota(delta)) return next(httpError(507, 'Storage full'));

      const meta = await storage.writeSnapshot(id, gzipped, toStore.corpusVersion);
      res.setHeader('X-Merged', absorbed ? '1' : '0');
      res.json({ rev: meta.rev, updatedAt: meta.updatedAt, merged: absorbed > 0 });
    },
  );

  router.delete('/snapshot', limit(limits.del), requireAuth, async (req, res) => {
    await storage.remove(req.profileId);
    // Nobody can manage these once the account is gone, so they go with it.
    await storage.removeOwnerPublications(req.profileId);
    auth.clearFailures(req.clientAddress);
    res.json({ ok: true });
  });

  // -- published lists ----------------------------------------------------

  router.post(
    '/lists',
    limit(limits.publish),
    requireAuth,
    express.json({ limit: '256kb' }),
    async (req, res, next) => {
      const body = req.body ?? {};
      const listId = String(body.listId ?? '');
      const name = cleanListName(body.name);
      if (!LIST_ID_RE.test(listId)) return next(httpError(400, 'Invalid list id'));
      if (!name) return next(httpError(400, 'A published list needs a name'));
      if (!Array.isArray(body.words)) return next(httpError(400, 'words must be an array'));
      if (body.words.length === 0) return next(httpError(400, 'Cannot publish an empty list'));
      if (body.words.length > config.publishMaxWords) {
        return next(httpError(413, 'List too long to publish', { maxWords: config.publishMaxWords, size: body.words.length }));
      }

      let known;
      try {
        known = await headwords();
      } catch {
        return next(httpError(503, 'Corpus unavailable'));
      }
      const words = [];
      const seen = new Set();
      const unknown = [];
      for (const raw of body.words) {
        const word = String(raw ?? '');
        if (!known.has(word)) { unknown.push(word.slice(0, 40)); continue; }
        if (seen.has(word)) continue;
        seen.add(word);
        words.push(word);
      }
      if (unknown.length) {
        return next(httpError(400, 'unknown-words', { words: unknown.slice(0, 10) }));
      }

      const index = await storage.ownerIndex(req.profileId);
      if (!index[listId] && Object.keys(index).length >= config.publishMaxPerOwner) {
        return next(httpError(409, 'publish-limit', { limit: config.publishMaxPerOwner }));
      }
      if (storage.overQuota(JSON.stringify(words).length + 512)) return next(httpError(507, 'Storage full'));

      const record = await storage.savePublication({ ownerId: req.profileId, listId, name, words });
      auth.clearFailures(req.clientAddress);
      res.json({ code: record.code, publishedAt: record.publishedAt, updatedAt: record.updatedAt, count: words.length });
    },
  );

  /** Public: anyone with the code may read. The owner id is never returned. */
  router.get('/lists/:code', limit(limits.read), async (req, res, next) => {
    const record = await storage.readPublication(String(req.params.code));
    if (!record) return next(httpError(404, 'No such list'));
    req.rateKey?.limiter.pardon(req.rateKey.ip);
    res.setHeader('Cache-Control', 'no-cache');
    res.json({
      code: record.code,
      name: record.name,
      words: record.words,
      count: record.words.length,
      publishedAt: record.publishedAt,
      updatedAt: record.updatedAt,
    });
  });

  /** Only the owner may withdraw; anyone else gets the same 404 as a missing code. */
  router.delete('/lists/:code', limit(limits.publish), requireAuth, async (req, res, next) => {
    const removed = await storage.removePublication(req.profileId, String(req.params.code));
    if (!removed) return next(httpError(404, 'No such list'));
    res.json({ ok: true });
  });

  router.use((_req, _res, next) => next(httpError(404, 'Not found')));

  return router;
}

/** Settings and cursor equality - the parts of a snapshot outside the arrays. */
function sameHeader(a, b) {
  return JSON.stringify(a.settings) === JSON.stringify(b.settings)
    && JSON.stringify(a.settingsAt) === JSON.stringify(b.settingsAt)
    && a.cursor.alphabetical === b.cursor.alphabetical
    && a.cursor.random === b.cursor.random;
}
