/**
 * Rating scales and the single band mapping every stats surface uses.
 *
 * A rating is one byte: `(scaleId << 4) | level`, with `0x00` meaning
 * unanswered. Packing the scale into the answer is what makes a profile that
 * switched scales half way through still legible - every answer carries the
 * scale it was given on, so nothing has to be reinterpreted later.
 *
 * Plain JS with JSDoc so the Express server and the Vite client import the very
 * same file. A byte written by the client must mean exactly what the server's
 * merge thinks it means; two copies of this table would eventually disagree.
 */

/** @typedef {'seen'|'binary'|'graded'} ScaleName */
/** @typedef {'unanswered'|'seen'|'unknown'|'partial'|'known'} Band */

export const SCALE_SEEN = 1;
export const SCALE_BINARY = 2;
export const SCALE_GRADED = 3;

/**
 * @type {Record<ScaleName, {id: number, name: ScaleName, levels: {level: number, label: string, band: Band}[]}>}
 */
export const SCALES = Object.freeze({
  seen: Object.freeze({
    id: SCALE_SEEN,
    name: 'seen',
    // Deliberately not a knowledge claim: one key, "I looked at this".
    levels: Object.freeze([
      Object.freeze({ level: 1, label: 'seen', band: /** @type {Band} */ ('seen') }),
    ]),
  }),
  binary: Object.freeze({
    id: SCALE_BINARY,
    name: 'binary',
    levels: Object.freeze([
      Object.freeze({ level: 1, label: "don't know", band: /** @type {Band} */ ('unknown') }),
      Object.freeze({ level: 2, label: 'know', band: /** @type {Band} */ ('known') }),
    ]),
  }),
  graded: Object.freeze({
    id: SCALE_GRADED,
    name: 'graded',
    levels: Object.freeze([
      Object.freeze({ level: 1, label: "don't know", band: /** @type {Band} */ ('unknown') }),
      Object.freeze({ level: 2, label: 'heard of', band: /** @type {Band} */ ('partial') }),
      Object.freeze({ level: 3, label: 'know', band: /** @type {Band} */ ('known') }),
      Object.freeze({ level: 4, label: 'know well', band: /** @type {Band} */ ('known') }),
    ]),
  }),
});

/** @type {ScaleName[]} */
export const SCALE_NAMES = Object.freeze(['seen', 'binary', 'graded']);

/** @type {Record<number, ScaleName>} */
const SCALE_BY_ID = Object.freeze({
  [SCALE_SEEN]: 'seen',
  [SCALE_BINARY]: 'binary',
  [SCALE_GRADED]: 'graded',
});

/** All five bands in display order. `seen` sits between the two because it is neither. */
/** @type {Band[]} */
export const BANDS = Object.freeze(['unanswered', 'seen', 'unknown', 'partial', 'known']);

export const BAND_LABELS = Object.freeze({
  unanswered: 'unanswered',
  seen: 'seen',
  unknown: "don't know",
  partial: 'heard of',
  known: 'know',
});

/**
 * One colour per band, shared by the stats bar and the settings ladders so a
 * level looks the same everywhere. Bright enough to read on #0e0d0c - an
 * earlier muted set sank into the background - but the unanswered track stays
 * quiet, because it is most of the bar for most of the dictionary.
 */
export const BAND_COLOURS = Object.freeze({
  unanswered: '#3a3733',
  seen: '#a39c90',
  unknown: '#dd7d62',
  partial: '#ddb24f',
  known: '#76c28a',
});

/** @param {number} byte */
export function scaleIdOf(byte) {
  return (byte >> 4) & 0x0f;
}

/** @param {number} byte */
export function levelOf(byte) {
  return byte & 0x0f;
}

/**
 * @param {number} scaleId
 * @param {number} level
 * @returns {number}
 */
export function encodeRating(scaleId, level) {
  return ((scaleId & 0x0f) << 4) | (level & 0x0f);
}

/** @param {number} byte @returns {ScaleName|null} */
export function scaleNameOf(byte) {
  return SCALE_BY_ID[scaleIdOf(byte)] ?? null;
}

/**
 * The one mapping from a stored byte to a reporting band.
 *
 * `partial` is never folded into `known` or `unknown`, and `seen` is never a
 * knowledge claim - it is excluded from every ratio the app reports. Anything
 * unrecognised reads as unanswered rather than guessing.
 *
 * @param {number} byte
 * @returns {Band}
 */
export function bandOf(byte) {
  switch (byte) {
    case 0x11: return 'seen';
    case 0x21: case 0x31: return 'unknown';
    case 0x32: return 'partial';
    case 0x22: case 0x33: case 0x34: return 'known';
    default: return 'unanswered';
  }
}

/** @param {number} byte - true for anything that counts toward a knowledge ratio. */
export function isRated(byte) {
  const band = bandOf(byte);
  return band === 'unknown' || band === 'partial' || band === 'known';
}

/** @param {number} byte - answered at all, including a bare `seen`. */
export function isAnswered(byte) {
  return bandOf(byte) !== 'unanswered';
}

/** @param {number} byte */
export function labelOf(byte) {
  const scale = scaleNameOf(byte);
  if (!scale) return '';
  const level = levelOf(byte);
  return SCALES[scale].levels.find((l) => l.level === level)?.label ?? '';
}

/** A timeout is not a knowledge claim, so auto-advance always records this. */
export const RATING_SEEN = encodeRating(SCALE_SEEN, 1);

/** Bits in the per-word flags byte. */
export const FLAG_PEEKED = 1;
export const FLAG_REVISED = 2;

/** Response times are stored in a Uint16; this value means "at least this long". */
export const DUR_CENSORED = 65535;

/** Minutes since 2025-01-01T00:00:00Z. Minute resolution gzips to almost nothing. */
export const EPOCH_MINUTES = 1735689600 / 60;

/** @param {number} [ms] @returns {number} minutes since EPOCH_MINUTES, floored, never negative. */
export function toEpochMinutes(ms = Date.now()) {
  return Math.max(0, Math.floor(ms / 60000) - EPOCH_MINUTES);
}

/** @param {number} minutes @returns {number} epoch ms */
export function fromEpochMinutes(minutes) {
  return (minutes + EPOCH_MINUTES) * 60000;
}
