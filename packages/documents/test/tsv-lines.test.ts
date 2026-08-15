/**
 * `tsv-lines.ts`'s `tesseractLinesFromTsv` — turning Tesseract's `tsv`
 * output into per-line `ParseResultLine`s with a `sourceRegion` (loxep-cd3.5,
 * M5). Fixture TSVs below are hand-built to Tesseract's own documented
 * column order (`level page_num block_num par_num line_num word_num left
 * top width height conf text`), including the level 1-4 aggregate rows a
 * real run emits alongside the level-5 word rows this module actually
 * reads — the fixtures prove those rows are ignored, not merely absent.
 */
import { describe, expect, it } from "vitest";
import { tesseractLinesFromTsv } from "../src/tsv-lines.ts";

const HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

/** Mirrors a real Tesseract tsv for a two-line receipt fragment: "TAPE 2 @ 3.99 7.98" then "TOTAL 7.98". */
const RECEIPT_TSV = [
  HEADER,
  "1\t1\t0\t0\t0\t0\t0\t0\t600\t1400\t-1\t",
  "2\t1\t1\t0\t0\t0\t10\t10\t500\t100\t-1\t",
  "3\t1\t1\t1\t0\t0\t10\t10\t500\t100\t-1\t",
  "4\t1\t1\t1\t1\t0\t10\t10\t500\t40\t-1\t",
  "5\t1\t1\t1\t1\t1\t10\t10\t80\t40\t95.5\tTAPE",
  "5\t1\t1\t1\t1\t2\t100\t10\t20\t40\t92.1\t2",
  "5\t1\t1\t1\t1\t3\t130\t10\t10\t40\t80.0\t@",
  "5\t1\t1\t1\t1\t4\t150\t10\t60\t40\t90.0\t3.99",
  "5\t1\t1\t1\t1\t5\t220\t10\t80\t40\t91.2\t7.98",
  "4\t1\t1\t1\t2\t0\t10\t60\t400\t40\t-1\t",
  "5\t1\t1\t1\t2\t1\t10\t60\t120\t40\t88.0\tTOTAL",
  "5\t1\t1\t1\t2\t2\t140\t60\t70\t40\t85.0\t7.98",
].join("\n");

describe("tesseractLinesFromTsv", () => {
  it("returns [] for null/undefined/empty/whitespace-only input", () => {
    expect(tesseractLinesFromTsv(null)).toEqual([]);
    expect(tesseractLinesFromTsv(undefined)).toEqual([]);
    expect(tesseractLinesFromTsv("")).toEqual([]);
    expect(tesseractLinesFromTsv("   \n  ")).toEqual([]);
  });

  it("groups word rows into lines by (page, block, par, line), in reading order", () => {
    const lines = tesseractLinesFromTsv(RECEIPT_TSV);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.description).toBe("TAPE 2 @ 3.99 7.98");
    expect(lines[1]?.description).toBe("TOTAL 7.98");
  });

  it("computes a line's sourceRegion as the union of its words' boxes, in source-pixel space", () => {
    const [line] = tesseractLinesFromTsv(RECEIPT_TSV);
    // left = min(word.left) = 10; top = min(word.top) = 10;
    // right = max(left+width) = 220+80 = 300; bottom = max(top+height) = 10+40 = 50.
    expect(line?.sourceRegion).toEqual({ page: 1, x: 10, y: 10, w: 290, h: 40 });
  });

  it("averages word confidence (0-100) into a 0..1 line confidence", () => {
    const [line] = tesseractLinesFromTsv(RECEIPT_TSV);
    const expected = (95.5 + 92.1 + 80.0 + 90.0 + 91.2) / 5 / 100;
    expect(line?.confidence).toBeCloseTo(expected, 6);
  });

  it("never guesses quantity/unitAmount/lineAmount from the text — tier B stops at boxes and raw text", () => {
    for (const line of tesseractLinesFromTsv(RECEIPT_TSV)) {
      expect(line.quantity).toBeNull();
      expect(line.unitAmount).toBeNull();
      expect(line.lineAmount).toBeNull();
    }
  });

  it("ignores level 1-4 aggregate rows even though they are present in every real run", () => {
    // Every level-1..4 row in the fixture has empty text and conf=-1; if
    // they leaked into grouping, lines would fail to match reading order or
    // confidence would go negative.
    const lines = tesseractLinesFromTsv(RECEIPT_TSV);
    for (const line of lines) {
      expect(line.confidence).toBeGreaterThanOrEqual(0);
      expect(line.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("skips a line whose words are all blank text", () => {
    const tsv = [HEADER, "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t50\t"].join("\n");
    expect(tesseractLinesFromTsv(tsv)).toEqual([]);
  });

  it("skips malformed/short rows rather than throwing", () => {
    const tsv = [HEADER, "5\t1\t1\t1\t1\t1\tnot-a-number\t0\t10\t10\t50\tX", "garbage"].join("\n");
    expect(() => tesseractLinesFromTsv(tsv)).not.toThrow();
    expect(tesseractLinesFromTsv(tsv)).toEqual([]);
  });

  it("falls back to 0 confidence when every word in a line has conf=-1", () => {
    const tsv = [HEADER, "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t-1\tX"].join("\n");
    const [line] = tesseractLinesFromTsv(tsv);
    expect(line?.description).toBe("X");
    expect(line?.confidence).toBe(0);
  });

  it("preserves multi-page grouping (page_num carried into sourceRegion.page)", () => {
    const tsv = [
      HEADER,
      "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t90\tPAGE1",
      "5\t2\t1\t1\t1\t1\t0\t0\t10\t10\t90\tPAGE2",
    ].join("\n");
    const lines = tesseractLinesFromTsv(tsv);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.sourceRegion?.page).toBe(1);
    expect(lines[1]?.sourceRegion?.page).toBe(2);
  });
});
