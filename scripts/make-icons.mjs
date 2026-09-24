#!/usr/bin/env node
/**
 * Generate the PWA icons from one flat glyph, with no image library.
 *
 * The icon is a solid field and a single letterform, which is a handful of
 * filled rectangles once rasterised - so the PNGs are written by hand rather
 * than by pulling in a canvas or an SVG renderer for three files that change
 * approximately never.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'client', 'public', 'icons');

const BG = [0x0b, 0x0b, 0x0c];
const FG = [0xf2, 0xf2, 0xf2];

/**
 * A "D" as a solid outer silhouette minus its counter.
 *
 * Drawn this way rather than as a stem plus two bars plus a ring, because
 * those three pieces do not meet cleanly where the bowl leaves the bars and
 * the seam shows as a notch in the rasterised icon.
 */
function isGlyph(x, y, inset) {
  const u = (x - inset) / (1 - 2 * inset);
  const v = (y - inset) / (1 - 2 * inset);
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;

  const stroke = 0.17;
  const cx = 0.62;   // where the stem ends and the bowl begins
  const cy = 0.5;
  const rx = 0.38;
  const ry = 0.5;

  const outer = u <= cx || ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1;
  if (!outer) return false;

  const counter = u >= stroke && (u <= cx
    ? v >= stroke && v <= 1 - stroke
    : ((u - cx) / (rx - stroke)) ** 2 + ((v - cy) / (ry - stroke)) ** 2 <= 1);
  return !counter;
}

function render(size, maskable) {
  // Maskable icons are cropped to a safe circle, so the glyph is drawn smaller.
  const inset = maskable ? 0.29 : 0.19;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let at = 0;
  for (let py = 0; py < size; py++) {
    raw[at++] = 0; // PNG filter: none
    for (let px = 0; px < size; px++) {
      const on = isGlyph((px + 0.5) / size, (py + 0.5) / size, inset);
      const colour = on ? FG : BG;
      raw[at++] = colour[0];
      raw[at++] = colour[1];
      raw[at++] = colour[2];
    }
  }
  return png(size, raw);
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput) >>> 0, 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  const buf = render(size, maskable);
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`${name}  ${size}x${size}  ${buf.length} bytes`);
}
