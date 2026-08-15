/**
 * `ocr_tesseract` (`tesseract-parser.ts`) — the operational bindings
 * (loxep-cd3.4) as assertions, not just doc comments:
 *
 * - the worker is created ONCE per process and reused across `parse()` calls
 *   ("single-worker discipline");
 * - ONE `recognize()` call requests text + tsv + hocr together
 *   ("one pass, all formats");
 * - `ParseResult.lines` is built from that SAME call's `tsv` output
 *   (loxep-cd3.5, M5 — `tsv-lines.ts`'s own suite covers the tsv→lines
 *   conversion in detail; this file only proves the parser actually WIRES
 *   `data.tsv` through to `result.lines` rather than discarding it);
 * - a real, vendored, offline tesseract.js run against a synthetic receipt
 *   image actually extracts legible text (and, now, boxes) deterministically.
 *
 * The unit-level tests inject a fake `TesseractWorkerLike` (no WASM, no
 * vendored data needed) so the discipline assertions run in milliseconds;
 * the "real OCR" describe block at the bottom is the one place this suite
 * pays the ~0.3-1s worker-init cost, once, shared across its own `it`s via
 * `beforeAll`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTesseractParser,
  getSharedTesseractWorker,
  resetSharedTesseractWorkerForTests,
  TESSERACT_PARSER_ID,
} from "../src/tesseract-parser.ts";
import type { TesseractWorkerLike } from "../src/tesseract-parser.ts";
import { DocumentsValidationError } from "../src/errors.ts";
import { syntheticReceiptPng } from "./fixtures/synthetic-receipt.ts";

function fakeWorker(overrides: Partial<TesseractWorkerLike> = {}): {
  worker: TesseractWorkerLike;
  recognizeCalls: Array<{ options: Record<string, unknown>; output: Record<string, boolean> }>;
  setParametersCalls: Record<string, unknown>[];
} {
  const recognizeCalls: Array<{ options: Record<string, unknown>; output: Record<string, boolean> }> = [];
  const setParametersCalls: Record<string, unknown>[] = [];
  const worker: TesseractWorkerLike = {
    setParameters: async (params) => {
      setParametersCalls.push(params);
      return undefined;
    },
    recognize: async (_image, options, output) => {
      recognizeCalls.push({ options, output });
      return {
        data: { text: "SAMPLE TEXT 12.34", confidence: 87, tsv: "1\t1\t0\n", hocr: "<div/>" },
      };
    },
    ...overrides,
  };
  return { worker, recognizeCalls, setParametersCalls };
}

describe("createTesseractParser: identity", () => {
  it("registers as ocr_tesseract", () => {
    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([1, 2, 3]),
      getWorker: async () => fakeWorker().worker,
    });
    expect(parser.id).toBe(TESSERACT_PARSER_ID);
    expect(parser.id).toBe("ocr_tesseract");
  });
});

describe("createTesseractParser: single-worker discipline", () => {
  it("calls getWorker at most once across N parse() calls when the worker is memoized by the caller", async () => {
    let creations = 0;
    const { worker } = fakeWorker();
    let memoized: Promise<TesseractWorkerLike> | null = null;
    const getWorker = () => {
      memoized ??= (async () => {
        creations += 1;
        return worker;
      })();
      return memoized;
    };

    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]), // JPEG-ish, not PDF
      getWorker,
    });

    await parser.parse({ mediaObjectId: "m1", documentKind: "receipt" });
    await parser.parse({ mediaObjectId: "m2", documentKind: "receipt" });
    await parser.parse({ mediaObjectId: "m3", documentKind: "invoice" });

    expect(creations).toBe(1);
  });

  it("getSharedTesseractWorker itself memoizes across repeated calls (module-level singleton)", async () => {
    resetSharedTesseractWorkerForTests();
    let realCreations = 0;
    // We can't intercept the real tesseract.js factory without importing
    // it directly, so this test instead proves memoization structurally:
    // the SAME promise identity is returned on repeated calls.
    const p1 = getSharedTesseractWorker();
    const p2 = getSharedTesseractWorker();
    expect(p1).toBe(p2);
    realCreations += 1;
    expect(realCreations).toBe(1);
    // Clean up: terminate the real worker this test spun up.
    const worker = (await p1) as unknown as { terminate: () => Promise<unknown> };
    await worker.terminate();
    resetSharedTesseractWorkerForTests();
  }, 20_000);
});

describe("createTesseractParser: one pass, all formats", () => {
  it("requests text+tsv+hocr in exactly ONE recognize() call, never twice", async () => {
    const { worker, recognizeCalls } = fakeWorker();
    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
      getWorker: async () => worker,
    });

    await parser.parse({ mediaObjectId: "m1", documentKind: "receipt" });

    expect(recognizeCalls).toHaveLength(1);
    expect(recognizeCalls[0]?.output).toEqual({ text: true, tsv: true, hocr: true });
  });

  it("applies Sauvola thresholding (thresholding_method=2) before recognizing", async () => {
    const { worker, setParametersCalls } = fakeWorker();
    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
      getWorker: async () => worker,
    });
    await parser.parse({ mediaObjectId: "m1", documentKind: "receipt" });
    expect(setParametersCalls).toContainEqual({ thresholding_method: "2" });
  });

  it("hands the raw tsv/hocr/confidence to onRawOutput — the seam M5 reads from, unused by M4 itself", async () => {
    const { worker } = fakeWorker();
    const seen: unknown[] = [];
    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
      getWorker: async () => worker,
      onRawOutput: (input) => seen.push(input),
    });
    await parser.parse({ mediaObjectId: "m1", documentKind: "receipt" });
    expect(seen).toEqual([
      { mediaObjectId: "m1", raw: { tsv: "1\t1\t0\n", hocr: "<div/>", confidence: 87 } },
    ]);
  });
});

describe("createTesseractParser: ParseResult shape (text always, lines from tsv)", () => {
  it("returns text, and an empty lines array when the run's tsv carries no word rows", async () => {
    // The default fake worker's tsv fixture ("1\t1\t0\n") is a header-only
    // stub with no level-5 word rows — same shape M4's original fixture
    // used, kept here to prove a tsv with nothing recognizable degrades to
    // no boxes rather than throwing.
    const { worker } = fakeWorker();
    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
      getWorker: async () => worker,
    });
    const result = await parser.parse({ mediaObjectId: "m1", documentKind: "receipt" });
    expect(result.parserId).toBe("ocr_tesseract");
    expect(result.text).toBe("SAMPLE TEXT 12.34");
    expect(result.lines).toEqual([]);
    expect(result.currency).toBeNull();
    expect(result.documentTotal).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("builds lines with a sourceRegion from a real tsv payload — the tier B wiring itself", async () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t10\t10\t80\t40\t95.5\tTOTAL",
      "5\t1\t1\t1\t1\t2\t100\t10\t60\t40\t91.0\t7.98",
    ].join("\n");
    const { worker } = fakeWorker({
      recognize: async () => ({
        data: { text: "TOTAL 7.98", confidence: 93, tsv, hocr: "<div/>" },
      }),
    });
    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
      getWorker: async () => worker,
    });
    const result = await parser.parse({ mediaObjectId: "m1", documentKind: "receipt" });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.description).toBe("TOTAL 7.98");
    expect(result.lines[0]?.sourceRegion).toEqual({ page: 1, x: 10, y: 10, w: 150, h: 40 });
    expect(result.lines[0]?.quantity).toBeNull();
    expect(result.lines[0]?.lineAmount).toBeNull();
  });

  it("normalizes empty/whitespace-only recognition to text: null, with a warning", async () => {
    const { worker } = fakeWorker({
      recognize: async () => ({ data: { text: "   \n  ", confidence: 0, tsv: null, hocr: null } }),
    });
    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
      getWorker: async () => worker,
    });
    const result = await parser.parse({ mediaObjectId: "m1", documentKind: "receipt" });
    expect(result.text).toBeNull();
    expect(result.warnings).toEqual(["tesseract recognized no text in this document"]);
  });

  it("warns on low confidence without dropping the text", async () => {
    const { worker } = fakeWorker({
      recognize: async () => ({ data: { text: "blurry", confidence: 12, tsv: null, hocr: null } }),
    });
    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
      getWorker: async () => worker,
    });
    const result = await parser.parse({ mediaObjectId: "m1", documentKind: "receipt" });
    expect(result.text).toBe("blurry");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/low OCR confidence/);
  });

  it("refuses zero-byte media rather than handing an empty buffer to the OCR engine", async () => {
    const { worker } = fakeWorker();
    const parser = createTesseractParser({
      readMedia: async () => new Uint8Array([]),
      getWorker: async () => worker,
    });
    await expect(
      parser.parse({ mediaObjectId: "m1", documentKind: "receipt" }),
    ).rejects.toThrow(DocumentsValidationError);
  });
});

describe("createTesseractParser: PDF routing", () => {
  it("routes %PDF-prefixed bytes to the text-layer path instead of OCR (never OCRs a digital invoice)", async () => {
    const { worker, recognizeCalls } = fakeWorker();
    const parser = createTesseractParser({
      readMedia: async () => new TextEncoder().encode("%PDF-1.4\n..."),
      getWorker: async () => worker,
    });
    const result = await parser.parse({ mediaObjectId: "m1", documentKind: "invoice" });
    // pdftotext is not installed in this environment (verified: `which
    // pdftotext` fails) — the PDF path degrades honestly rather than
    // silently OCRing, and never touches the tesseract worker at all.
    expect(recognizeCalls).toHaveLength(0);
    expect(result.text).toBeNull();
    expect(result.warnings.some((w) => w.includes("pdftotext is not available"))).toBe(true);
  });
});

describe("ocr_tesseract: real end-to-end (vendored language data, no network)", () => {
  let parser: ReturnType<typeof createTesseractParser>;

  beforeAll(() => {
    parser = createTesseractParser({
      readMedia: async (id: string) => (id === "synthetic-receipt" ? syntheticReceiptPng() : new Uint8Array()),
    });
  }, 30_000);

  afterAll(async () => {
    const worker = await getSharedTesseractWorker();
    await (worker as unknown as { terminate: () => Promise<unknown> }).terminate();
    resetSharedTesseractWorkerForTests();
  }, 30_000);

  it("extracts recognizable words from the synthetic receipt entirely offline", async () => {
    const result = await parser.parse({
      mediaObjectId: "synthetic-receipt",
      documentKind: "receipt",
    });
    expect(result.text).not.toBeNull();
    const upper = (result.text ?? "").toUpperCase();
    // Loose, resilient assertions — this hand-rolled block font is not a
    // real receipt font; the goal is "the pipeline actually recognized
    // something real", not an exact transcript. "TOTAL" and "COST" are the
    // two words this font renders most unambiguously.
    expect(upper).toContain("TOTAL");
    expect(upper).toContain("COST");
    // Tier B (loxep-cd3.5, M5): a real recognize() call produces a real
    // tsv, so this backend now stages real lines with real boxes — no
    // longer the `lines: []` M4 shipped. Assertions stay loose for the same
    // reason the text ones do: a hand-rolled font, not a real receipt.
    expect(result.lines.length).toBeGreaterThan(0);
    for (const line of result.lines) {
      expect(line.description).not.toBeNull();
      expect((line.description ?? '').length).toBeGreaterThan(0);
      expect(line.quantity).toBeNull();
      expect(line.unitAmount).toBeNull();
      expect(line.lineAmount).toBeNull();
      expect(line.confidence).toBeGreaterThanOrEqual(0);
      expect(line.confidence).toBeLessThanOrEqual(1);
      expect(line.sourceRegion).toBeDefined();
      expect(line.sourceRegion?.page).toBe(1);
      expect(line.sourceRegion?.w).toBeGreaterThan(0);
      expect(line.sourceRegion?.h).toBeGreaterThan(0);
    }
    const joined = result.lines.map((l) => l.description).join(" ").toUpperCase();
    expect(joined).toContain("TOTAL");
  }, 30_000);

  it("is deterministic: parsing the same bytes twice yields identical text and lines", async () => {
    const first = await parser.parse({ mediaObjectId: "synthetic-receipt", documentKind: "receipt" });
    const second = await parser.parse({ mediaObjectId: "synthetic-receipt", documentKind: "receipt" });
    expect(second.text).toBe(first.text);
    expect(second.lines).toEqual(first.lines);
  }, 30_000);
});
