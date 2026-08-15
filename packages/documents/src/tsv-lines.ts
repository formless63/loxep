/**
 * Turns Tesseract's `tsv` output into per-line {@link ParseResultLine}s with
 * a `sourceRegion` — tier B's whole job (loxep-cd3.5, M5), and, per the
 * design's own "finding that reorders the ask", nearly free: `tesseract-parser.ts`
 * already requests `tsv` in the SAME `recognize()` call tier A uses for
 * `text` ("one pass, all formats"). This module is the reader for that
 * output that M4 deliberately left unread (see that file's `onRawOutput`
 * doc) — nothing else changes about how or when Tesseract runs.
 *
 * ## The TSV shape, as Tesseract (native and tesseract.js — byte-identical
 * per the design's survey) emits it
 *
 * A header row, then one row per element, tab-separated:
 *
 * ```text
 * level  page_num  block_num  par_num  line_num  word_num  left  top  width  height  conf  text
 * ```
 *
 * `level` is 1 (page) through 5 (word); only level-5 rows carry real text
 * and a real confidence (0-100). Levels 1-4 are aggregate rows Tesseract
 * emits for its own hierarchy (page/block/paragraph/line) with `conf = -1`
 * and empty `text` — this module reads level-5 rows only and reconstructs
 * the line grouping itself from `(page_num, block_num, par_num, line_num)`,
 * rather than trusting a level-4 "line" row's own bounding box, because a
 * level-4 row's box is Tesseract's OWN line-bbox and matches the union of
 * its words' boxes only approximately (padding/leading). Deriving the box
 * from the words tier B actually draws boxes around keeps the two in sync
 * by construction.
 *
 * ## Units: no conversion, by design
 *
 * `left`/`top`/`width`/`height` are pixel coordinates in the SOURCE image
 * Tesseract was handed — the same image `<DocumentPreview>`'s overlay mode
 * renders (`apps/web/src/components/document-preview.tsx`). They map
 * directly onto {@link SourceRegion}'s `x`/`y`/`w`/`h` with no scaling here;
 * the browser-side overlay is the one place a ratio is computed (natural
 * image pixels versus the responsive rendered size).
 *
 * ## What this module deliberately does NOT do
 *
 * No amount, quantity, or date is parsed out of a line's text here —
 * that would be tier C ("structured autofill"), which the design refuses
 * outright ("NEVER auto-commits... the moment one is added, the honest
 * answer to 'why is this box wrong' becomes 'the model guessed'"). A line's
 * `description` is the OCR'd text, verbatim (trimmed); `quantity`/
 * `unitAmount`/`lineAmount` are always `null`. The operator's DRAG is what
 * turns text into a value — see `expense-entry-design.md`'s "the weave" and
 * this milestone's client-side amount-extraction-on-drop, which lives in
 * `apps/web` and touches no stored row until the human confirms it.
 */
import type { ParseResultLine } from "./parser.ts";
import type { SourceRegion } from "./source-region.ts";

const TSV_WORD_LEVEL = 5;

interface TsvWord {
  page: number;
  block: number;
  par: number;
  line: number;
  word: number;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  text: string;
}

/** Parses raw Tesseract `tsv` text into its level-5 (word) rows. Malformed/short rows are skipped rather than thrown on — OCR output is not a trusted wire format. */
function parseTsvWords(tsv: string): TsvWord[] {
  const lines = tsv.split(/\r?\n/);
  const words: TsvWord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    // Row 0 is the header (`level\tpage_num\t...`); every following row is
    // tab-separated with `text` last and free to itself contain no tabs
    // (Tesseract's own TSV writer never quotes/escapes `text`).
    const row = lines[i];
    if (row === undefined || row.length === 0) continue;
    const fields = row.split("\t");
    if (fields.length < 12) continue;
    const level = Number(fields[0]);
    if (level !== TSV_WORD_LEVEL) continue;
    const [
      ,
      pageNum,
      blockNum,
      parNum,
      lineNum,
      wordNum,
      left,
      top,
      width,
      height,
      conf,
      ...textParts
    ] = fields;
    const text = textParts.join("\t").trim();
    if (text.length === 0) continue;
    const word: TsvWord = {
      page: Number(pageNum),
      block: Number(blockNum),
      par: Number(parNum),
      line: Number(lineNum),
      word: Number(wordNum),
      left: Number(left),
      top: Number(top),
      width: Number(width),
      height: Number(height),
      conf: Number(conf),
      text,
    };
    if (
      !Number.isFinite(word.page) ||
      !Number.isFinite(word.left) ||
      !Number.isFinite(word.top) ||
      !Number.isFinite(word.width) ||
      !Number.isFinite(word.height)
    ) {
      continue;
    }
    words.push(word);
  }
  return words;
}

/** Groups word rows by `(page, block, par, line)`, in first-seen order, preserving Tesseract's own reading order. */
function groupWordsByLine(words: TsvWord[]): TsvWord[][] {
  const order: string[] = [];
  const groups = new Map<string, TsvWord[]>();
  for (const word of words) {
    const key = `${word.page}:${word.block}:${word.par}:${word.line}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(word);
  }
  return order.map((key) => groups.get(key) ?? []);
}

/** A group's text (words in `word_num` order) and its bounding box (the union of every word's box) — the line-level `sourceRegion`. */
function lineFromWords(words: TsvWord[]): ParseResultLine | null {
  if (words.length === 0) return null;
  const sorted = [...words].sort((a, b) => a.word - b.word);
  const description = sorted.map((w) => w.text).join(" ").trim();
  if (description.length === 0) return null;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let confSum = 0;
  let confCount = 0;
  for (const w of sorted) {
    left = Math.min(left, w.left);
    top = Math.min(top, w.top);
    right = Math.max(right, w.left + w.width);
    bottom = Math.max(bottom, w.top + w.height);
    // Tesseract reports `-1` for a word it has no confidence figure for
    // (rare at word level, but defensive); only real 0-100 scores count
    // toward the line's average.
    if (w.conf >= 0) {
      confSum += w.conf;
      confCount += 1;
    }
  }

  const region: SourceRegion = {
    page: sorted[0]?.page ?? 1,
    x: left,
    y: top,
    w: Math.max(0, right - left),
    h: Math.max(0, bottom - top),
  };
  const confidence = confCount > 0 ? Math.min(1, Math.max(0, confSum / confCount / 100)) : 0;

  return {
    description,
    quantity: null,
    unitAmount: null,
    lineAmount: null,
    confidence,
    sourceRegion: region,
  };
}

/**
 * The entry point: Tesseract's raw `tsv` text (from the SAME `recognize()`
 * call that produced `text`) to per-line candidates with boxes. Returns `[]`
 * for `null`/empty/unparseable input — a backend or a page that produced no
 * usable tsv degrades to "no boxes", never an error, matching every other
 * "detect, do not constrain" surface in this domain.
 */
export function tesseractLinesFromTsv(tsv: string | null | undefined): ParseResultLine[] {
  if (tsv === null || tsv === undefined || tsv.trim().length === 0) return [];
  const words = parseTsvWords(tsv);
  const groups = groupWordsByLine(words);
  const lines: ParseResultLine[] = [];
  for (const group of groups) {
    const line = lineFromWords(group);
    if (line !== null) lines.push(line);
  }
  return lines;
}
