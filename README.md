# The Whole Dictionary

Walk an entire English dictionary one word at a time, record whether you know
each word, and find out how large your vocabulary actually is.

Each word appears alone on a black field. Press <kbd>Space</kbd> (or tap) to
reveal its definition, then rate it with the number keys — <kbd>1</kbd> don't
know, <kbd>2</kbd> know, or <kbd>1</kbd>–<kbd>4</kbd> on the graded scale. A row
of quiet control boxes under the word shows what the current step accepts.
Response time is measured from the word appearing to the reveal, so reading the
definition never counts against you.

- **122,953 headwords** with definitions, built from Wiktionary and SCOWL, with
  inflected forms (`walked`, `killed`) folded into their lemmas.
- **Offline-first PWA.** The dictionary arrives 1,000 words at a time; the
  whole thing cached is under 5 MB.
- **Starred words and saved lists**, publishable as read-only pages at a short
  link that anyone can open without an account.
- **Optional sync** behind a four-word passphrase. No email, no password, no
  recovery: the server stores a one-way hash and a compressed blob.
- **Merge, never conflict.** Progress and lists join element-wise, so two
  devices can edit offline and meet in any order without losing anything.

## Keys

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> / <kbd>Enter</kbd> | reveal the definition |
| <kbd>1</kbd>–<kbd>4</kbd> | rate the word (after the reveal) |
| <kbd>←</kbd> / <kbd>→</kbd> | step back to the previous word / restore it |
| <kbd>F</kbd> | star the word |
| <kbd>L</kbd> | add the word to a list |
| <kbd>S</kbd> / <kbd>T</kbd> | settings / statistics |
| <kbd>Esc</kbd> | back |

All answer keys can be rebound in settings.

## Running it

Requires [Bun](https://bun.sh) 1.2 or newer.

```bash
bun install
bun run dev        # app on :5173, API on :8080
bun test           # unit and server tests
bunx svelte-check  # types
```

Production:

```bash
bun run build
bun start          # http://localhost:8080
```

The dictionary in `corpus/` is committed. To regenerate it from source
(downloads ~2.9 GB into `tools/.cache/`, takes a couple of minutes):

```bash
bun run corpus
```

## How it works

**Ratings.** Each answer is one byte, `(scale << 4) | level`, so every answer
remembers the scale it was given on and switching scales never reinterprets old
answers. "Heard of" is always its own band, and "seen" (what an auto-advance
timeout records) is never counted as knowing a word.

**Storage.** Progress is four parallel typed arrays indexed by word id:
rating, answer time, response time and flags. They compress to almost nothing,
and one pass over them produces every statistic.

**Sync.** Snapshots merge element-wise (later answer wins, flags union), which
is commutative and idempotent. The server merges with the same code the client
uses, so a stale write can never undo a newer one and there is no conflict
dialog. Saved lists merge the same way: each add or remove is timestamped, so
unstarring on one device is never undone by another.

**Corpus.** `tools/build-corpus.mjs` intersects SCOWL (which strings are English
words, and how common) with the kaikki.org Wiktionary extract (what they mean).
It drops proper nouns, abbreviations, redirects and inflected forms that have no
meaning of their own, and keeps field labels such as "(nautical)" on specialist
senses. `corpusVersion` hashes the word list and decides word ids; when it
changes, existing profiles are re-keyed by headword automatically.

## API

Authentication is an `X-Sync-Key` header carrying the four words.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | liveness |
| POST | `/api/account` | mints a passphrase |
| GET | `/api/meta` | revision of the stored snapshot |
| GET / PUT / DELETE | `/api/snapshot` | read, merge-write, or delete the profile |
| POST | `/api/lists` | publish or republish a saved list |
| GET | `/api/lists/:code` | read a published list (public) |
| DELETE | `/api/lists/:code` | withdraw a published list (owner only) |

Published lists may only contain headwords from the shipped dictionary, and the
owner is never exposed.

## Deploying

A two-stage `Dockerfile` is included (Bun on Alpine, runs as a non-root user,
built-in health check).

| Setting | Purpose |
| --- | --- |
| build arg + env `BASE_PATH` | mount point, e.g. `/dictionary`; omit for the root |
| env `TRUST_PROXY` | number of reverse proxies in front (default `1`) |
| env `CLIENT_IP_HEADER` + `CLIENT_IP_HEADER_FROM` | behind a CDN whose forwarded headers the proxy drops, e.g. `cf-connecting-ip` + `cloudflare`; the header is trusted only from those ranges |
| env `SYNC_PEPPER` | optional; overrides the generated pepper |
| volume `/data` | profiles and published lists — **required** |
| port `8080` | HTTP |

The app works whether or not the reverse proxy strips `BASE_PATH`.

> **Back up `/data/.pepper`.** Profile ids are `scrypt(passphrase, pepper)`.
> Lose the pepper and every existing passphrase stops resolving.

Rate limits, the storage quota and published-list limits are all set by
environment variables; see `server/config.js`.

## Licence

The code is MIT-licensed.

The data carries its sources' licences, reproduced in full in
[`corpus/ATTRIBUTION.txt`](corpus/ATTRIBUTION.txt) and linked from the app:

- **Definitions** are adapted from the English
  [Wiktionary](https://en.wiktionary.org/) (via [kaikki.org](https://kaikki.org/))
  and distributed under
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **Headwords and frequency tiers** come from
  [SCOWL 2020.12.07](http://wordlist.aspell.net/) by Kevin Atkinson, under the
  SCOWL copyright notice.
- **Passphrase words** are the [EFF Long Wordlist](https://www.eff.org/dice),
  © Joseph Bonneau and the EFF,
  [CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/).
