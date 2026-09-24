/**
 * Server behaviour: identity, isolation, limits, and the merge.
 *
 * Boots the real `bun server/index.js` against scratch data directories, so
 * what is asserted here is what a deployed container does.
 */

import { afterAll, beforeAll, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { decodeSnapshot, emptySnapshot, encodeSnapshot } from '../shared/container.js';
import { encodeRating, SCALE_BINARY } from '../shared/scales.js';
import { listWords, newList, STARRED_ID, withoutWord, withWord } from '../shared/lists.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8241;
const API = `http://127.0.0.1:${PORT}/api`;

/**
 * A second instance that believes it sits behind two proxies, so a test can
 * play the appending proxy and hand it a chosen "real" client address. The
 * main instance trusts no proxy, which is the right default.
 */
const PROXY_PORT = 8242;
const PROXY_API = `http://127.0.0.1:${PROXY_PORT}/api`;

const N = 2048;
const CORPUS = 'testcorpus01';

let server: ChildProcess;
let proxied: ChildProcess;
let dataDir: string;
let proxyDataDir: string;

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start: ${url}`);
}

function boot(port: number, dir: string, extra: Record<string, string> = {}) {
  return spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dir,
      // A fixed pepper keeps ids stable and skips the first-boot file write.
      SYNC_PEPPER: 'test-pepper-not-a-secret',
      ACCOUNT_CREATE_WINDOW_MS: '60000',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'twd-test-'));
  proxyDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'twd-proxy-test-'));
  // Generous on the main instance: nearly every test mints an account, and a
  // shared per-IP budget would make unrelated tests fail each other. The limit
  // itself is exercised on the proxied instance, where each test can present a
  // distinct client address.
  server = boot(PORT, dataDir, { ACCOUNT_CREATE_MAX: '500', PUBLISH_MAX_WORDS: '50' });
  proxied = boot(PROXY_PORT, proxyDataDir, { TRUST_PROXY: '2', ACCOUNT_CREATE_MAX: '10' });
  server.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  proxied.stderr?.on('data', (d) => process.stderr.write(`[proxied] ${d}`));
  await waitFor(`${API}/health`);
  await waitFor(`${PROXY_API}/health`);
});

afterAll(async () => {
  server?.kill();
  proxied?.kill();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(proxyDataDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------

function snapshotWith(answers: Array<[number, number, number]>) {
  const s = emptySnapshot(CORPUS, N);
  for (const [id, level, minutes] of answers) {
    s.rating[id] = encodeRating(SCALE_BINARY, level);
    s.answeredAt[id] = minutes;
    s.durMs[id] = 1000 + id;
  }
  return Buffer.from(zlib.gzipSync(encodeSnapshot(s)));
}

async function push(key: string, body: Buffer, baseRev = 0, api = API) {
  return fetch(`${api}/snapshot`, {
    method: 'PUT',
    headers: {
      'X-Sync-Key': key,
      'X-Base-Rev': String(baseRev),
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(body),
  });
}

async function pull(key: string, api = API) {
  const res = await fetch(`${api}/snapshot`, { headers: { 'X-Sync-Key': key } });
  if (!res.ok) return { res, state: null };
  const raw = Buffer.from(await res.arrayBuffer());
  return { res, state: decodeSnapshot(zlib.gunzipSync(raw)) };
}

async function newAccount(api = API): Promise<string> {
  const res = await fetch(`${api}/account`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json() as { words: string; rev: number };
  return body.words;
}

// ---------------------------------------------------------------------------

test('POST /account mints a four-word lowercase phrase', async () => {
  const words = await newAccount();
  assert.match(words, /^[a-z]+( [a-z]+){3}$/);
  const second = await newAccount();
  assert.notEqual(words, second, 'phrases must not repeat');
});

test('health is public but its operational numbers are loopback-only', async () => {
  const res = await fetch(`${API}/health`);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  // The test client *is* loopback, so the numbers are present here; the point
  // of the assertion is that they are real rather than invented.
  assert.equal(typeof body.profiles, 'number');
  assert.equal(typeof body.quotaBytes, 'number');
});

test('a snapshot is unreadable with a different phrase', async () => {
  const mine = await newAccount();
  const theirs = await newAccount();
  const put = await push(mine, snapshotWith([[7, 2, 100]]));
  assert.equal(put.status, 200);

  const { res } = await pull(theirs);
  assert.equal(res.status, 404);
  const { state } = await pull(mine);
  assert.equal(state!.rating[7], encodeRating(SCALE_BINARY, 2));
});

test('two devices answering different words both survive a blind push', async () => {
  const key = await newAccount();

  const a = await push(key, snapshotWith([[5, 2, 500]]), 0);
  assert.equal(a.status, 200);
  // Device B never saw device A's write: it still believes the base is rev 0.
  const b = await push(key, snapshotWith([[900, 1, 600]]), 0);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('x-merged'), '1', 'the server absorbed state B did not send');

  const { state } = await pull(key);
  assert.equal(state!.rating[5], encodeRating(SCALE_BINARY, 2));
  assert.equal(state!.rating[900], encodeRating(SCALE_BINARY, 1));
  assert.equal(state!.answeredAt[5], 500);
  assert.equal(state!.answeredAt[900], 600);
});

test('the later answer wins when both devices answered the same word', async () => {
  const key = await newAccount();
  await push(key, snapshotWith([[11, 2, 1000]]), 0);
  await push(key, snapshotWith([[11, 1, 1001]]), 0);

  const { state } = await pull(key);
  assert.equal(state!.rating[11], encodeRating(SCALE_BINARY, 1));
  assert.equal(state!.answeredAt[11], 1001);

  // ...and an older write arriving late cannot undo it.
  await push(key, snapshotWith([[11, 2, 999]]), 0);
  const after = await pull(key);
  assert.equal(after.state!.rating[11], encodeRating(SCALE_BINARY, 1));
  assert.equal(after.state!.answeredAt[11], 1001);
});

test('re-pushing an unchanged snapshot does not bump the revision', async () => {
  const key = await newAccount();
  const body = snapshotWith([[3, 2, 42]]);
  const first = await push(key, body, 0);
  const firstRev = (await first.json() as { rev: number }).rev;
  const second = await push(key, body, firstRev);
  const secondRev = (await second.json() as { rev: number }).rev;
  assert.equal(secondRev, firstRev, 'an idempotent push must not make peers re-pull');
});

test('a corpusVersion mismatch is refused with the stored version', async () => {
  const key = await newAccount();
  await push(key, snapshotWith([[1, 2, 10]]), 0);

  const other = emptySnapshot('differentcorp', N);
  other.rating[2] = encodeRating(SCALE_BINARY, 2);
  const res = await push(key, Buffer.from(zlib.gzipSync(encodeSnapshot(other))), 1);
  assert.equal(res.status, 409);
  const body = await res.json() as { error: string; corpusVersion: string };
  assert.equal(body.error, 'corpus-version-mismatch');
  assert.equal(body.corpusVersion, CORPUS);
});

test('oversized and non-gzip bodies are refused', async () => {
  const key = await newAccount();

  const huge = Buffer.alloc(3 * 1024 * 1024, 0);
  huge[0] = 0x1f; huge[1] = 0x8b;
  const big = await push(key, huge, 0);
  assert.equal(big.status, 413);
  const bigBody = await big.json() as { maxBytes: number; size: number };
  assert.equal(bigBody.maxBytes, 2 * 1024 * 1024);
  assert.ok(bigBody.size > bigBody.maxBytes);

  const plain = await push(key, Buffer.from('this is not gzip at all'), 0);
  assert.equal(plain.status, 400);

  // Valid gzip, but not a TWD1 container.
  const notASnapshot = await push(key, Buffer.from(zlib.gzipSync(Buffer.from('hello'))), 0);
  assert.equal(notASnapshot.status, 400);
});

test('a missing X-Base-Rev is refused', async () => {
  const key = await newAccount();
  const res = await fetch(`${API}/snapshot`, {
    method: 'PUT',
    headers: { 'X-Sync-Key': key, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(snapshotWith([[1, 2, 5]])),
  });
  assert.equal(res.status, 400);
});

test('DELETE removes the profile', async () => {
  const key = await newAccount();
  await push(key, snapshotWith([[4, 2, 7]]), 0);
  const del = await fetch(`${API}/snapshot`, { method: 'DELETE', headers: { 'X-Sync-Key': key } });
  assert.equal(del.status, 200);
  const { res } = await pull(key);
  assert.equal(res.status, 404);
});

test('malformed sync keys are rejected before scrypt runs', async () => {
  const key = await newAccount();
  await push(key, snapshotWith([[1, 2, 1]]), 0);

  // Warm the id cache so the measured "valid" cost is scrypt on a cold phrase,
  // not on a cached one.
  const cold = await newAccount();
  const validStart = process.hrtime.bigint();
  await fetch(`${API}/meta`, { headers: { 'X-Sync-Key': cold } });
  const validNs = Number(process.hrtime.bigint() - validStart);

  const badStart = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${API}/meta`, { headers: { 'X-Sync-Key': 'not-a-valid-phrase' } });
    assert.equal(res.status, 401);
  }
  const badNs = Number(process.hrtime.bigint() - badStart) / 5;

  assert.ok(
    badNs < validNs,
    `a rejected key (${(badNs / 1e6).toFixed(2)}ms) must cost less than a derived one (${(validNs / 1e6).toFixed(2)}ms)`,
  );
});

test('account creation is rate limited per address', async () => {
  // Run against the proxied instance with a fixed chain, so this test owns a
  // rate-limit bucket no other test touches. TRUST_PROXY=2 means the client
  // is the second entry from the right.
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${PROXY_API}/account`, {
      method: 'POST',
      headers: { 'X-Forwarded-For': '198.51.100.7, 172.16.0.1' },
    });
    statuses.push(res.status);
  }
  assert.equal(statuses.slice(0, 10).every((s) => s === 200), true, `expected 10 successes, got ${statuses.join(',')}`);
  assert.ok(statuses.slice(10).every((s) => s === 429), `expected 429 after the limit, got ${statuses.join(',')}`);
});

test('X-Forwarded-For cannot buy a fresh rate-limit budget', async () => {
  // TRUST_PROXY=2 on this instance, so the client is two entries from the
  // right. The test plays the outer proxy: it appends its own view of the
  // peer, and anything the "client" prepended is ignored.
  const spoof = async (forwarded: string) => (await fetch(`${PROXY_API}/account`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': forwarded },
  })).status;

  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) {
    // Each request claims a different leftmost address; the real one - two
    // hops from the end - never changes.
    statuses.push(await spoof(`10.9.9.${i}, 203.0.113.50, 172.16.0.1`));
  }
  assert.ok(statuses.includes(429), `spoofed chain bought extra budget: ${statuses.join(',')}`);
});

test('the corpus route refuses anything that is not a corpus file', async () => {
  const bad = await fetch(`http://127.0.0.1:${PORT}/corpus/..%2F..%2Fpackage.json`);
  assert.notEqual(bad.status, 200);
  const alsoBad = await fetch(`http://127.0.0.1:${PORT}/corpus/shard-9.json.gz`);
  assert.notEqual(alsoBad.status, 200);
});

// ---------------------------------------------------------------------------
// Saved lists and publishing
// ---------------------------------------------------------------------------

async function publish(key: string, body: unknown) {
  return fetch(`${API}/lists`, {
    method: 'POST',
    headers: { 'X-Sync-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('publishing requires an account', async () => {
  const res = await fetch(`${API}/lists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ listId: 'abc', name: 'x', words: ['dog'] }),
  });
  assert.equal(res.status, 401);
});

test('a published list is publicly readable, deduplicated, and hides its owner', async () => {
  const key = await newAccount();
  const res = await publish(key, { listId: 'animals', name: '  My   animals ', words: ['dog', 'aardvark', 'dog'] });
  assert.equal(res.status, 200);
  const { code, count } = await res.json() as { code: string; count: number };
  assert.match(code, /^[a-z0-9]{10}$/);
  assert.equal(count, 2);

  const pub = await fetch(`${API}/lists/${code}`);
  assert.equal(pub.status, 200);
  const body = await pub.json() as Record<string, unknown>;
  assert.equal(body.name, 'My animals');
  assert.deepEqual(body.words, ['dog', 'aardvark']);
  assert.equal(body.owner, undefined, 'the owner id must never be public');
  assert.equal(body.listId, undefined);
});

test('only real headwords can be published', async () => {
  const key = await newAccount();
  const res = await publish(key, { listId: 'spam', name: 'Spam', words: ['dog', 'buy-cheap-pills', 'zzqqxx'] });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; words: string[] };
  assert.equal(body.error, 'unknown-words');
  assert.deepEqual(body.words, ['buy-cheap-pills', 'zzqqxx']);
});

test('empty and oversized lists are refused', async () => {
  const key = await newAccount();
  assert.equal((await publish(key, { listId: 'e', name: 'Empty', words: [] })).status, 400);
  const big = await publish(key, { listId: 'b', name: 'Big', words: Array(51).fill('dog') });
  assert.equal(big.status, 413);
  assert.equal((await big.json() as { maxWords: number }).maxWords, 50);
});

test('republishing a list keeps its link and updates its contents', async () => {
  const key = await newAccount();
  const first = await (await publish(key, { listId: 'l1', name: 'One', words: ['dog'] })).json() as { code: string };
  const second = await (await publish(key, { listId: 'l1', name: 'One, revised', words: ['dog', 'serendipity'] })).json() as { code: string };
  assert.equal(second.code, first.code, 'a shared link must survive an update');
  const body = await (await fetch(`${API}/lists/${first.code}`)).json() as { name: string; words: string[] };
  assert.equal(body.name, 'One, revised');
  assert.deepEqual(body.words, ['dog', 'serendipity']);
});

test('only the owner can unpublish, and a stranger cannot tell the list exists', async () => {
  const owner = await newAccount();
  const stranger = await newAccount();
  const { code } = await (await publish(owner, { listId: 'mine', name: 'Mine', words: ['dog'] })).json() as { code: string };

  const denied = await fetch(`${API}/lists/${code}`, { method: 'DELETE', headers: { 'X-Sync-Key': stranger } });
  assert.equal(denied.status, 404);
  assert.equal((await fetch(`${API}/lists/${code}`)).status, 200);

  const ok = await fetch(`${API}/lists/${code}`, { method: 'DELETE', headers: { 'X-Sync-Key': owner } });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${API}/lists/${code}`)).status, 404);
});

test('deleting an account withdraws its publications', async () => {
  const key = await newAccount();
  await push(key, snapshotWith([[1, 2, 1]]), 0);
  const { code } = await (await publish(key, { listId: 'gone', name: 'Gone', words: ['dog'] })).json() as { code: string };
  await fetch(`${API}/snapshot`, { method: 'DELETE', headers: { 'X-Sync-Key': key } });
  assert.equal((await fetch(`${API}/lists/${code}`)).status, 404);
});

test('saved lists sync and merge through the server, removals included', async () => {
  const key = await newAccount();
  const withLists = (lists: ReturnType<typeof newList>[]) => {
    const s = emptySnapshot(CORPUS, N);
    s.lists = lists;
    return Buffer.from(zlib.gzipSync(encodeSnapshot(s)));
  };
  const starred = newList(STARRED_ID, '', 1);

  // Device A stars dog; device B, never having seen that, stars cat.
  await push(key, withLists([withWord(starred, 'dog', 100)]), 0);
  await push(key, withLists([withWord(starred, 'cat', 200)]), 0);
  let { state } = await pull(key);
  assert.deepEqual(listWords(state!.lists.find((l) => l.id === STARRED_ID)!), ['dog', 'cat']);

  // Later, B unstars dog. The server must not resurrect it from A's copy.
  await push(key, withLists([withoutWord(withWord(withWord(starred, 'dog', 100), 'cat', 200), 'dog', 300)]), 0);
  ({ state } = await pull(key));
  assert.deepEqual(listWords(state!.lists.find((l) => l.id === STARRED_ID)!), ['cat']);
});
