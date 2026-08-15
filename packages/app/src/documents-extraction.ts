/**
 * `documents.extract-text` — the Graphile Worker wrapper around
 * `@loxep/documents`'s `runDocumentTextExtraction` (loxep-cd3.4 M4's
 * previously-BLOCKED task-registration half; see that bead's notes for the
 * exact gap this closes: `@loxep/app`'s `package.json` did not declare
 * `@loxep/documents` as a dependency, so nothing here could import it).
 *
 * ## On-demand only, enqueued transactionally at upload time
 *
 * Unlike `health.sweep`/`accounting.post-facts`, this task carries no cron
 * item — it is enqueued exactly once per uploaded document, in the SAME
 * transaction that inserts the `documents` row
 * (`apps/web/src/server/documents-media.ts`'s `handleDocumentUpload`), the
 * same "enqueue inside the write that creates the fact" discipline
 * `@loxep/infrastructure`'s `tokens.ts`/`createTransactionalEnqueue` and
 * `fleet-evidence.ts`'s `receiveFleetEvidence` already establish. `jobKeyFor`
 * keys each job by `documentId` with the default `jobKeyMode: "replace"`, so
 * a hypothetical duplicate enqueue (never expected in practice — a document
 * id is minted once) updates the queued job in place rather than stacking a
 * second run; the handler is idempotent regardless (see below).
 *
 * ## Which parser: read live, not passed at enqueue time
 *
 * The enqueued payload carries only `documentId` — never `parserId`. The
 * handler reads `documents.parser_id` (`@loxep/domain`'s
 * `documentsParserIdSetting`) at RUN time, not the enqueuer's read at upload
 * time, so a setting change between "upload" and "the job actually runs"
 * (normally sub-second, but at-least-once delivery makes no timing promise)
 * always uses the CURRENT backend selection, matching `extraction-runner.ts`'s
 * own doc: "normally the current `documents.parser_id` application setting".
 *
 * ## The registered-backend set: `manualParser` + `ocr_tesseract`
 *
 * `@loxep/app`'s `package.json` now depends on `@loxep/storage` (the gap
 * this section used to record — `ocr_tesseract`, `tesseract-parser.ts`,
 * needs a `readMedia` function backed by `@loxep/storage`'s `MediaService`
 * to turn a `mediaObjectId` into bytes, and could not be constructed
 * without that dependency edge). {@link createDefaultParserRegistry} builds
 * the `MediaService` the SAME way `apps/web/src/server/admin.ts`'s
 * `getMediaService()` does — `createStorageBackendsService({ db, keyring })`
 * then `createMediaService({ db, backends })` — and is
 * {@link createDocumentsExtractionTasks}'s default `parsers` registry, so
 * the real worker now runs `ocr_tesseract` whenever
 * `documents.parser_id` (`@loxep/domain`'s `documentsParserIdSetting`) is
 * set to it; the shipped default (`'manual'`) is unaffected. The `parsers`
 * option remains overridable for tests (and for a future backend that needs
 * no `@loxep/storage`-shaped seam) without touching this module's shape.
 * A registry gap is still POSSIBLE in principle (a caller-supplied
 * `parsers` override that omits an id `documents.parser_id` names) — that
 * case, and a storage-layer failure resolving `ocr_tesseract`'s own media
 * read, both still degrade to a recorded `documents.status = 'failed'`
 * rather than a crash; see "Failure handling" below.
 *
 * ## Failure handling: recorded on the document, never a crash
 *
 * `runDocumentTextExtraction` itself only throws for a structural problem
 * (an unregistered parser id, a parser's own read/recognize failure) — never
 * for "nothing to do" (that is the `outcome: "skipped"` path, not a throw).
 * This wrapper catches any such error, writes it onto the `documents` row
 * (`status = 'failed'`, `note` set to the error message, ONLY when the
 * document is still `'pending'`/`'parsing'` — never overwriting a status an
 * operator's own review has since moved past) via the same direct-SQL
 * `coalesce`-guarded shape `documents.ts`'s own writes use, and returns a
 * `{ outcome: "failed" }` result rather than rethrowing. This is a
 * deliberate departure from "let Graphile retry": an unregistered parser id
 * or a corrupt upload will not resolve itself on attempt 2, and the DESIGN's
 * own words are "it CANNOT confirm anything" for a background job — the
 * matching promise on the failure side is "it cannot pretend a bad extraction
 * didn't happen", surfaced on the document the operator is already looking
 * at in `/finance/import` rather than buried in worker logs. A transient
 * infrastructure error (the database connection itself) still propagates
 * normally, because the failure-recording write would fail too, and Graphile's
 * own retry is the right tool for that case.
 */
import { buffer as bufferFromStream } from "node:stream/consumers";
import { documentsParserIdSetting } from "@loxep/domain";
import {
  DocumentsError,
  createDocumentsService,
  createParserRegistry,
  createTesseractParser,
  manualParser,
  runDocumentTextExtraction,
} from "@loxep/documents";
import type {
  DocumentsService,
  ExtractionRunResult,
  ParserRegistry,
} from "@loxep/documents";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
// `@loxep/storage`'s DEFAULT entry — dependency-light, no `@loxep/jobs`
// import (see that package's own module doc) — is safe to import statically
// here, unlike `apps/web`'s `getMediaService()`, which reaches it through a
// lazy accessor ONLY because `LOXEP_MODE=web` must not pay for the worker's
// dependency graph. `@loxep/app` already pulls `@loxep/jobs` (this whole
// package IS the worker composition root), so that constraint does not
// apply here.
import { StorageError, createMediaService, createStorageBackendsService } from "@loxep/storage";
import type { MediaService } from "@loxep/storage";
import { z } from "zod";
import type { AppServices } from "./services.ts";

export const DOCUMENTS_EXTRACT_TEXT_TASK_NAME = "documents.extract-text";

/**
 * The task's retry budget — shared between {@link createDocumentsExtractionTasks}'s
 * `defineTask({ maxAttempts })` and {@link enqueueDocumentTextExtraction}'s
 * raw `graphile_worker.add_job` call, which (unlike `@loxep/jobs`' typed
 * `addJob`) does not read a `LoxepTask`'s `maxAttempts` automatically —
 * `@loxep/infrastructure`'s `createTransactionalEnqueue` and `@loxep/domain`'s
 * `createTransactionalNotificationEnqueue` share the same gap and, like
 * them, this module closes it by passing `max_attempts` explicitly rather
 * than accepting Graphile's own default of 25.
 */
const DOCUMENTS_EXTRACT_TEXT_MAX_ATTEMPTS = 3;

/** `jobKeyFor(DOCUMENTS_EXTRACT_TEXT_TASK_NAME, documentId)` — exported so the upload route builds the identical key. */
export function documentsExtractTextJobKey(documentId: string): string {
  return jobKeyFor(DOCUMENTS_EXTRACT_TEXT_TASK_NAME, documentId);
}

/** Anything with a raw-SQL `execute` — a `DbHandle['db']`, an open `db.transaction` callback's `tx`, or a plain pool-backed executor. */
export interface DocumentsExtractTextEnqueueExecutor {
  execute: (sql: string) => Promise<unknown>;
}

/**
 * The transactional enqueue: `apps/web/src/server/documents-media.ts`'s
 * `handleDocumentUpload` calls this with its OWN open transaction (the same
 * one that inserts the `documents` row), reached through `admin.ts`'s
 * `getFleetModule()` `@vite-ignore` dynamic import — the sanctioned way
 * `apps/web` reaches a `@loxep/app` export without a static `package.json`
 * dependency edge (see `fleet-evidence-webhook.ts`'s identical use for
 * `receiveFleetEvidence`). Issues `graphile_worker.add_job` directly through
 * the given executor — never `@loxep/jobs`' own `addJob`, which opens its
 * own pool connection and would silently lose the atomicity the whole point
 * of "transactional" is. Mirrors `@loxep/infrastructure`'s
 * `createTransactionalEnqueue` and `@loxep/domain`'s
 * `createTransactionalNotificationEnqueue` exactly — the same seam shape,
 * inlined here rather than imported from either (neither package is this
 * module's own dependency, and the SQL is four lines).
 */
export async function enqueueDocumentTextExtraction(
  executor: DocumentsExtractTextEnqueueExecutor,
  documentId: string,
): Promise<void> {
  const validId = z.uuid().parse(documentId);
  await executor.execute(
    `select graphile_worker.add_job(
       ${escapeSqlLiteral(DOCUMENTS_EXTRACT_TEXT_TASK_NAME)},
       payload => ${escapeSqlLiteral(JSON.stringify({ documentId: validId }))}::json,
       job_key => ${escapeSqlLiteral(documentsExtractTextJobKey(validId))},
       job_key_mode => 'replace',
       max_attempts => ${DOCUMENTS_EXTRACT_TEXT_MAX_ATTEMPTS}
     )`,
  );
}

const documentsExtractTextPayloadSchema = z.strictObject({
  documentId: z.uuid(),
  correlationId: z.string().optional(),
});
export type DocumentsExtractTextPayload = z.input<
  typeof documentsExtractTextPayloadSchema
>;

export type DocumentsExtractTextTask = LoxepTask<
  typeof documentsExtractTextPayloadSchema
>;

export interface DocumentsExtractionTasks {
  extractTextTask: DocumentsExtractTextTask;
}

export type DocumentsExtractTextResult =
  | ExtractionRunResult
  | { outcome: "failed"; documentId: string; parserId: string; reason: string };

export interface CreateDocumentsExtractionTasksOptions {
  services: AppServices;
  /**
   * Overridable registry — defaults to {@link createDefaultParserRegistry}
   * (`manualParser` + `ocr_tesseract`, the latter's media reads bound to a
   * real `MediaService`). Tests supply a fake/counting registry here instead
   * of exercising the real storage stack.
   */
  parsers?: ParserRegistry;
  /** Reuse an already-built `DocumentsService` (tests). */
  documentsService?: DocumentsService;
}

function escapeSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const uuidPattern = z.uuid();

/** Quoted UUID literal — validated, never trusted raw, even though every caller has already passed a `z.uuid()`-parsed value. */
function uuidLiteral(value: string): string {
  return escapeSqlLiteral(uuidPattern.parse(value));
}

/**
 * Record a failed extraction attempt on `documents` — `status = 'failed'`
 * and `note` set to the failure reason, but ONLY while the document is still
 * `'pending'`/`'parsing'` (an operator's own review, which can only have
 * happened because candidates already exist, always wins). Mirrors
 * `@loxep/documents/documents.ts`'s own `coalesce`-guarded update shape so a
 * repeated failure (at-least-once retries, or a second upload's extraction
 * failing after the first) never clobbers a note an operator has since
 * written by hand.
 */
async function recordExtractionFailure(
  services: AppServices,
  documentId: string,
  reason: string,
): Promise<void> {
  await services.db.execute(
    `update documents
        set status = case when status in ('pending', 'parsing') then 'failed' else status end,
            note = coalesce(note, ${escapeSqlLiteral(reason)}),
            updated_at = now()
      where id = ${uuidLiteral(documentId)}`,
  );
}

async function readParserId(services: AppServices): Promise<string> {
  const setting = await services.settings.get(documentsParserIdSetting);
  return setting.parserId;
}

/**
 * Builds the `MediaService` `ocr_tesseract` reads bytes through, the SAME
 * construction `apps/web/src/server/admin.ts`'s `getMediaService()` does
 * (`createStorageBackendsService({ db, keyring })` then
 * `createMediaService({ db, backends })`) — that module's doc is the
 * reference for why this exact pair, in this exact order, is the seam. No
 * caching/memoization here (unlike `admin.ts`'s registry-cached promise):
 * `createDefaultParserRegistry` itself is called once, at worker
 * composition time (`createDocumentsExtractionTasks`), so there is nothing
 * to memoize — this function's own single call site already IS the cache.
 */
function buildMediaService(services: AppServices): MediaService {
  const backends = createStorageBackendsService({
    db: services.db,
    keyring: services.config.keyring,
  });
  return createMediaService({ db: services.db, backends });
}

/**
 * The registered-parser set the real worker runs with: `manualParser` (the
 * shipped default) plus `ocr_tesseract` (`tesseract-parser.ts`), its
 * `readMedia` seam bound to a real `MediaService.read()` — `Readable` ->
 * `Buffer` via `node:stream/consumers`' `buffer()` (a `Buffer` satisfies
 * `Uint8Array`, `ReceiptParseInput`'s own contract). This is what closes the
 * gap this module's doc used to record: `@loxep/app` now depends on
 * `@loxep/storage`, so the ONE thing standing between "the task is wired"
 * and "an uploaded image actually gets OCR'd" was this function.
 */
export function createDefaultParserRegistry(services: AppServices): ParserRegistry {
  const mediaService = buildMediaService(services);
  const tesseractParser = createTesseractParser({
    readMedia: async (mediaObjectId) => {
      const { body } = await mediaService.read(mediaObjectId);
      return await bufferFromStream(body);
    },
  });
  return createParserRegistry([manualParser, tesseractParser]);
}

/**
 * `documents.extract-text` — wraps `runDocumentTextExtraction` for one
 * document. Exported separately from the task definition so a test (or a
 * future "re-parse now" admin action) can call it without a Graphile
 * `TaskContext`.
 */
export async function runDocumentsExtractTextJob(
  payload: DocumentsExtractTextPayload,
  deps: {
    services: AppServices;
    parsers: ParserRegistry;
    documentsService: DocumentsService;
    logger?: { info: (obj: object | string, msg?: string) => void; warn: (obj: object | string, msg?: string) => void };
  },
): Promise<DocumentsExtractTextResult> {
  const value = documentsExtractTextPayloadSchema.parse(payload);
  const parserId = await readParserId(deps.services);
  try {
    return await runDocumentTextExtraction(
      { documentId: value.documentId, parserId },
      {
        documentsService: deps.documentsService,
        parsers: deps.parsers,
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      },
    );
  } catch (error) {
    // A structural failure — an unregistered parser id or a parser's own
    // read/recognize error (`DocumentsError`), OR the media object/backend
    // itself being missing or misconfigured (`StorageError`, from
    // `ocr_tesseract`'s `readMedia` seam: `MediaObjectNotFoundError`/
    // `StorageBackendError`/etc. all extend it) — see this module's doc for
    // why both are recorded rather than rethrown: neither resolves itself on
    // a retry. Anything else (a database connectivity blip while LOADING the
    // document, for instance) still propagates so Graphile's own
    // retry/backoff applies.
    if (!(error instanceof DocumentsError) && !(error instanceof StorageError)) throw error;
    const reason = error.message;
    deps.logger?.warn(
      { documentId: value.documentId, parserId, err: reason },
      "document text extraction failed; recording on the document",
    );
    await recordExtractionFailure(deps.services, value.documentId, reason);
    return {
      outcome: "failed",
      documentId: value.documentId,
      parserId,
      reason,
    };
  }
}

export function createDocumentsExtractionTasks(
  options: CreateDocumentsExtractionTasksOptions,
): DocumentsExtractionTasks {
  const { services } = options;
  const parsers = options.parsers ?? createDefaultParserRegistry(services);
  const documentsService =
    options.documentsService ?? createDocumentsService({ db: services.db });

  const extractTextTask = defineTask({
    name: DOCUMENTS_EXTRACT_TEXT_TASK_NAME,
    payloadSchema: documentsExtractTextPayloadSchema,
    // A structural failure (bad parser id, unreadable media) is recorded
    // and does not retry (see runDocumentsExtractTextJob's catch); the
    // remaining retry budget covers a transient DB blip loading the
    // document or writing the failure note itself.
    maxAttempts: DOCUMENTS_EXTRACT_TEXT_MAX_ATTEMPTS,
    handler: async (payload, { logger }) => {
      const result = await runDocumentsExtractTextJob(payload, {
        services,
        parsers,
        documentsService,
        logger,
      });
      logger.info({ ...result }, "document text extraction task completed");
      return result;
    },
  });

  return { extractTextTask };
}
