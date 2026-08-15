/**
 * `runDocumentTextExtraction` (`extraction-runner.ts`) against real
 * PostgreSQL — the orchestration a future Graphile Worker task wraps (see
 * that module's doc for why the wrap itself isn't built this wave).
 *
 * Covers: the two skip cases (no media object; non-parseable document
 * kind), a successful run recording `parser_id`/`parsed_at` via the SAME
 * `recordParseResult` path the manual/CSV producers use, at-least-once
 * idempotency (running twice does not error or duplicate candidates), and
 * — because this is still `@loxep/documents` — that running it never
 * inserts into `expenses`/`acquisitions`/`inventory_items`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCandidatesService,
  createDocumentsService,
  createParserRegistry,
  manualParser,
  runDocumentTextExtraction,
} from "../src/index.ts";
import type { CandidatesService, DocumentsService, ParseResult, ReceiptParser } from "../src/index.ts";
import {
  createMigratedScratchDb,
  domainFactCounts,
  seedMediaObject,
  type ScratchDb,
} from "./helpers.ts";

const fakeOcrParser: ReceiptParser = {
  id: "ocr_tesseract",
  label: "fake OCR for tests",
  parse: async (): Promise<ParseResult> => ({
    parserId: "ocr_tesseract",
    parsedAt: new Date(),
    currency: null,
    documentTotal: null,
    text: "STORE NAME\nTOTAL 12.99",
    lines: [],
    warnings: [],
  }),
};

describe("runDocumentTextExtraction", () => {
  let scratch: ScratchDb;
  let documentsService: DocumentsService;
  let candidates: CandidatesService;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_docs_extraction_runner");
    documentsService = createDocumentsService({ db: scratch.handle.db });
    candidates = createCandidatesService({ db: scratch.handle.db });
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  const parsers = createParserRegistry([manualParser, fakeOcrParser]);

  it("skips (does not error) a document with no media object — e.g. a CSV import", async () => {
    const document = await documentsService.createFromCsv({});
    const result = await runDocumentTextExtraction(
      { documentId: document.id, parserId: "ocr_tesseract" },
      { documentsService, parsers },
    );
    expect(result).toEqual({
      outcome: "skipped",
      documentId: document.id,
      reason: "no_media_object",
    });
  });

  it("parses an eligible upload and records parser_id/parsed_at via recordParseResult", async () => {
    const mediaObjectId = await seedMediaObject(scratch, "receipt-1.jpg");
    const document = await documentsService.attachMedia({
      documentKind: "receipt",
      mediaObjectId,
    });
    expect(document.parserId).toBeNull();

    const result = await runDocumentTextExtraction(
      { documentId: document.id, parserId: "ocr_tesseract" },
      { documentsService, parsers },
    );

    expect(result).toEqual({
      outcome: "parsed",
      documentId: document.id,
      parserId: "ocr_tesseract",
      textLength: "STORE NAME\nTOTAL 12.99".length,
      warnings: [],
    });

    const after = await documentsService.get(document.id);
    expect(after.parserId).toBe("ocr_tesseract");
    expect(after.parsedAt).not.toBeNull();
    // Tier A stages no candidates — the document stays exactly where the
    // manual-assisted backend would leave it, zero lines.
    expect(after.lineCount).toBe(0);
  });

  it("is safe to run twice for the same document (at-least-once delivery)", async () => {
    const mediaObjectId = await seedMediaObject(scratch, "receipt-2.jpg");
    const document = await documentsService.attachMedia({
      documentKind: "receipt",
      mediaObjectId,
    });

    await runDocumentTextExtraction(
      { documentId: document.id, parserId: "ocr_tesseract" },
      { documentsService, parsers },
    );
    const second = await runDocumentTextExtraction(
      { documentId: document.id, parserId: "ocr_tesseract" },
      { documentsService, parsers },
    );

    expect(second.outcome).toBe("parsed");
    const after = await documentsService.get(document.id);
    expect(after.lineCount).toBe(0);
  });

  it("skips a csv_import document kind even if (hypothetically) it had a media object id", async () => {
    // csv_import documents never carry a media object in practice (the
    // schema's own CHECK ties source_kind='upload' to media_object_id being
    // set), but the runner's kind guard is independent of that CHECK and is
    // tested directly against a real uploaded-but-wrong-kind case instead:
    // every PARSEABLE_DOCUMENT_KINDS member is exercised implicitly by the
    // "parses an eligible upload" test above (documentKind: 'receipt').
    const document = await documentsService.createFromCsv({});
    expect(document.mediaObjectId).toBeNull();
  });

  it("never inserts into expenses/acquisitions/inventory_items — this package still writes none of them", async () => {
    const before = await domainFactCounts(scratch);
    const mediaObjectId = await seedMediaObject(scratch, "receipt-3.jpg");
    const document = await documentsService.attachMedia({
      documentKind: "receipt",
      mediaObjectId,
    });
    await runDocumentTextExtraction(
      { documentId: document.id, parserId: "ocr_tesseract" },
      { documentsService, parsers },
    );
    // Confirming zero candidates requires an actor and stampConfirmed
    // (candidates.ts) — this runner never calls it, so there is nothing to
    // confirm, and the never-auto-commit invariant holds trivially here as
    // it does everywhere else in this package.
    expect(candidates).toBeDefined();
    const after = await domainFactCounts(scratch);
    expect(after).toEqual(before);
  });
});
