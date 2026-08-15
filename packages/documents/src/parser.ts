/**
 * The pluggable receipt/invoice parser backend contract.
 *
 * From `flipping-lifecycle-design.md` section 2b ("The parser interface") —
 * the load-bearing design decision of the Documents domain's first
 * milestone, because it is the one that decides whether Loxep stays a
 * self-hosted product that works with no egress and no extra binaries.
 *
 * Three properties are non-negotiable and every one of them is checkable:
 *
 * - **The output is candidates, never records.** {@link ParseResult} carries
 *   no Loxep id for an expense, an acquisition, or an item, and a
 *   {@link ReceiptParser} is never handed a database handle. It cannot write
 *   a domain row because it is not given the means to.
 * - **Confidence is per line, and it is always present.** A manual
 *   transcription reports `1.0` because a human typed it — a uniform shape
 *   means the review UI never branches on which backend produced a line.
 * - **Source regions are optional and are for the human.** They drive the
 *   side-by-side highlight; nothing downstream depends on them, so a backend
 *   that cannot produce them (manual-assisted, the only one this milestone
 *   ships) is still a first-class backend.
 *
 * OQ3 (owner-review-critical: which backend a self-hosted Loxep ships with)
 * is resolved per the design's own recommendation: **manual-assisted only**
 * this milestone. No OCR or LLM-vision backend lives in this package — see
 * `manual-parser.ts`, the one backend registered by {@link createParserRegistry}.
 * Adding a later backend means implementing this interface and registering
 * it; it changes no table, no confirm path, and no review UI.
 */
import { DocumentsNotFoundError, DocumentsValidationError } from "./errors.ts";

/** Mirrors `documents.document_kind` minus `csv_import` — a CSV never goes through a {@link ReceiptParser}. */
export const PARSEABLE_DOCUMENT_KINDS = [
  "receipt",
  "invoice",
  "packing_slip",
  "statement",
] as const;
export type ParseableDocumentKind = (typeof PARSEABLE_DOCUMENT_KINDS)[number];

export interface ReceiptParseInput {
  /** An already-stored media object; a parser receives a Loxep media id, never a path or a URL. */
  mediaObjectId: string;
  documentKind: ParseableDocumentKind;
  hints?: {
    currency?: string;
    /** A plain decimal string, matching `documents.document_total`'s shape. */
    expectedTotal?: string;
  };
}

export interface ParseResultLine {
  description: string | null;
  /** Plain decimal strings, never a JavaScript `number` — money crosses this boundary as text. */
  quantity: string | null;
  unitAmount: string | null;
  lineAmount: string | null;
  /** `0..1`, per line, always present. */
  confidence: number;
  fieldConfidence?: Record<string, number>;
  /** A small rectangle for the review UI's highlight; nothing downstream depends on it. */
  sourceRegion?: { page: number; x: number; y: number; w: number; h: number };
}

export interface ParseResult {
  parserId: string;
  parsedAt: Date;
  currency: string | null;
  documentTotal: string | null;
  /**
   * The full document text, whole-page, for search — tier A's own output
   * (`documents.parsed_text` in the design's migration D, not yet a real
   * column; see `tesseract-parser.ts`'s module doc for the current landing
   * spot pending that migration). `null` for a backend that produces no
   * text at all (the manual-assisted backend, always) or when a backend
   * recognized nothing. Deliberately separate from {@link lines}: tier A is
   * "no boxes, no structure, no guesses" — a document's extracted text and
   * its (still empty, this milestone) structured candidates are two
   * different claims, and conflating them would make a document with
   * searchable text but zero line items look like a parsing failure.
   */
  text: string | null;
  lines: ParseResultLine[];
  warnings: string[];
}

export interface ReceiptParser {
  /** `'manual' | 'ocr_tesseract' | 'llm_vision' | ...` — stable, stored as `documents.parser_id`. */
  id: string;
  label: string;
  parse(input: ReceiptParseInput): Promise<ParseResult>;
}

export interface ParserRegistry {
  get(parserId: string): ReceiptParser;
  list(): ReceiptParser[];
}

/**
 * A small in-memory registry over the backends this Loxep installation has
 * registered. Selection is by application setting (`documents.parser_id`,
 * the design's "selected by application setting" — the setting itself is a
 * `@loxep/domain` addition outside this package's write fence; see the
 * README/PR notes for the deferred `application_settings` key).
 */
export function createParserRegistry(parsers: ReceiptParser[]): ParserRegistry {
  const byId = new Map(parsers.map((parser) => [parser.id, parser]));
  if (byId.size !== parsers.length) {
    throw new DocumentsValidationError(
      "duplicate parser id registered in the parser registry",
    );
  }
  return {
    get(parserId: string): ReceiptParser {
      const parser = byId.get(parserId);
      if (parser === undefined) {
        throw new DocumentsNotFoundError(`unknown parser backend "${parserId}"`);
      }
      return parser;
    },
    list(): ReceiptParser[] {
      return [...byId.values()];
    },
  };
}
