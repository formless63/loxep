/**
 * A tiny, deterministic, pure-Node PNG generator for OCR test fixtures.
 *
 * `@loxep/documents` cannot check in a real photograph of a receipt (none
 * exists in this repo, and the point of `scripts/measure-ocr-accuracy.ts`
 * is that the OWNER runs that against their own paper), and this wave's
 * dependency budget authorizes exactly one addition (`tesseract.js` — see
 * `../../src/tesseract-parser.ts`'s module doc), which rules out an
 * image-generation library too. So this module draws its own: a bold,
 * high-contrast, monospace glyph set built from filled rectangles (loosely
 * modeled on a seven-segment display, extended with a couple of letter
 * shapes) rendered onto a grayscale bitmap and encoded as a standard PNG
 * (IHDR/IDAT/IEND, zlib-deflated via `node:zlib` — no dependency beyond
 * Node's own standard library).
 *
 * This is NOT a claim that tesseract.js reads this font as accurately as a
 * real receipt's real font — it measurably does not (see
 * `tesseract-parser.test.ts`'s real-OCR test, which asserts on a handful of
 * words rather than an exact transcript). Its job is narrower: give the
 * extraction pipeline a real, decodable image with SOME recognizable text
 * so tests can exercise the real tesseract.js worker end to end (worker
 * reuse, one-pass text+tsv+hocr, determinism) without depending on an
 * external asset.
 */
import { deflateSync } from "node:zlib";

/* --------------------------------------------------------------- PNG encoding */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Encode an 8-bit grayscale PNG from a `width * height` byte buffer (0 = black, 255 = white). */
function encodeGrayscalePng(width: number, height: number, pixels: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // One filter-type byte (0 = none) per row, then the row's raw samples.
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    pixels.copy(raw, y * (width + 1) + 1, y * width, y * width + width);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------- block-segment font */

type Rect = readonly [x: number, y: number, w: number, h: number];

// Seven-segment layout on a 10 (wide) x 14 (tall) cell, plus one full-height
// middle bar ('m') for letters a seven-segment digit shape can't express.
const SEGMENTS: Record<string, Rect> = {
  a: [1, 0, 8, 2], // top
  b: [7, 0, 2, 7], // upper-right
  c: [7, 7, 2, 7], // lower-right
  d: [1, 12, 8, 2], // bottom
  e: [1, 7, 2, 7], // lower-left
  f: [1, 0, 2, 7], // upper-left
  g: [1, 6, 8, 2], // middle bar
  m: [4, 0, 2, 14], // full-height middle vertical (T, I, $)
};

const DIGIT_SEGMENTS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgecd",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};

const LETTER_SEGMENTS: Record<string, string> = {
  T: "am",
  O: "abcdef",
  A: "abcefg",
  L: "def",
  S: "afgcd",
  E: "adefg",
  D: "abcdf",
  C: "adef",
};

function glyphRects(ch: string): Rect[] {
  if (ch === " ") return [];
  if (ch === ".") return [[4, 12, 2, 2]];
  if (ch === "-") return [[2, 6, 6, 2]];
  if (ch === ":") return [[4, 3, 2, 2], [4, 9, 2, 2]];
  if (ch === "$") return "abcdefgm".split("").map((s) => SEGMENTS[s]!);
  const segs = DIGIT_SEGMENTS[ch] ?? LETTER_SEGMENTS[ch];
  if (segs === undefined) return [];
  return segs.split("").map((s) => SEGMENTS[s]!);
}

const CELL_W = 10;
const CELL_H = 14;
const MARGIN_CELLS = 1;
const LINE_GAP_CELLS = 1;

export interface RenderTextPngOptions {
  /** Integer upscale factor applied to the whole glyph grid (default 4 — puts glyph height around 56px, comfortably inside/above Tesseract's LSTM x-height band once margins are accounted for). */
  scale?: number;
}

/** Render `lines` of text (uppercased; unsupported characters render as blank space) as a white-background, black-text grayscale PNG. Deterministic: the same input always produces byte-identical output. */
export function renderTextPng(lines: readonly string[], options: RenderTextPngOptions = {}): Buffer {
  const scale = options.scale ?? 4;
  const maxChars = Math.max(1, ...lines.map((line) => line.length));

  const baseW = (maxChars + MARGIN_CELLS * 2) * CELL_W;
  const baseH =
    lines.length * CELL_H + Math.max(0, lines.length - 1) * LINE_GAP_CELLS + MARGIN_CELLS * 2 * CELL_H;

  const base = new Uint8Array(baseW * baseH).fill(255);
  const fillRect = (x0: number, y0: number, w: number, h: number): void => {
    for (let y = y0; y < y0 + h; y += 1) {
      if (y < 0 || y >= baseH) continue;
      for (let x = x0; x < x0 + w; x += 1) {
        if (x < 0 || x >= baseW) continue;
        base[y * baseW + x] = 0;
      }
    }
  };

  let cursorY = MARGIN_CELLS * CELL_H;
  for (const line of lines) {
    let cursorX = MARGIN_CELLS * CELL_W;
    for (const ch of line.toUpperCase()) {
      for (const [rx, ry, rw, rh] of glyphRects(ch)) {
        fillRect(cursorX + rx, cursorY + ry, rw, rh);
      }
      cursorX += CELL_W;
    }
    cursorY += CELL_H + LINE_GAP_CELLS;
  }

  const outW = baseW * scale;
  const outH = baseH * scale;
  const pixels = Buffer.alloc(outW * outH);
  for (let y = 0; y < outH; y += 1) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < outW; x += 1) {
      const sx = Math.floor(x / scale);
      pixels[y * outW + x] = base[sy * baseW + sx] ?? 255;
    }
  }
  return encodeGrayscalePng(outW, outH, pixels);
}

/** A small synthetic "receipt" using only glyphs this font supports (T, O, A, L, S, E, D, C, digits, space, `.`, `-`, `:`, `$`). */
export function syntheticReceiptPng(): Buffer {
  return renderTextPng(["TOTAL $12.99", "DATE 2026-08-15", "SALES COST .84"]);
}
