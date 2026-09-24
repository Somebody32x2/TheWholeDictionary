/**
 * Identity: four words in, one 64-hex profile id out.
 *
 * There is no user table, no session and no cookie. The phrase is the whole
 * credential and the scrypt of it *is* the storage filename, so the server
 * never holds anything that could be stolen and replayed - it cannot even
 * enumerate which phrases exist without guessing them.
 *
 * A phrase is 4 words from a 7,772-word list, 51.7 bits. Combined with scrypt
 * at the default cost and the failure throttle below, online guessing is not a
 * practical attack; there is nothing to attack offline.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { WORDS } from './wordlist.js';

export const WORD_COUNT = 4;
/**
 * Exact because the wordlist is exact: every word is /^[a-z]{3,9}$/, so a
 * well-formed phrase can contain nothing but lowercase letters and three
 * spaces. Nothing that passes this can be a path traversal, a header
 * injection, or a log-forging newline.
 */
export const PHRASE_RE = /^[a-z]+( [a-z]+){3}$/;

/** scrypt is intentionally slow, so the same phrase is not re-derived per request. */
const idCache = new Map();
const ID_CACHE_MAX = 500;

/** Per-IP failure counts: [timestamps]. In memory; resets with the process. */
const failures = new Map();
const FAIL_DELAY_STEP_MS = 250;
const FAIL_DELAY_MAX_MS = 3000;

let pepper = null;

/**
 * Env wins; otherwise generate once and persist, because the id derivation is
 * peppered and a new pepper means every existing profile becomes unreachable.
 */
export function loadPepper() {
  if (pepper) return pepper;
  if (config.syncPepper) {
    pepper = Buffer.from(config.syncPepper, 'utf8');
    return pepper;
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, '.pepper');
  if (fs.existsSync(file)) {
    pepper = fs.readFileSync(file);
    return pepper;
  }
  pepper = crypto.randomBytes(32);
  fs.writeFileSync(file, pepper, { mode: 0o600 });
  console.log(`[auth] generated a new sync pepper at ${file} - back this up; losing it orphans every profile`);
  return pepper;
}

/** "Apple  Bright cloud DRUM" and "apple bright cloud drum" are one account. */
export function normalise(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isWellFormed(phrase) {
  return PHRASE_RE.test(phrase);
}

/**
 * Hex by construction, so it is safe to use directly as a path segment - no
 * escaping or sanitisation guesswork.
 */
export function idForPhrase(phrase) {
  const hit = idCache.get(phrase);
  if (hit) return hit;
  const id = crypto.scryptSync(phrase, loadPepper(), 32).toString('hex');
  if (idCache.size >= ID_CACHE_MAX) idCache.clear();
  idCache.set(phrase, id);
  return id;
}

/** crypto.randomInt, never Math.random: this is the only secret in the system. */
export function generatePhrase() {
  const picked = [];
  for (let i = 0; i < WORD_COUNT; i++) picked.push(WORDS[crypto.randomInt(WORDS.length)]);
  return picked.join(' ');
}

/** @returns {{refuse: boolean, delayMs: number}} */
export function failureState(ip) {
  const now = Date.now();
  const times = (failures.get(ip) ?? []).filter((t) => now - t < config.authFailWindowMs);
  if (times.length === 0) failures.delete(ip);
  else failures.set(ip, times);

  if (times.length >= config.authFailHard) return { refuse: true, delayMs: 0 };
  if (times.length < config.authFailSoft) return { refuse: false, delayMs: 0 };
  const delayMs = Math.min(
    FAIL_DELAY_MAX_MS,
    (times.length - config.authFailSoft + 1) * FAIL_DELAY_STEP_MS,
  );
  return { refuse: false, delayMs };
}

export function recordFailure(ip) {
  const now = Date.now();
  const times = (failures.get(ip) ?? []).filter((t) => now - t < config.authFailWindowMs);
  times.push(now);
  failures.set(ip, times);
}

/** A correct phrase always clears the counter - see the note in config.js. */
export function clearFailures(ip) {
  failures.delete(ip);
}

export function sweepFailures() {
  const now = Date.now();
  for (const [ip, times] of failures) {
    const live = times.filter((t) => now - t < config.authFailWindowMs);
    if (live.length === 0) failures.delete(ip);
    else failures.set(ip, live);
  }
}
