/**
 * `ocr_tesseract` — tier A's `ReceiptParser`: tesseract.js v7 (WASM), vendored
 * language data, no container, no native binary.
 *
 * Design: `apps/docs/src/content/docs/architecture/expense-entry-design.md`
 * section 3 ("OCR: the survey"), and loxep-cd3.4's own operational bindings
 * (re-verified 2026-08-15). The measured verdict that shapes every choice
 * here: native `tesseract 5.5.0 --psm 6 tsv` runs ~0.46 CPU-s against a
 * 600x1400 receipt; tesseract.js 7.0.0 runs ~0.42 CPU-s — on par, marginally
 * faster, because it ships SIMD/relaxed-SIMD LSTM-only WASM cores while a
 * distro binary is generic. `node-tesseract-ocr` is NEVER an option — see
 * `errors.ts`'s sibling modules for nothing, this is a standalone warning:
 * CVE-2026-26832 / GHSA-8j44-735h-w4w2, CVSS 9.8 OS command injection via
 * `child_process.exec`, patched versions: none.
 *
 * ## Tier A's own boundary: text, never structure
 *
 * This backend returns {@link ParseResult.text} — the whole document's
 * recognized text, tier A's entire ask ("no boxes, no structure, no
 * guesses. The cheap win.") — and `lines: []`, always. It does NOT produce
 * `document_line_candidates`; the manual-assisted backend remains the only
 * one that stages a structured line, exactly as it does today. Tier B
 * (M5, loxep-cd3.5) is what turns `tsv`/`hocr` output into per-line
 * `source_region` boxes; this backend already REQUESTS `tsv`/`hocr` in the
 * same recognize() call that requests `text` (see "one pass, all formats"
 * below) so that M5 costs nothing extra to recognize — but M4 does not
 * consume them. `RecognizeRawOutput` on {@link TesseractParseExtras} is the
 * seam M5 reads from; nothing else does.
 *
 * ## `documents.parsed_text` (migration 0026)
 *
 * `documents.parsed_text text null`, `parsed_text_tsv tsvector generated
 * always as to_tsvector('simple', coalesce(parsed_text,'')) stored`, plus a
 * GIN index — landed in migration 0026
 * (`packages/db/migrations/0026_document_parsed_text_search.sql`). This
 * module's {@link ParseResult.text} is persisted through
 * `documents.ts`'s `recordParseResult` — see `extraction-runner.ts`'s module
 * doc.
 *
 * ## Operational bindings (each worth more than a point of accuracy)
 *
 * - **`OMP_THREAD_LIMIT` is IRRELEVANT here, and that is worth recording,
 *   not assuming.** The upstream blowup this environment variable guards
 *   against (tesseract#3109: unconstrained OpenMP under a CPU quota turning
 *   a ~0.46 s run into 21.6-29.6 s) is a NATIVE-binary/pthread phenomenon.
 *   tesseract.js's WASM cores carry no OpenMP surface — there is nothing for
 *   the variable to constrain. The single-worker discipline below is what
 *   actually bounds concurrency here, and it is enforced structurally, not
 *   by an environment variable this backend does not set.
 * - **The worker is created ONCE per process and reused.** ~0.9-1.1 s of
 *   one-time WASM init/compile would triple the cost of a short receipt if
 *   paid per document. {@link getSharedTesseractWorker} memoizes a single
 *   in-flight/resolved worker promise at module scope; every
 *   {@link createTesseractParser} instance that does not override
 *   `getWorker` shares it.
 * - **One `recognize()` call requests `text`, `tsv`, AND `hocr` together.**
 *   Recognition dominates the cost; the format renderers are ~free once
 *   recognition has run. Calling `recognize()` twice to "also get the
 *   boxes" in M5 would be the obvious, wasteful mistake — so M4 already
 *   asks for all three, even though only `text` is consumed today.
 * - **Sauvola thresholding (`thresholding_method=2`, Tesseract 5.0.0+) is
 *   applied before anything else.** The design's own ordering: try this
 *   FIRST, because published retail-bill work found heavy preprocessing
 *   bought only a few CER points at roughly 40x the runtime.
 * - **x-height normalization (~20-30 px) is DELIBERATELY NOT implemented
 *   here.** Tesseract has a documented upper bound on x-height as well as a
 *   lower one; naive upscaling makes results worse, so a real
 *   implementation needs actual pixel resampling (a decode/resize
 *   capability), not a parameter. This wave's dependency budget is
 *   tesseract.js alone — no image-processing library was authorized — and
 *   the design's own ordering says to measure Sauvola-only accuracy before
 *   building a preprocessing pipeline at all. If the measurement harness
 *   (`scripts/measure-ocr-accuracy.ts`) shows Sauvola alone is not enough,
 *   x-height normalization is the next lever, gated on that evidence and an
 *   image-resize dependency the owner authorizes.
 *
 * ## Bytes, not paths: the `readMedia` seam
 *
 * `ReceiptParseInput` carries a `mediaObjectId`, never a path or URL, and a
 * `ReceiptParser` has no database handle (see `parser.ts`'s module doc).
 * Resolving a media object to bytes needs `@loxep/storage`'s `MediaService`,
 * which this package does not (and per this wave's dependency freeze,
 * cannot yet) depend on. {@link CreateTesseractParserOptions.readMedia} is
 * the injected seam: whoever constructs this parser (a future wiring pass
 * in `@loxep/app` or `apps/web`, once that pass is authorized to add
 * `@loxep/documents`/`@loxep/storage` as dependencies) supplies a function
 * that reads a media object's bytes — typically
 * `(id) => mediaService.read(id).then(({ body }) => streamToBuffer(body))`.
 * This keeps `@loxep/documents` dependency-free of `@loxep/storage` for now
 * while the extraction logic itself is fully real and tested.
 */
import { createWorker as defaultCreateWorker, OEM } from "tesseract.js";
import type { ParseableDocumentKind, ParseResult, ReceiptParser } from "./parser.ts";
import { DocumentsValidationError } from "./errors.ts";
import { extractPdfTextLayer } from "./pdf-text-layer.ts";

export const TESSERACT_PARSER_ID = "ocr_tesseract";
export const TESSERACT_PARSER_LABEL = "OCR (tesseract.js, on-device)";

/** Below this average word confidence (0-100, Tesseract's own scale), the result carries a warning rather than a silent claim of good text. */
export const LOW_CONFIDENCE_THRESHOLD = 40;

/**
 * The slice of tesseract.js's `Worker` this module actually calls — kept
 * narrow and structural so a test can inject a fake without importing
 * tesseract.js's own types, and so this module's contract with the real
 * library is explicit and auditable in one place.
 */
export interface TesseractWorkerLike {
  setParameters(params: Record<string, unknown>): Promise<unknown>;
  recognize(
    image: Uint8Array,
    options: Record<string, unknown>,
    output: Record<string, boolean>,
  ): Promise<{
    data: {
      text: string;
      confidence: number;
      tsv: string | null;
      hocr: string | null;
    };
  }>;
}

/**
 * The vendored English language data — checked into this package rather
 * than fetched from tesseract.js's jsDelivr default at run time, per the
 * design's no-egress rule. `4.0.0_best_int` is the SAME variant
 * tesseract.js's own CDN fallback would fetch for an LSTM-only worker (see
 * `worker-script/index.js`'s `langPathDownload` construction) — this is a
 * local copy of that exact asset, not a different one.
 */
const VENDORED_LANG_PATH = new URL("../assets/tessdata", import.meta.url).pathname;

let sharedWorkerPromise: Promise<TesseractWorkerLike> | null = null;

/**
 * Create the ONE tesseract.js worker this process will use, LSTM-only,
 * pointed at the vendored language data with no cache round-trip (`
 * cacheMethod: 'none'` — there is nothing to cache locally that isn't
 * already local). Never call this more than once per process; use
 * {@link getSharedTesseractWorker} instead, which enforces that.
 */
async function createRealTesseractWorker(langPath: string): Promise<TesseractWorkerLike> {
  const worker = await defaultCreateWorker("eng", OEM.LSTM_ONLY, {
    langPath,
    cacheMethod: "none",
    gzip: true,
    logger: () => {},
  });
  return worker as unknown as TesseractWorkerLike;
}

/**
 * Module-scope singleton: the worker is created once, on first use, and
 * reused for the lifetime of the process (see the module doc's "one worker,
 * once"). Lazy rather than eager at import time — a process that imports
 * `@loxep/documents` without ever parsing a receipt (most test files, most
 * of `apps/web`'s request handlers) should not pay ~1 s of WASM init it
 * never needed.
 */
export function getSharedTesseractWorker(
  langPath: string = VENDORED_LANG_PATH,
): Promise<TesseractWorkerLike> {
  sharedWorkerPromise ??= createRealTesseractWorker(langPath);
  return sharedWorkerPromise;
}

/**
 * Test/shutdown hook: drop the memoized worker so the next
 * {@link getSharedTesseractWorker} call creates a fresh one. Real callers
 * terminate the returned worker themselves (tesseract.js's own
 * `worker.terminate()`) before calling this — this function only forgets
 * the reference, it does not close anything.
 */
export function resetSharedTesseractWorkerForTests(): void {
  sharedWorkerPromise = null;
}

/** Raw per-run outputs tier B (M5) reads; nothing in M4 consumes these — see the module doc's "one pass, all formats". */
export interface TesseractRawOutput {
  tsv: string | null;
  hocr: string | null;
  confidence: number;
}

export interface CreateTesseractParserOptions {
  /** Resolves a `mediaObjectId` to its stored bytes — see the module doc's "bytes, not paths" section. */
  readMedia: (mediaObjectId: string) => Promise<Uint8Array>;
  /**
   * Overridable worker accessor, primarily for tests (inject a fake, or a
   * counting wrapper to assert single-creation discipline). Defaults to
   * {@link getSharedTesseractWorker} — the real, process-wide singleton.
   */
  getWorker?: () => Promise<TesseractWorkerLike>;
  /**
   * Called with the raw tsv/hocr/confidence from the SAME recognize() call
   * that produced `text` — the "coordinates captured now" seam for a future
   * tier B pass. Optional; M4 has no reader by default.
   */
  onRawOutput?: (input: { mediaObjectId: string; raw: TesseractRawOutput }) => void;
}

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

function normalizeText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The tier A `ReceiptParser`: OCR for images, existing-text-layer extraction
 * for PDFs (never OCR-of-a-digital-invoice — see `pdf-text-layer.ts`).
 * Registered under {@link TESSERACT_PARSER_ID}; selection is by application
 * setting (`documents.parser_id`), same as every other backend.
 */
export function createTesseractParser(options: CreateTesseractParserOptions): ReceiptParser {
  const { readMedia, getWorker = getSharedTesseractWorker, onRawOutput } = options;

  async function parseImage(mediaObjectId: string, bytes: Uint8Array): Promise<ParseResult> {
    const worker = await getWorker();
    await worker.setParameters({
      // Sauvola thresholding, tried BEFORE any preprocessing pipeline — see
      // the module doc.
      thresholding_method: "2",
    });
    // ONE recognize() call for text + tsv + hocr — see "one pass, all formats".
    const result = await worker.recognize(bytes, {}, { text: true, tsv: true, hocr: true });
    const { data } = result;

    if (onRawOutput) {
      onRawOutput({
        mediaObjectId,
        raw: { tsv: data.tsv, hocr: data.hocr, confidence: data.confidence },
      });
    }

    const text = normalizeText(data.text);
    const warnings: string[] = [];
    if (text === null) {
      warnings.push("tesseract recognized no text in this document");
    } else if (data.confidence < LOW_CONFIDENCE_THRESHOLD) {
      warnings.push(
        `low OCR confidence (${data.confidence.toFixed(1)}/100) — extracted text may be unreliable`,
      );
    }

    return {
      parserId: TESSERACT_PARSER_ID,
      parsedAt: new Date(),
      currency: null,
      documentTotal: null,
      text,
      lines: [],
      warnings,
    };
  }

  async function parsePdf(bytes: Uint8Array): Promise<ParseResult> {
    const extracted = await extractPdfTextLayer(bytes);
    const warnings: string[] = [];
    if (!extracted.available) {
      warnings.push(
        "pdftotext is not available in this deployment — an existing PDF text layer " +
          "could not be checked; the document was left unparsed. See the design's " +
          "PDF-handling section (poppler-utils is not yet part of the runtime image).",
      );
    } else if (extracted.text === null) {
      warnings.push(
        "this PDF has no extractable text layer (likely a scanned/image PDF) — " +
          "OCR-of-PDF-pages is not implemented by tier A",
      );
    }
    return {
      parserId: TESSERACT_PARSER_ID,
      parsedAt: new Date(),
      currency: null,
      documentTotal: null,
      text: extracted.text,
      lines: [],
      warnings,
    };
  }

  return {
    id: TESSERACT_PARSER_ID,
    label: TESSERACT_PARSER_LABEL,
    parse: async (input: { mediaObjectId: string; documentKind: ParseableDocumentKind }) => {
      const bytes = await readMedia(input.mediaObjectId);
      if (bytes.length === 0) {
        throw new DocumentsValidationError(
          `media object "${input.mediaObjectId}" resolved to zero bytes`,
        );
      }
      return looksLikePdf(bytes) ? parsePdf(bytes) : parseImage(input.mediaObjectId, bytes);
    },
  };
}
