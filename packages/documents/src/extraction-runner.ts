/**
 * The text-extraction run: load a document, hand its media object to a
 * registered {@link ReceiptParser}, and record the result — the logic a
 * Graphile Worker task (BUILD item 4 of loxep-cd3.4) wraps.
 *
 * ## Why this is a plain function, not a registered `@loxep/jobs` task
 *
 * `@loxep/jobs`' `defineTask` (`packages/jobs/src/conventions.ts`) is the
 * real registration mechanism, and a real task needs to be assembled into a
 * `TaskRegistry` somewhere a Graphile Worker runner reads
 * (`packages/app/src/registry.ts` is where every other domain's tasks are
 * composed). Registering there means `@loxep/app` — or `apps/web`'s
 * dynamic-import worker-composition layer — depends on `@loxep/documents`,
 * which is a `package.json` change outside this wave's write fence (the one
 * authorized manifest change this milestone is `tesseract.js` in THIS
 * package). So this module stops one layer short of registration: it
 * exports {@link runDocumentTextExtraction} with a signature
 * (`(payload, deps) => Promise<result>`) and a Zod payload schema
 * deliberately shaped to drop straight into `defineTask({ name, payloadSchema,
 * handler: (payload, { logger }) => runDocumentTextExtraction(payload, { ...,
 * logger }) })` once a follow-up pass is authorized to wire it up. Tested
 * directly against real PostgreSQL here; nothing about its correctness is
 * blocked on that wiring.
 *
 * ## At-least-once, and therefore idempotent
 *
 * Graphile Worker delivers at-least-once (ADR-0003/ADR-0018). Running this
 * twice for the same document is safe: tier A's `ParseResult.lines` is
 * always empty (no structured candidates to duplicate — see
 * `tesseract-parser.ts`'s module doc), and `documents.ts`'s
 * `recordParseResult` only ever overwrites `parser_id`/`parsed_at` and
 * `documents.currency`/`document_total` via `coalesce` (never regresses a
 * value that was already set by an earlier, more specific source). A
 * document with no media object (a CSV import; `source_kind <> 'upload'`)
 * or a non-parseable kind is skipped rather than errored — at-least-once
 * delivery for a job enqueued against a document that later changed shape
 * must not fail loudly for something that isn't actually wrong.
 *
 * ## The text is extracted AND stored (migration 0026, loxep-cd3.4 M4 follow-up)
 *
 * `result.text` — the OCR/PDF-text-layer output — is persisted via
 * `DocumentsService.recordParseResult`'s `update documents set parsed_text =
 * coalesce(<text literal>, parsed_text), ...` (`documents.ts`), the same
 * statement that already sets `parser_id`/`parsed_at`/`currency`/
 * `document_total`. `documents.parsed_text_tsv` (a `GENERATED ALWAYS AS ...
 * STORED` `tsvector`) is computed by PostgreSQL from that write — nothing in
 * this package or its caller ever writes it directly. Registration into a
 * running worker (a `defineTask` wrapper, `packages/app/src/
 * documents-extraction.ts`) followed once `@loxep/app` and `apps/web` both
 * declared `@loxep/documents` as a dependency.
 */
import { z } from "zod";
import { PARSEABLE_DOCUMENT_KINDS } from "./parser.ts";
import type { ParserRegistry } from "./parser.ts";
import type { DocumentsService } from "./documents.ts";

export const extractDocumentTextPayloadSchema = z.strictObject({
  documentId: z.uuid(),
  /** Which registered backend to use — normally the current `documents.parser_id` application setting; a caller may override for a one-off re-parse. */
  parserId: z.string().min(1),
});
export type ExtractDocumentTextPayload = z.input<typeof extractDocumentTextPayloadSchema>;

export interface RunExtractionLogger {
  info: (obj: object | string, msg?: string) => void;
  warn: (obj: object | string, msg?: string) => void;
}

export interface ExtractionRunnerDeps {
  documentsService: DocumentsService;
  parsers: ParserRegistry;
  logger?: RunExtractionLogger;
}

export type ExtractionRunResult =
  | { outcome: "skipped"; documentId: string; reason: string }
  | {
      outcome: "parsed";
      documentId: string;
      parserId: string;
      /** `null` when the backend recognized no text (or, for `manual`, always). */
      textLength: number | null;
      warnings: string[];
    };

const silentLogger: RunExtractionLogger = { info: () => {}, warn: () => {} };

/**
 * Run one extraction: load the document, skip it (no error) if it has
 * nothing a parser can read, otherwise call the registered backend and
 * record its result via `DocumentsService.recordParseResult` — the SAME
 * write path the manual-assisted flow and the CSV importer already use, so
 * a document's status/counters derive identically regardless of which
 * producer touched it.
 */
export async function runDocumentTextExtraction(
  payload: ExtractDocumentTextPayload,
  deps: ExtractionRunnerDeps,
): Promise<ExtractionRunResult> {
  const value = extractDocumentTextPayloadSchema.parse(payload);
  const logger = deps.logger ?? silentLogger;

  const document = await deps.documentsService.get(value.documentId);

  if (document.mediaObjectId === null) {
    logger.info(
      { documentId: document.id, sourceKind: document.sourceKind },
      "skipping text extraction: document has no media object (not an upload)",
    );
    return { outcome: "skipped", documentId: document.id, reason: "no_media_object" };
  }

  if (!PARSEABLE_DOCUMENT_KINDS.includes(document.documentKind as (typeof PARSEABLE_DOCUMENT_KINDS)[number])) {
    logger.info(
      { documentId: document.id, documentKind: document.documentKind },
      "skipping text extraction: document kind is not parseable",
    );
    return { outcome: "skipped", documentId: document.id, reason: "not_parseable_kind" };
  }

  const parser = deps.parsers.get(value.parserId);
  const result = await parser.parse({
    mediaObjectId: document.mediaObjectId,
    documentKind: document.documentKind as (typeof PARSEABLE_DOCUMENT_KINDS)[number],
  });

  if (result.warnings.length > 0) {
    logger.warn(
      { documentId: document.id, parserId: result.parserId, warnings: result.warnings },
      "text extraction completed with warnings",
    );
  }

  await deps.documentsService.recordParseResult({ documentId: document.id, result });

  return {
    outcome: "parsed",
    documentId: document.id,
    parserId: result.parserId,
    textLength: result.text?.length ?? null,
    warnings: result.warnings,
  };
}
