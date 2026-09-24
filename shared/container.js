/**
 * The TWD1 snapshot container: the one wire and disk format for a profile.
 *
 * Layout, all integers little-endian:
 *
 *   0   4   magic "TWD1"
 *   4   4   u32 headerLen
 *   8   H   header JSON, UTF-8
 *   then four sections, each a u32 byteLength followed by raw bytes:
 *           rating (u8*N), answeredAt (u32*N), durMs (u16*N), flags (u8*N)
 *   then, optionally, one more u32-length section:
 *           lists (UTF-8 JSON, see shared/lists.js)
 *
 * The lists section is trailing and optional so a snapshot written before
 * saved lists existed still decodes - to an empty list set - rather than
 * being rejected as truncated.
 *
 * Gzipped as a whole by the caller for storage and transport. Four parallel
 * typed arrays rather than a list of records because the arrays are mostly
 * zeros and mostly runs, which gzip eats; a JSON array of answered words would
 * be larger at every fill level above a few per cent and would need an index
 * rebuild on load.
 */

import { EPOCH_MINUTES } from './scales.js';
import { normaliseLists } from './lists.js';

/** Lists are small in practice; this bounds what a hostile body can make us parse. */
export const MAX_LISTS_BYTES = 8 * 1024 * 1024;

export const MAGIC = 'TWD1';
export const APP_ID = 'thewholedictionary';
export const MAX_HEADER_BYTES = 65536;

const MAGIC_BYTES = Uint8Array.from([0x54, 0x57, 0x44, 0x31]); // "TWD1"

/**
 * Host endianness. Typed-array views borrow the platform's byte order, so on a
 * big-endian host the multi-byte sections would be written backwards and a
 * profile would not survive a move between machines. Every real target is
 * little-endian; this just refuses to be silently wrong if one is not.
 */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * @typedef {object} Cursor
 * @property {number} alphabetical
 * @property {number} random
 */

/**
 * @typedef {object} Snapshot
 * @property {string} corpusVersion
 * @property {number} wordCount
 * @property {number} updatedAt      epoch ms
 * @property {Settings} settings
 * @property {Record<string, number>} settingsAt  key -> minutes since EPOCH_MINUTES
 * @property {Cursor} cursor
 * @property {Uint8Array} rating
 * @property {Uint32Array} answeredAt
 * @property {Uint16Array} durMs
 * @property {Uint8Array} flags
 * @property {import('./lists.js').WordList[]} lists
 */

/**
 * @typedef {object} Settings
 * @property {'seen'|'binary'|'graded'} scale
 * @property {'alphabetical'|'random'} order
 * @property {number} randomSeed
 * @property {number} tierMax
 * @property {boolean} skipAnswered
 * @property {'afterReveal'|'always'|'never'} showDefinition
 * @property {number} dailyMinutes
 */

/**
 * Synced settings only. Device-local ones deliberately never enter the
 * container - see client/src/lib/device.ts for why.
 *
 * @type {Readonly<Settings>}
 */
export const DEFAULT_SETTINGS = Object.freeze({
  scale: 'binary',
  order: 'alphabetical',
  randomSeed: 0,
  tierMax: 70,
  skipAnswered: true,
  // Headword first, definition on reveal, rating after that. A legacy
  // 'onDemand' value normalises to this default.
  showDefinition: 'afterReveal',
  dailyMinutes: 15,
});

export const SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));

const TIER_CHOICES = Object.freeze([35, 50, 60, 70, 80]);

/**
 * Coerce an arbitrary object into valid settings.
 *
 * Used on every decode, so a hand-edited export or a snapshot from a future
 * version can never put an unknown scale name into the rating loop. Unknown
 * keys are dropped rather than carried, which also keeps the merge's key set
 * bounded.
 *
 * @param {unknown} raw
 * @returns {Settings}
 */
export function normaliseSettings(raw) {
  const src = (raw && typeof raw === 'object') ? /** @type {Record<string, unknown>} */ (raw) : {};
  const num = (v, fallback, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
  };
  return {
    scale: ['seen', 'binary', 'graded'].includes(/** @type {string} */ (src.scale))
      ? /** @type {string} */ (src.scale) : DEFAULT_SETTINGS.scale,
    order: ['alphabetical', 'random'].includes(/** @type {string} */ (src.order))
      ? /** @type {string} */ (src.order) : DEFAULT_SETTINGS.order,
    randomSeed: num(src.randomSeed, 0, 0, 0xffffffff) >>> 0,
    tierMax: TIER_CHOICES.includes(Number(src.tierMax)) ? Number(src.tierMax) : DEFAULT_SETTINGS.tierMax,
    skipAnswered: typeof src.skipAnswered === 'boolean' ? src.skipAnswered : DEFAULT_SETTINGS.skipAnswered,
    showDefinition: ['afterReveal', 'always', 'never'].includes(/** @type {string} */ (src.showDefinition))
      ? /** @type {string} */ (src.showDefinition) : DEFAULT_SETTINGS.showDefinition,
    dailyMinutes: num(src.dailyMinutes, DEFAULT_SETTINGS.dailyMinutes, 1, 600),
  };
}

/** @param {unknown} raw @returns {Record<string, number>} */
export function normaliseSettingsAt(raw) {
  const src = (raw && typeof raw === 'object') ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const key of SETTING_KEYS) {
    const n = Number(src[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = Math.floor(n);
  }
  return out;
}

/**
 * A blank profile. `randomSeed` is the caller's job: it must be minted once and
 * then never change, or random-order position stops being portable.
 *
 * @param {string} corpusVersion
 * @param {number} wordCount
 * @param {Partial<Settings>} [settings]
 * @returns {Snapshot}
 */
export function emptySnapshot(corpusVersion, wordCount, settings = {}) {
  return {
    corpusVersion,
    wordCount,
    updatedAt: Date.now(),
    settings: normaliseSettings({ ...DEFAULT_SETTINGS, ...settings }),
    settingsAt: {},
    cursor: { alphabetical: 0, random: 0 },
    rating: new Uint8Array(wordCount),
    answeredAt: new Uint32Array(wordCount),
    durMs: new Uint16Array(wordCount),
    flags: new Uint8Array(wordCount),
    lists: [],
  };
}

/** @param {Uint32Array|Uint16Array} view @returns {Uint8Array} little-endian bytes */
function toLeBytes(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (LITTLE_ENDIAN) return bytes;
  const out = new Uint8Array(view.byteLength);
  const width = view.BYTES_PER_ELEMENT;
  for (let i = 0; i < view.length; i++) {
    for (let b = 0; b < width; b++) out[i * width + b] = bytes[i * width + (width - 1 - b)];
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} count
 * @param {Uint32ArrayConstructor|Uint16ArrayConstructor} Ctor
 */
function fromLeBytes(bytes, offset, count, Ctor) {
  const out = new Ctor(count);
  const dst = new Uint8Array(out.buffer);
  const width = out.BYTES_PER_ELEMENT;
  if (LITTLE_ENDIAN) {
    dst.set(bytes.subarray(offset, offset + count * width));
  } else {
    for (let i = 0; i < count; i++) {
      for (let b = 0; b < width; b++) dst[i * width + b] = bytes[offset + i * width + (width - 1 - b)];
    }
  }
  return out;
}

/**
 * @param {Snapshot} state
 * @returns {Uint8Array}
 */
export function encodeSnapshot(state) {
  const n = state.wordCount;
  if (!Number.isInteger(n) || n < 0) throw new Error('encodeSnapshot: bad wordCount');
  for (const [name, arr, len] of /** @type {const} */ ([
    ['rating', state.rating, n], ['answeredAt', state.answeredAt, n],
    ['durMs', state.durMs, n], ['flags', state.flags, n],
  ])) {
    if (!arr || arr.length !== len) throw new Error(`encodeSnapshot: ${name} length ${arr?.length} != ${len}`);
  }

  const header = {
    app: APP_ID,
    corpusVersion: String(state.corpusVersion ?? ''),
    wordCount: n,
    updatedAt: Number(state.updatedAt) || Date.now(),
    settings: normaliseSettings(state.settings),
    settingsAt: normaliseSettingsAt(state.settingsAt),
    cursor: {
      alphabetical: Math.max(0, Math.floor(Number(state.cursor?.alphabetical) || 0)),
      random: Math.max(0, Math.floor(Number(state.cursor?.random) || 0)),
    },
    epochMinutes: EPOCH_MINUTES,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) throw new Error('encodeSnapshot: header too large');

  const sections = [
    state.rating,
    toLeBytes(state.answeredAt),
    toLeBytes(state.durMs),
    state.flags,
    new TextEncoder().encode(JSON.stringify(normaliseLists(state.lists ?? []))),
  ];

  let total = 8 + headerBytes.length;
  for (const s of sections) total += 4 + s.byteLength;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(MAGIC_BYTES, 0);
  dv.setUint32(4, headerBytes.length, true);
  out.set(headerBytes, 8);

  let off = 8 + headerBytes.length;
  for (const s of sections) {
    dv.setUint32(off, s.byteLength, true);
    off += 4;
    out.set(s, off);
    off += s.byteLength;
  }
  return out;
}

/**
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Snapshot}
 */
export function decodeSnapshot(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8) throw new Error('decodeSnapshot: truncated');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new Error('decodeSnapshot: bad magic');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = dv.getUint32(4, true);
  if (headerLen > MAX_HEADER_BYTES) throw new Error('decodeSnapshot: header too large');
  if (8 + headerLen > bytes.length) throw new Error('decodeSnapshot: truncated header');

  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  } catch {
    throw new Error('decodeSnapshot: bad header JSON');
  }
  if (!header || header.app !== APP_ID) throw new Error('decodeSnapshot: not a dictionary snapshot');

  const n = Number(header.wordCount);
  if (!Number.isInteger(n) || n < 0 || n > 50_000_000) throw new Error('decodeSnapshot: bad wordCount');

  let off = 8 + headerLen;
  /** @param {number} width @param {string} name @returns {number} */
  const readLen = (width, name) => {
    if (off + 4 > bytes.length) throw new Error(`decodeSnapshot: truncated before ${name}`);
    const len = dv.getUint32(off, true);
    off += 4;
    if (len !== n * width) throw new Error(`decodeSnapshot: ${name} length ${len} != ${n * width}`);
    if (off + len > bytes.length) throw new Error(`decodeSnapshot: truncated in ${name}`);
    return len;
  };

  readLen(1, 'rating');
  const rating = bytes.slice(off, off + n);
  off += n;

  readLen(4, 'answeredAt');
  const answeredAt = fromLeBytes(bytes, off, n, Uint32Array);
  off += n * 4;

  readLen(2, 'durMs');
  const durMs = fromLeBytes(bytes, off, n, Uint16Array);
  off += n * 2;

  readLen(1, 'flags');
  const flags = bytes.slice(off, off + n);
  off += n;

  let lists = [];
  if (off < bytes.length) {
    if (off + 4 > bytes.length) throw new Error('decodeSnapshot: truncated before lists');
    const len = dv.getUint32(off, true);
    off += 4;
    if (len > MAX_LISTS_BYTES) throw new Error('decodeSnapshot: lists too large');
    if (off + len > bytes.length) throw new Error('decodeSnapshot: truncated in lists');
    try {
      lists = normaliseLists(JSON.parse(new TextDecoder().decode(bytes.subarray(off, off + len))));
    } catch {
      throw new Error('decodeSnapshot: bad lists JSON');
    }
  }

  return {
    corpusVersion: String(header.corpusVersion ?? ''),
    wordCount: n,
    updatedAt: Number(header.updatedAt) || 0,
    settings: normaliseSettings(header.settings),
    settingsAt: normaliseSettingsAt(header.settingsAt),
    cursor: {
      alphabetical: Math.max(0, Math.floor(Number(header.cursor?.alphabetical) || 0)),
      random: Math.max(0, Math.floor(Number(header.cursor?.random) || 0)),
    },
    rating,
    answeredAt,
    durMs,
    flags,
    lists,
  };
}

/**
 * Read only the header. The server uses this to check `corpusVersion` before
 * committing to a full decode of a 2 MB body.
 *
 * @param {Uint8Array} bytes
 */
export function peekHeader(bytes) {
  if (bytes.length < 8) throw new Error('peekHeader: truncated');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new Error('peekHeader: bad magic');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = dv.getUint32(4, true);
  if (headerLen > MAX_HEADER_BYTES || 8 + headerLen > bytes.length) throw new Error('peekHeader: truncated header');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  if (!header || header.app !== APP_ID) throw new Error('peekHeader: not a dictionary snapshot');
  return header;
}
