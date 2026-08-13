/**
 * @loxep/documents — receipt/invoice/CSV intake and manual-assisted parsing.
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
 *
 * ## What is NOT here
 *
 * - **No OCR or LLM parser backend.** OQ3 (owner-review-critical: which
 *   backend a self-hosted Loxep ships with) is resolved as manual-assisted
 *   ONLY this milestone — see `manual-parser.ts`. `parser.ts`'s
 *   {@link ReceiptParser} interface makes a future backend pluggable; adding
 *   one changes no table, no confirm path, and no review UI.
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
