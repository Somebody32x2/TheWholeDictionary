#!/usr/bin/env node
/**
 * Build the shipped corpus from SCOWL (headword curation) and kaikki.org's
 * wiktextract dump (definitions).
 *
 * Run by hand on a dev machine, never in Docker: the inputs are ~2.9 GB and the
 * output is a committed build artefact. Content-addressed - `corpusVersion` is
 * a hash of the headword index - so rebuilding from the same inputs produces
 * the same ids and no profile needs migrating.
 *
 *   node tools/build-corpus.mjs --out corpus --tier-max 80
 *   node tools/build-corpus.mjs --out .tmp/corpus --sample 2000000   # smoke test
 *
 * Why this pair: SCOWL decides *which* words are real English with a frequency
 * tier attached (the "how much garbage" dial the app exposes as tierMax), and
 * Wiktionary decides what they mean. Either alone is wrong - SCOWL has no
 * definitions, and raw Wiktionary is full of proper nouns, affixes, and
 * inflected forms nobody would call a vocabulary item.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCOWL_URL = 'https://downloads.sourceforge.net/wordlist/scowl-2020.12.07.tar.gz';
const SCOWL_DIR = 'scowl-2020.12.07';
const KAIKKI_URL = 'https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz';

/** SCOWL size tiers, smallest (most common) first. */
const TIERS = [10, 20, 35, 40, 50, 55, 60, 70, 80, 95];
/** Only these list families: proper names, abbreviations and contractions are not vocabulary. */
const LIST_FAMILIES = ['english-words', 'american-words', 'variant_1-words', 'variant_2-words'];

/** Wiktionary parts of speech that are words a person can know. */
const KEEP_POS = new Set([
  'noun', 'verb', 'adj', 'adv', 'intj', 'prep', 'conj', 'det', 'pron', 'particle', 'article', 'num',
]);

/** Tags that mean "this sense is a pointer to another word", not a definition. */
const REJECT_SENSE_TAGS = new Set([
  'form-of', 'alt-of', 'abbreviation', 'initialism', 'acronym', 'misspelling', 'romanization',
]);

/** Senses that survive tag filtering but are still redirects in prose. */
const REDIRECT_GLOSS_RE = /^(alternative (form|spelling)|plural|obsolete form|misspelling|synonym|initialism|abbreviation|clipping|inflection|past participle|present participle|simple past) of\b/i;

/**
 * Definitions that only point at another word: "The quality of being
 * predaceous", "In a predatory manner", "The act of mobilizing". A printed
 * dictionary lists such derivatives under the main entry rather than as
 * entries of their own; here each would cost a separate answer while adding
 * no meaning the user has not already been asked about. The capture group is
 * the word pointed at.
 */
const POINTER_GLOSS_RES = [
  /^(?:the )?(?:quality|state|condition|fact|property|characteristic|trait|degree|measure)(?: or (?:quality|state|condition|fact|property|characteristic))? of being (?:very )?([a-z][a-z'-]*)\.?$/i,
  /^in an? ([a-z][a-z'-]*) (?:manner|way|fashion)\.?$/i,
  /^in a (?:manner|way) that is ([a-z][a-z'-]*)\.?$/i,
  /^to an? ([a-z][a-z'-]*) (?:degree|extent)\.?$/i,
  /^the (?:act|action|process|practice)(?: or (?:process|act|practice))? of ([a-z][a-z'-]*ing)\.?$/i,
];

/**
 * The headwords a pointer gloss may mean. "-ing" targets are verbs, so
 * `mobilizing` may be `mobilize`, `stopping` may be `stop`, `running` may be
 * `run`: every plausible stem is offered and whichever exists wins.
 */
function pointerTargets(gloss) {
  for (const re of POINTER_GLOSS_RES) {
    const m = re.exec(gloss);
    if (!m) continue;
    const word = m[1].toLowerCase();
    if (!word.endsWith('ing')) return [word];
    const stem = word.slice(0, -3);
    const out = [stem, `${stem}e`];
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) out.push(stem.slice(0, -1));
    return out;
  }
  return null;
}

/** De-prioritised, not rejected: a word whose only sense is archaic still exists. */
const WEAK_SENSE_TAGS = new Set(['obsolete', 'archaic', 'rare', 'dated']);

/**
 * Register tags. A sense carrying one is a real meaning but not the plain,
 * everyday one, so it ranks below an unlabelled sense.
 */
const REGISTER_TAGS = new Set([
  'slang', 'dialectal', 'nonstandard', 'colloquial', 'informal', 'vulgar',
  'derogatory', 'offensive', 'humorous', 'jargon',
]);

/**
 * Parenthetical labels that describe grammar rather than a field or register.
 * "(uncountable) The act of building" is a plain meaning; "(metallurgy, of
 * steel) Deoxidized" is not.
 */
const GRAMMAR_LABEL_RE = /^(countable|uncountable|transitive|intransitive|ambitransitive|gerund|plural|singular|usually|often|sometimes|attributive|predicative|not comparable|comparable|ergative|reflexive|figuratively|by extension|in the plural|also|especially|of [a-z ]+|with [a-z ]+)$/;

/**
 * Display ranks, best first. Field labels do not demote a sense: for a
 * technical word the labelled sense is the meaning (`quark` is a particle
 * before it is a cheese), and Wiktionary already lists the main sense first.
 * Only register and obsolescence push a sense down.
 */
const RANK_NORMAL = 0;
const RANK_REGISTER = 1;
const RANK_WEAK = 2;

const WORD_RE = /^[a-z][a-z'-]{1,27}$/;
const GLOSS_MAX = 180;
const SHARD_SIZE = 1000;
const MAX_POS_PER_WORD = 2;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: 'corpus', tierMax: 80, cache: path.join(root, 'tools', '.cache'), sample: 0, downloadOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--out': out.out = next(); break;
      case '--tier-max': out.tierMax = Number(next()); break;
      case '--cache': out.cache = path.resolve(next()); break;
      case '--sample': out.sample = Number(next()); break;
      case '--download-only': out.downloadOnly = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(root, args.out);

const fmt = (n) => n.toLocaleString('en-US');
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------------------
// Download with a local cache
// ---------------------------------------------------------------------------

async function download(url, dest) {
  if (fs.existsSync(dest) && (await fsp.stat(dest)).size > 0) {
    console.log(`  cached  ${path.basename(dest)}  ${mb((await fsp.stat(dest)).size)}`);
    return dest;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  console.log(`  fetch   ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const expected = Number(res.headers.get('content-length')) || 0;

  let seen = 0;
  let lastLog = Date.now();
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    seen += chunk.length;
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now();
      const pct = expected ? ` (${((seen / expected) * 100).toFixed(1)}%)` : '';
      console.log(`          ${mb(seen)}${pct}`);
    }
  });
  await pipeline(source, fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
  console.log(`  saved   ${path.basename(dest)}  ${mb(seen)}`);
  return dest;
}

// ---------------------------------------------------------------------------
// SCOWL
// ---------------------------------------------------------------------------

/**
 * @returns {Map<string, number>} word -> smallest tier it appears in.
 *
 * Smallest wins because a word present in the 10 list is common regardless of
 * also being in the 80 list; the tier is "how far down the frequency curve do
 * you have to go before this word shows up".
 */
async function buildTierMap(scowlRoot, tierMax) {
  const finalDir = path.join(scowlRoot, 'final');
  const entries = await fsp.readdir(finalDir);
  const map = new Map();
  const stats = { files: 0, lines: 0, rejected: 0 };

  for (const tier of TIERS) {
    if (tier > tierMax) continue;
    for (const family of LIST_FAMILIES) {
      const name = `${family}.${tier}`;
      if (!entries.includes(name)) continue;
      stats.files++;
      // Verified: these lists are pure ASCII in 2020.12.07, so latin1 is exact
      // and avoids a UTF-8 validation pass over every byte.
      const text = await fsp.readFile(path.join(finalDir, name), 'latin1');
      for (const raw of text.split('\n')) {
        const word = raw.trim();
        if (!word) continue;
        stats.lines++;
        if (!WORD_RE.test(word)) { stats.rejected++; continue; }
        const prev = map.get(word);
        if (prev === undefined || tier < prev) map.set(word, tier);
      }
    }
  }
  return { map, stats };
}

// ---------------------------------------------------------------------------
// Wiktextract
// ---------------------------------------------------------------------------

function cleanGloss(raw) {
  let g = String(raw).replace(/\s+/g, ' ').trim();
  if (!g) return '';
  if (g.length > GLOSS_MAX) {
    const cut = g.slice(0, GLOSS_MAX);
    const space = cut.lastIndexOf(' ');
    g = `${(space > GLOSS_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
  }
  return g;
}

/**
 * @returns {{gloss: string, rank: number, plain: boolean}|null} the leaf gloss of a usable sense.
 *
 * `plain` is separate from `rank`: it says the sense carries no field,
 * register or obsolescence label at all, which is the test for whether an
 * inflected form has an everyday meaning of its own.
 *
 * `glosses` is hierarchical: a sub-sense repeats its parent first, so the leaf
 * - the actual definition - is the last element. A leaf that *opens* with an
 * ellipsis is a continuation rather than a definition ("the" leads with
 * "...because it has already been mentioned"), so it is stitched back onto its
 * parent instead of being shown as a sentence fragment.
 *
 * `glosses` has the usage label stripped; `raw_glosses` keeps it. A labelled
 * sense is shown with its label, because without it a specialist meaning
 * reads as the main one: `killed` was displayed as plain "Deoxidized." when
 * the entry says "(metallurgy, of steel) Deoxidized."
 */
function senseGloss(sense) {
  if (!Array.isArray(sense?.glosses) || sense.glosses.length === 0) return null;
  if (sense.form_of || sense.alt_of) return null;
  const tags = Array.isArray(sense.tags) ? sense.tags : [];
  for (const tag of tags) if (REJECT_SENSE_TAGS.has(tag)) return null;

  const raw = String(sense.glosses[sense.glosses.length - 1] ?? '');
  const continuation = /^\s*(\.\.\.|…)/.test(raw);
  const parent = sense.glosses.length > 1 ? String(sense.glosses[sense.glosses.length - 2] ?? '') : '';
  const joined = continuation && parent
    ? `${parent.replace(/\s*(\.\.\.|…)\s*$/, '')} ${raw.replace(/^\s*(\.\.\.|…)\s*/, '')}`
    : raw;

  const rawLeaf = Array.isArray(sense.raw_glosses) ? String(sense.raw_glosses.at(-1) ?? '') : '';
  const label = /^\s*\(([^)]*)\)/.exec(rawLeaf)?.[1] ?? '';
  const fieldLabel = label.split(',').map((part) => part.trim().toLowerCase())
    .some((part) => part && !GRAMMAR_LABEL_RE.test(part));
  const topics = Array.isArray(sense.topics) && sense.topics.length > 0;

  const register = tags.some((t) => REGISTER_TAGS.has(t));
  const weak = tags.some((t) => WEAK_SENSE_TAGS.has(t));
  const rank = weak ? RANK_WEAK : register ? RANK_REGISTER : RANK_NORMAL;
  const plain = !fieldLabel && !topics && !register && !weak;

  const leaf = cleanGloss(fieldLabel && !continuation ? rawLeaf : joined);
  if (!leaf || leaf.length < 2) return null;
  const bare = cleanGloss(joined);
  if (REDIRECT_GLOSS_RE.test(bare)) return null;
  return { gloss: leaf, rank, plain, pointer: pointerTargets(bare) };
}

/**
 * Yield the dump one JSON record per line, splitting on `\n` and nothing else.
 *
 * Not `node:readline`: JSON strings may legally contain raw U+2028 / U+2029,
 * and Bun's readline treats those as line breaks where Node's does not. Under
 * Bun that cut records in half mid-string, so the same build produced a
 * different corpus depending on which runtime ran it. Splitting by hand makes
 * the result a function of the input bytes alone.
 */
async function* jsonLines(stream) {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of stream) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split('\n');
    rest = parts.pop();
    yield* parts;
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

/**
 * Stream the dump, keeping only English records for words SCOWL accepted.
 *
 * The `lang_code` probe before `JSON.parse` is what makes this finish: the
 * dump is every language, so ~86% of lines are discarded without ever
 * building an object.
 *
 * There is deliberately no cheap regex for the headword. wiktextract records
 * open with `"senses"` and carry the top-level `"word"` near the end, so the
 * first `"word":` in a line is almost always a nested one from a synonym or
 * derived-terms list - matching that dropped three quarters of every English
 * record on a word the entry merely mentions.
 */
async function scanDump(dumpPath, tierMap, sampleLines) {
  /** @type {Map<string, Map<string, {count: number, gloss: string, rank: number, plain: boolean}>>} */
  const defs = new Map();
  /** word -> the lemmas Wiktionary says it is an inflected form of. */
  /** @type {Map<string, Set<string>>} */
  const inflectionOf = new Map();
  /** Words with at least one sense that is more than a pointer to another word. */
  const substantive = new Set();
  /** word -> the words its pointer-only senses point at. */
  /** @type {Map<string, Set<string>>} */
  const pointsAt = new Map();
  const drops = {
    notEnglish: 0, notInScowl: 0, badPos: 0, noUsableSense: 0, parseError: 0, specialistInflection: 0, pointerOnly: 0,
  };
  let lines = 0;
  let englishRecords = 0;

  const stream = fs.createReadStream(dumpPath)
    .pipe(zlib.createGunzip({ chunkSize: 1 << 20 }));

  const started = Date.now();
  for await (const line of jsonLines(stream)) {
    lines++;
    if (sampleLines && lines > sampleLines) break;
    if (lines % 1_000_000 === 0) {
      const rate = Math.round(lines / ((Date.now() - started) / 1000));
      console.log(`  ${fmt(lines)} lines  ${fmt(defs.size)} words  ${fmt(rate)}/s`);
    }
    if (line.length < 20) continue;

    if (!line.includes('"lang_code": "en"') && !line.includes('"lang_code":"en"')) {
      drops.notEnglish++;
      continue;
    }

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      drops.parseError++;
      continue;
    }
    if (rec.lang_code !== 'en') { drops.notEnglish++; continue; }
    const word = rec.word;
    if (typeof word !== 'string') { drops.parseError++; continue; }
    if (!tierMap.has(word)) { drops.notInScowl++; continue; }
    englishRecords++;
    if (!KEEP_POS.has(rec.pos)) { drops.badPos++; continue; }

    let best = null;
    let count = 0;
    let plain = false;
    for (const sense of rec.senses ?? []) {
      // Noted before senseGloss rejects the sense: "past tense of kill" is not
      // a definition, but it is the fact that makes `killed` an inflection.
      for (const target of Array.isArray(sense?.form_of) ? sense.form_of : []) {
        const lemma = target?.word;
        if (typeof lemma !== 'string' || lemma === word) continue;
        let lemmas = inflectionOf.get(word);
        if (!lemmas) { lemmas = new Set(); inflectionOf.set(word, lemmas); }
        lemmas.add(lemma);
      }
      const found = senseGloss(sense);
      if (!found) continue;
      count++;
      plain ||= found.plain;
      if (found.pointer) {
        let targets = pointsAt.get(word);
        if (!targets) { targets = new Set(); pointsAt.set(word, targets); }
        for (const t of found.pointer) if (t !== word) targets.add(t);
      } else {
        substantive.add(word);
      }
      // Normal beats register beats obsolete; within a rank a real definition
      // beats one that only points at another word; otherwise the first wins.
      const key = found.rank * 2 + (found.pointer ? 1 : 0);
      if (!best || key < best.rank * 2 + (best.pointer ? 1 : 0)) best = found;
    }
    if (!best) { drops.noUsableSense++; continue; }

    let byPos = defs.get(word);
    if (!byPos) { byPos = new Map(); defs.set(word, byPos); }
    const prev = byPos.get(rec.pos);
    if (!prev) {
      byPos.set(rec.pos, { count, gloss: best.gloss, rank: best.rank, plain });
    } else {
      prev.count += count;
      prev.plain ||= plain;
      if (best.rank < prev.rank) { prev.gloss = best.gloss; prev.rank = best.rank; }
    }
  }
  stream.destroy();

  /*
   * An inflected form of a word we already have is not a separate vocabulary
   * item - knowing `kill` is knowing `killed`. It is kept only when it has a
   * plain meaning of its own (`left` the direction, `saw` the tool, `building`
   * the structure). One that survives solely on a specialist, slang or
   * obsolete sense (`killed` in metallurgy, `went` as an obsolete noun) is
   * dropped, or the headword would show that obscure sense as if it were the
   * word's meaning.
   */
  for (const [word, lemmas] of inflectionOf) {
    const byPos = defs.get(word);
    if (!byPos) continue;
    if ([...byPos.values()].some((def) => def.plain)) continue;
    if (![...lemmas].some((lemma) => defs.has(lemma))) continue;
    defs.delete(word);
    drops.specialistInflection++;
  }

  /*
   * A word whose every definition only points at another word - `predacity`,
   * "The quality of being predaceous" - is a run-on derivative, not a separate
   * item of vocabulary: knowing `predaceous` is knowing it. It is dropped when
   * the word it points at is itself an English headword (a SCOWL word counts
   * even without a definition of its own, since that means it is a variant or
   * inflection of one that has). The set is taken before any deletion, so a
   * chain of pointers collapses onto the word at its end.
   */
  const known = new Set(defs.keys());
  for (const [word, targets] of pointsAt) {
    if (substantive.has(word) || !defs.has(word)) continue;
    if (![...targets].some((t) => known.has(t) || tierMap.has(t))) continue;
    defs.delete(word);
    drops.pointerOnly++;
  }
  return { defs, drops, lines, englishRecords };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const gzip = (buf) => zlib.gzipSync(buf, { level: 9 });

/**
 * Two versions, deliberately.
 *
 * `corpusVersion` hashes the headword index alone, because that is exactly
 * what determines word ids: an identical index means identical ids, so a
 * rebuild that only changed a definition must not fire a profile migration.
 *
 * `assetVersion` hashes the payload bytes. Shard filenames are stable and are
 * served `immutable` for a year, so without it a gloss-only rebuild would
 * never reach a device that had already cached the old shard.
 */
async function emit(words, tierMap, defs, scowlRoot) {
  await fsp.mkdir(outDir, { recursive: true });

  const indexBuf = Buffer.from(`${words.join('\n')}\n`, 'utf8');
  const corpusVersion = crypto.createHash('sha256').update(indexBuf).digest('hex').slice(0, 12);

  const tiers = new Uint8Array(words.length);
  for (let i = 0; i < words.length; i++) tiers[i] = tierMap.get(words[i]) ?? 95;

  const files = [
    ['index.txt.gz', gzip(indexBuf)],
    ['tiers.bin.gz', gzip(Buffer.from(tiers.buffer, 0, tiers.length))],
  ];

  const shardCount = Math.ceil(words.length / SHARD_SIZE);
  for (let s = 0; s < shardCount; s++) {
    const from = s * SHARD_SIZE;
    const w = words.slice(from, from + SHARD_SIZE).map((word) => {
      const entry = [word];
      const chosen = [...defs.get(word).entries()]
        .sort((a, b) => a[1].rank - b[1].rank || b[1].count - a[1].count)
        .slice(0, MAX_POS_PER_WORD);
      for (const [pos, def] of chosen) entry.push(`${pos}|${def.gloss}`);
      return entry;
    });
    files.push([
      `shard-${String(s).padStart(4, '0')}.json.gz`,
      gzip(Buffer.from(JSON.stringify({ from, w }), 'utf8')),
    ]);
  }

  const assetHash = crypto.createHash('sha256');
  for (const [name, buf] of files) assetHash.update(name).update(buf);
  const assetVersion = assetHash.digest('hex').slice(0, 12);

  // Remove the previous build's shards first. Names are positional, so a
  // rebuild with fewer words would otherwise leave orphaned shards behind
  // that nothing references but everything ships.
  for (const name of await fsp.readdir(outDir)) {
    if (/^shard-\d{4}\.json\.gz$/.test(name) || name === 'ATTRIBUTION.md') {
      await fsp.rm(path.join(outDir, name));
    }
  }

  let bytes = 0;
  const write = async (name, buf) => {
    await fsp.writeFile(path.join(outDir, name), buf);
    bytes += buf.length;
  };
  for (const [name, buf] of files) await write(name, buf);

  /** @type {Record<string, number>} */
  const tierCounts = {};
  for (const t of tiers) tierCounts[t] = (tierCounts[t] ?? 0) + 1;

  const manifest = {
    corpusVersion,
    assetVersion,
    builtAt: new Date().toISOString(),
    wordCount: words.length,
    shardSize: SHARD_SIZE,
    shardCount,
    tierCounts,
    sources: [
      {
        name: 'Wiktionary (via kaikki.org wiktextract)',
        url: KAIKKI_URL,
        licence: 'CC BY-SA 4.0 (adaptation of Wiktionary text, CC BY-SA / GFDL)',
      },
      {
        name: 'SCOWL 2020.12.07',
        url: SCOWL_URL,
        licence: 'SCOWL licence (see ATTRIBUTION.txt)',
      },
    ],
  };
  await write('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  const scowlNotice = await fsp.readFile(path.join(scowlRoot, 'Copyright'), 'latin1');
  await write('ATTRIBUTION.txt', Buffer.from(attribution(scowlNotice), 'utf8'));

  return { corpusVersion, assetVersion, shardCount, tierCounts, bytes };
}

/**
 * The licence notices that must travel with the data.
 *
 * SCOWL's permission requires its copyright notice to appear in supporting
 * documentation, and its Copyright file carries the notices of the word lists
 * it incorporates too, so the whole file is reproduced verbatim rather than
 * summarised - a hand-typed quote is one typo away from misstating it.
 */
function attribution(scowlNotice) {
  return `DATA SOURCES AND LICENCES

The word list and definitions in corpus/ are derived works, generated by
tools/build-corpus.mjs. Nothing in corpus/ is written by hand.


DEFINITIONS - WIKTIONARY

Definitions are extracted from the English Wiktionary
(https://en.wiktionary.org/) via the kaikki.org wiktextract dump
(https://kaikki.org/). Wiktionary text is available under the Creative
Commons Attribution-ShareAlike licence and the GNU Free Documentation
Licence. The definitions here are truncated and reformatted, which makes this
corpus an adaptation, distributed under CC BY-SA 4.0
(https://creativecommons.org/licenses/by-sa/4.0/).

Attribution: the contributors of the English Wiktionary.


HEADWORDS AND FREQUENCY TIERS - SCOWL

Which strings count as English words, and the frequency tier of each, come
from SCOWL (Spell Checker Oriented Word Lists) 2020.12.07 by Kevin Atkinson,
http://wordlist.aspell.net/. Its copyright file follows in full.

-----------------------------------------------------------------------------
${scowlNotice.replace(/\r\n/g, '\n').trimEnd()}
-----------------------------------------------------------------------------


PASSPHRASE WORDS - EFF

Sync passphrases are drawn from the EFF Long Wordlist, copyright Joseph
Bonneau and the Electronic Frontier Foundation, licensed under CC BY 3.0 US
(https://creativecommons.org/licenses/by/3.0/us/). Source:
https://www.eff.org/dice. Four hyphenated entries were removed.
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log('inputs');
  const scowlTar = await download(SCOWL_URL, path.join(args.cache, 'scowl-2020.12.07.tar.gz'));
  const dump = await download(KAIKKI_URL, path.join(args.cache, 'raw-wiktextract-data.jsonl.gz'));
  if (args.downloadOnly) {
    console.log('download-only: done');
    return;
  }

  const scowlRoot = path.join(args.cache, SCOWL_DIR);
  if (!fs.existsSync(path.join(scowlRoot, 'final'))) {
    console.log('  extract scowl');
    // Windows bsdtar fails on the symlinked speller/ entries but still writes
    // final/ correctly, so the exit status is only fatal if final/ is missing.
    spawnSync('tar', ['-xzf', scowlTar], { cwd: args.cache, stdio: 'ignore' });
    if (!fs.existsSync(path.join(scowlRoot, 'final'))) {
      throw new Error(`tar failed to extract ${scowlRoot}/final`);
    }
  }

  console.log('scowl');
  const { map: tierMap, stats: scowlStats } = await buildTierMap(scowlRoot, args.tierMax);
  console.log(`  ${scowlStats.files} lists, ${fmt(scowlStats.lines)} lines, ${fmt(scowlStats.rejected)} rejected by /^[a-z][a-z'-]{1,27}$/`);
  console.log(`  ${fmt(tierMap.size)} distinct candidate headwords at tier <= ${args.tierMax}`);

  console.log('wiktextract');
  const { defs, drops, lines, englishRecords } = await scanDump(dump, tierMap, args.sample);

  const words = [...defs.keys()].sort();
  console.log(`  ${fmt(lines)} lines read, ${fmt(englishRecords)} English records for candidate words`);
  console.log(`  dropped: not English ${fmt(drops.notEnglish)}, not in SCOWL ${fmt(drops.notInScowl)}, unusable pos ${fmt(drops.badPos)}, no usable sense ${fmt(drops.noUsableSense)}, unparseable ${fmt(drops.parseError)}, specialist-only inflection ${fmt(drops.specialistInflection)}, pointer-only ${fmt(drops.pointerOnly)}`);
  console.log(`  ${fmt(words.length)} headwords kept, ${fmt(tierMap.size - words.length)} SCOWL words had no definition`);

  if (words.length === 0) throw new Error('no headwords survived; refusing to emit an empty corpus');

  console.log('emit');
  const result = await emit(words, tierMap, defs, scowlRoot);
  console.log(`  corpusVersion ${result.corpusVersion}  assetVersion ${result.assetVersion}`);
  console.log(`  ${fmt(words.length)} words in ${result.shardCount} shards -> ${mb(result.bytes)} in ${path.relative(root, outDir) || '.'}`);
  const tierRows = Object.keys(result.tierCounts).map(Number).sort((a, b) => a - b);
  for (const t of tierRows) console.log(`  tier ${String(t).padStart(2)}  ${fmt(result.tierCounts[t]).padStart(9)}`);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
