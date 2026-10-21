// Draws the icons the installed viewer needs and writes them into
// packages/cli/assets. They are committed, so this runs only when the mark
// changes:
//
//	node scripts/genicon.mjs
//
// It is here rather than a checked-in binary blob nobody can edit, and it uses
// nothing but what Node ships with, like everything else in this repository.
//
// The mark is a tick on a full-bleed square. Full-bleed because both places
// that show it apply their own mask: iOS rounds an apple-touch-icon itself,
// and a maskable manifest icon may be cropped to a circle. Everything that
// matters therefore stays inside the middle 60%, which is the safe zone both
// masks leave alone.
//
// The one thing this port had to grow that the Go original did not: Go's
// standard library encodes PNG, and Node's does not. So the encoder is at the
// bottom of this file, written against the parts of the format this program
// needs — one IHDR, one IDAT, one IEND — over node:zlib, which Node does ship.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// The two colours are --accent and --panel from app.css, in the light theme.
// They are duplicated rather than parsed out of the stylesheet because this
// runs rarely and a regex over CSS is a worse dependency than a comment: if
// --accent moves again, move it here too and run `make icons`. It drifted
// once already — the mark was brown for a while after the stylesheet went
// purple.
const back = [0x7a, 0x4f, 0xd4, 0xff];
const ink = [0xff, 0xff, 0xff, 0xff];

// The tick, in unit coordinates: two segments and a half-width.
const stroke = [
  [0.30, 0.53],
  [0.44, 0.68],
  [0.72, 0.32],
];
const half = 0.055;

// sample is the supersampling factor. A tick is all diagonal, so it needs
// antialiasing; sampling is the shortest way to get it without a rasterizer.
const sample = 4;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const out = path.join(root, 'packages', 'cli', 'assets');
  for (const [name, size] of Object.entries({
    'icon-192.png': 192,
    'icon-512.png': 512,
    'apple-touch-icon.png': 180,
  })) {
    write(path.join(out, name), size);
    console.error(`${name}: ${size}x${size}`);
  }
}

function write(file, size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      blend(pixels, (y * size + x) * 4, back, ink, coverage(x, y, size));
    }
  }
  fs.writeFileSync(file, encodePNG(pixels, size, size));
}

/** coverage is how much of one pixel the tick covers, in [0,1]. */
function coverage(x, y, size) {
  let hits = 0;
  for (let sy = 0; sy < sample; sy++) {
    for (let sx = 0; sx < sample; sx++) {
      const u = (x + (sx + 0.5) / sample) / size;
      const v = (y + (sy + 0.5) / sample) / size;
      if (onStroke(u, v)) hits++;
    }
  }
  return hits / (sample * sample);
}

function onStroke(u, v) {
  for (let i = 0; i + 1 < stroke.length; i++) {
    if (distance(u, v, stroke[i], stroke[i + 1]) <= half) return true;
  }
  return false;
}

// distance is from a point to a segment, with the ends rounded, which is what
// makes the corner of the tick join cleanly.
function distance(u, v, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  let t = 0;
  if (length > 0) {
    t = ((u - a[0]) * dx + (v - a[1]) * dy) / length;
    t = Math.max(0, Math.min(1, t));
  }
  const px = a[0] + t * dx;
  const py = a[1] + t * dy;
  return Math.hypot(u - px, v - py);
}

// blend writes one opaque pixel at off. Math.round rather than a truncating
// cast, to match Go's math.Round in the original: the two differ by a whole
// level on half the antialiased edge pixels.
function blend(pixels, off, bg, fg, alpha) {
  for (let i = 0; i < 3; i++) {
    pixels[off + i] = Math.round(bg[i] * (1 - alpha) + fg[i] * alpha);
  }
  pixels[off + 3] = 0xff;
}

// --- PNG ---------------------------------------------------------------
//
// Enough of the format to write one image: the 8-byte signature, IHDR, a
// single IDAT holding the zlib stream of the raw scanlines, and IEND. Each
// scanline carries a leading filter-type byte; filter 0 (None) is used, since
// deflate is doing the work and a filter would only trade bytes for code here.
// Colour type 6 is 8-bit RGBA. Go's encoder noticed these images are fully
// opaque and wrote colour type 2 (RGB) instead, so the committed files are
// smaller than what this writes while decoding to the same pixels.

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The CRC32 table, built once. PNG uses the standard reversed polynomial. */
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** chunk is length + type + data + CRC over type and data. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePNG(pixels, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate, the only one defined
  ihdr[11] = 0; // filter method: the only one defined
  ihdr[12] = 0; // non-interlaced

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

main();
