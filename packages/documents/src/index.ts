/**
 * @loxep/documents — receipt/invoice/CSV intake, manual-assisted parsing,
 * and tier A OCR (loxep-cd3.4).
 *
 * The flipping-lifecycle design's document milestone (loxep-dgf.4,
 * `apps/docs/src/content/docs/architecture/flipping-lifecycle-design.md`
 * sections 1 and 2b): uploaded purchase evidence and imported CSV rows
 * become structured line-item SUGGESTIONS — `document_line_candidates` — that
 * a human confirms. **The parser proposes, it never auto-commits.**
 *
 * ## The one rule that shapes every export here
 *
 * This package writes NO `expenses`, `acquisitions`, `acquisition_costs`, or
 * `inventory_items` row, ever, and never will — see `domain-boundaries.md`'s
 * "Documents" section, which specified this inversion before any table
 * existed. `candidates.ts`'s `stampConfirmed` is the only function that
 * records a confirmation happened, and it records ONLY which record a
 * consuming domain's OWN confirm function produced — it does not produce
 * that record itself.
 *
 * ## Package boundary (T2, per `flipping-lifecycle-design.md`'s "Package
 * ownership")
 *
 * `@loxep/documents` depends on `@loxep/db` and `@loxep/domain` only —
 * NEVER `@loxep/accounting` or `@loxep/inventory`. Both of those packages
 * depend on THIS one (to read the queue and to call `stampConfirmed` inside
 * their own confirm transactions); a dependency edge the other way would be
 * a cycle, which is C1's signal to merge packages rather than split them,
 * and merging is wrong here — confirmation is deliberately inverted.
 * `tesseract.js` is this package's one third-party addition (loxep-cd3.4) —
 * an in-process WASM OCR engine, never a service, so it does not disturb
 * this boundary.
 *
 * ## What is here now, and what is still not
 *
 * - **OCR, tier A only.** `tesseract-parser.ts`'s `ocr_tesseract` backend
 *   (design section 3, "SHIP IT, IN-PROCESS, WITH NO NEW CONTAINER")
 *   extracts a document's whole-page {@link ParseResult.text} — searchable
 *   evidence, per the design's own tier ladder, NOT structure: it produces
 *   `lines: []`, same as `manual-parser.ts`. `pdf-text-layer.ts` lifts an
 *   EXISTING PDF text layer via `pdftotext` rather than OCRing a digital
 *   invoice; it degrades honestly (`available: false`) where poppler-utils
 *   is not installed, which is everywhere as of this milestone (no Docker
 *   change was in this wave's fence). Tier C (structured autofill) remains
 *   refused by the design and is not built here.
 * - **`documents.parsed_text` does not exist yet.** Migration D has not
 *   landed; `extraction-runner.ts`'s module doc records the exact one-line
 *   SQL a follow-up pass adds once it does. The extraction itself is real
 *   and tested regardless.
 * - **No `codes.ts`.** Unlike `acquisitions`/`inventory_items`/`expenses`,
 *   neither `documents` nor `document_line_candidates` carries a
 *   human-scannable reference code — nobody labels a staged candidate row,
 *   and a document is identified by its (small) review queue position, not
 *   a code an operator would ever type or search for.
 */
export {
  DocumentsError,
  DocumentsValidationError,
  DocumentsNotFoundError,
  DocumentsConflictError,
  DocumentNotEditableError,
} from "./errors.ts";

export {
  PARSEABLE_DOCUMENT_KINDS,
  createParserRegistry,
} from "./parser.ts";
export type {
  ParseableDocumentKind,
  ReceiptParseInput,
  ParseResult,
  ParseResultLine,
  ReceiptParser,
  ParserRegistry,
} from "./parser.ts";

export {
  MANUAL_PARSER_ID,
  MANUAL_PARSER_LABEL,
  MANUAL_LINE_CONFIDENCE,
  manualParser,
  normalizeMoneyString,
  normalizeDateString,
} from "./manual-parser.ts";

export {
  TESSERACT_PARSER_ID,
  TESSERACT_PARSER_LABEL,
  LOW_CONFIDENCE_THRESHOLD,
  createTesseractParser,
  getSharedTesseractWorker,
  resetSharedTesseractWorkerForTests,
} from "./tesseract-parser.ts";
export type {
  TesseractWorkerLike,
  TesseractRawOutput,
  CreateTesseractParserOptions,
} from "./tesseract-parser.ts";

export { extractPdfTextLayer } from "./pdf-text-layer.ts";
export type { PdfTextLayerResult } from "./pdf-text-layer.ts";

export {
  extractDocumentTextPayloadSchema,
  runDocumentTextExtraction,
} from "./extraction-runner.ts";
export type {
  ExtractDocumentTextPayload,
  ExtractionRunnerDeps,
  ExtractionRunResult,
  RunExtractionLogger,
} from "./extraction-runner.ts";

export {
  CSV_FIELDS,
  parseCsvText,
  guessColumnMapping,
  computeRowFingerprint,
  mapCsvRows,
} from "./csv.ts";
export type { CsvField, CsvColumnMapping, CsvParseResult, CsvCandidateInput } from "./csv.ts";

export { createDocumentsService, recomputeDocumentCounters } from "./documents.ts";
export type {
  DocumentRow,
  CandidateRow,
  Executor,
  DocumentsService,
  CreateFromUploadInput,
  CreateFromCsvInput,
  DiscardInput,
} from "./documents.ts";

export { createCandidatesService } from "./candidates.ts";
export type {
  CandidatesService,
  AddLineInput,
  UpdateLineInput,
  SetDispositionInput,
  BulkSetDispositionInput,
  StampConfirmedInput,
} from "./candidates.ts";

export {
  DOCUMENT_KINDS,
  DOCUMENT_SOURCE_KINDS,
  DOCUMENT_STATUSES,
  LINE_DISPOSITIONS,
  CANDIDATE_TARGET_KINDS,
} from "@loxep/db/schema";
export type {
  DocumentKind,
  DocumentSourceKind,
  DocumentStatus,
  LineDisposition,
  CandidateTargetKind,
} from "@loxep/db/schema";
