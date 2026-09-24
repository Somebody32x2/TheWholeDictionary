/**
 * Container contracts. A snapshot that does not survive a round trip byte for
 * byte is a silently corrupted profile, and a decoder that accepts a truncated
 * body hands garbage to the merge, so both are asserted rather than assumed.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  APP_ID,
  decodeSnapshot,
  encodeSnapshot,
  emptySnapshot,
  normaliseSettings,
  peekHeader,
} from '../shared/container.js';
import { bandOf, encodeRating, SCALE_BINARY, SCALE_GRADED } from '../shared/scales.js';

const N = 5000;

function populated() {
  const s = emptySnapshot('abc123def456', N, { scale: 'graded', randomSeed: 0xdeadbeef });
  s.updatedAt = 1_760_000_000_000;
  s.settingsAt = { scale: 12345, tierMax: 999 };
  s.cursor = { alphabetical: 1234, random: 4321 };
  for (let i = 0; i < N; i += 7) {
    s.rating[i] = encodeRating(i % 2 ? SCALE_GRADED : SCALE_BINARY, (i % 4) + 1);
    s.answeredAt[i] = 1_000_000 + i;
    s.durMs[i] = (i * 37) % 65536;
    s.flags[i] = i % 3;
  }
  return s;
}

test('round-trips a populated snapshot byte-identically', () => {
  const state = populated();
  const bytes = encodeSnapshot(state);
  const back = decodeSnapshot(bytes);

  assert.equal(back.corpusVersion, 'abc123def456');
  assert.equal(back.wordCount, N);
  assert.equal(back.updatedAt, state.updatedAt);
  assert.equal(back.settings.scale, 'graded');
  assert.equal(back.settings.randomSeed, 0xdeadbeef);
  assert.deepEqual(back.settingsAt, { scale: 12345, tierMax: 999 });
  assert.deepEqual(back.cursor, { alphabetical: 1234, random: 4321 });
  assert.deepEqual(back.rating, state.rating);
  assert.deepEqual(back.answeredAt, state.answeredAt);
  assert.deepEqual(back.durMs, state.durMs);
  assert.deepEqual(back.flags, state.flags);

  assert.deepEqual(encodeSnapshot(back), bytes);
});

test('header carries the app id and is readable without a full decode', () => {
  const bytes = encodeSnapshot(populated());
  const header = peekHeader(bytes);
  assert.equal(header.app, APP_ID);
  assert.equal(header.corpusVersion, 'abc123def456');
  assert.equal(header.wordCount, N);
});

test('rejects a truncated body', () => {
  const bytes = encodeSnapshot(populated());
  assert.throws(() => decodeSnapshot(bytes.subarray(0, bytes.length - 1)), /truncated/);
  assert.throws(() => decodeSnapshot(bytes.subarray(0, 6)), /truncated/);
});

test('rejects wrong magic and a foreign app id', () => {
  const bytes = encodeSnapshot(populated());
  const wrongMagic = bytes.slice();
  wrongMagic[0] = 0x58;
  assert.throws(() => decodeSnapshot(wrongMagic), /bad magic/);

  const foreign = emptySnapshot('abc123def456', 8);
  const fb = encodeSnapshot(foreign);
  const headerLen = new DataView(fb.buffer, fb.byteOffset).getUint32(4, true);
  const json = JSON.parse(new TextDecoder().decode(fb.subarray(8, 8 + headerLen)));
  json.app = 'someoneelse';
  const patched = new TextEncoder().encode(JSON.stringify(json));
  const rebuilt = new Uint8Array(8 + patched.length + (fb.length - 8 - headerLen));
  rebuilt.set(fb.subarray(0, 8));
  new DataView(rebuilt.buffer).setUint32(4, patched.length, true);
  rebuilt.set(patched, 8);
  rebuilt.set(fb.subarray(8 + headerLen), 8 + patched.length);
  assert.throws(() => decodeSnapshot(rebuilt), /not a dictionary snapshot/);
});

test('rejects a wordCount that disagrees with the section lengths', () => {
  const state = emptySnapshot('v1', 16);
  const bytes = encodeSnapshot(state);
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  json.wordCount = 17;
  const patched = new TextEncoder().encode(JSON.stringify(json));
  const rebuilt = new Uint8Array(8 + patched.length + (bytes.length - 8 - headerLen));
  rebuilt.set(bytes.subarray(0, 8));
  new DataView(rebuilt.buffer).setUint32(4, patched.length, true);
  rebuilt.set(patched, 8);
  rebuilt.set(bytes.subarray(8 + headerLen), 8 + patched.length);
  assert.throws(() => decodeSnapshot(rebuilt), /rating length/);
});

test('normaliseSettings drops unknown values rather than trusting them', () => {
  const s = normaliseSettings({
    scale: 'telepathy', order: 'sideways', tierMax: 42, dailyMinutes: 10_000,
    skipAnswered: 'yes', showDefinition: 'onDemand', randomSeed: -1, rogue: 1,
  });
  assert.equal(s.scale, 'binary');
  assert.equal(s.order, 'alphabetical');
  assert.equal(s.tierMax, 70);
  assert.equal(s.dailyMinutes, 600);
  assert.equal(s.skipAnswered, true);
  assert.equal(s.showDefinition, 'afterReveal');
  assert.equal(s.randomSeed, 0);
  assert.equal((s as Record<string, unknown>).rogue, undefined);
});

test('band mapping keeps "heard of" and "seen" out of the knowledge bands', () => {
  assert.equal(bandOf(0x00), 'unanswered');
  assert.equal(bandOf(0x11), 'seen');
  assert.equal(bandOf(0x21), 'unknown');
  assert.equal(bandOf(0x22), 'known');
  assert.equal(bandOf(0x31), 'unknown');
  assert.equal(bandOf(0x32), 'partial');
  assert.equal(bandOf(0x33), 'known');
  assert.equal(bandOf(0x34), 'known');
  assert.equal(bandOf(0x7f), 'unanswered');
});
