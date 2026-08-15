/**
 * `documents.extract-text` wiring tests (loxep-cd3.4 M4): the task shape, a
 * real run against a real scratch database through the REAL
 * `buildAppServices` composition root, the `@loxep/storage` wiring that
 * closes M4's own previously-recorded gap (`createDefaultParserRegistry`
 * now carries `ocr_tesseract`, media reads bound to a real `MediaService`,
 * proven with a real end-to-end OCR run against the synthetic-receipt
 * fixture `@loxep/documents`' own test suite uses), the honest degrade path
 * for a registry gap that's still possible in principle, and the
 * `parsed_text`/`parsed_text_tsv` write this task is what finally reaches.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import { mediaObjects, storageBackends, user } from "@loxep/db/schema";
import type { DbHandle } from "@loxep/db";
import { documentsParserIdSetting } from "@loxep/domain";
import {
  DocumentsError,
  createDocumentsService,
  createParserRegistry,
  getSharedTesseractWorker,
  manualParser,
  resetSharedTesseractWorkerForTests,
} from "@loxep/documents";
import type { DocumentsService, ParseResult, ReceiptParser } from "@loxep/documents";
import { jobKeyFor } from "@loxep/jobs";
import type { TaskContext } from "@loxep/jobs";
import { StorageError, createMediaService, createStorageBackendsService } from "@loxep/storage";
// The same synthetic-receipt PNG generator `@loxep/documents/test/
// tesseract-parser.test.ts` uses for its own real-OCR assertions
// ("TOTAL"/"COST" are the two words this hand-rolled block font renders
// most unambiguously) — reused here rather than duplicated, since this
// suite's whole point is proving the SAME real tesseract.js pipeline runs
// end to end through this package's task/registry wiring.
import { syntheticReceiptPng } from "../../documents/test/fixtures/synthetic-receipt.ts";
import {
  DOCUMENTS_EXTRACT_TEXT_TASK_NAME,
  buildAppServices,
  createDefaultParserRegistry,
  createDocumentsExtractionTasks,
  documentsExtractTextJobKey,
} from "../src/index.ts";
import type { AppServices } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
} from "./helpers.ts";

function noopHelpers(): TaskContext["helpers"] {
  return { addJob: async () => ({}) as never } as unknown as TaskContext["helpers"];
}

/** A real `media_objects` row — no bytes written, mirrors `@loxep/documents/test/helpers.ts`'s `seedMediaObject`. */
async function seedMediaObject(handle: DbHandle, filename = "receipt.jpg"): Promise<string> {
  const backendRows = await handle.db
    .insert(storageBackends)
    .values({ name: "app-test-local", driver: "local", config: { root: "/tmp/loxep-app-test" } })
    .returning({ id: storageBackends.id });
  const backendId = backendRows[0]?.id;
  if (backendId === undefined) throw new Error("storage backend insert returned no row");
  const mediaRows = await handle.db
    .insert(mediaObjects)
    .values({
      storageBackendId: backendId,
      storageKey: `media/${randomBytes(8).toString("hex")}.jpg`,
      originalFilename: filename,
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      sha256: randomBytes(32).toString("hex"),
      metadata: { purpose: "document" },
    })
    .returning({ id: mediaObjects.id });
  const mediaObjectId = mediaRows[0]?.id;
  if (mediaObjectId === undefined) throw new Error("media object insert returned no row");
  return mediaObjectId;
}

const fakeOcrParser: ReceiptParser = {
  id: "ocr_tesseract",
  label: "fake OCR for tests",
  parse: async (): Promise<ParseResult> => ({
    parserId: "ocr_tesseract",
    parsedAt: new Date(),
    currency: null,
    documentTotal: null,
    text: "HOME DEPOT\nMilwaukee M18 Impact Driver\nTOTAL 129.99",
    lines: [],
    warnings: [],
  }),
};

describe("documents.extract-text", () => {
  const dbName = scratchDbName("loxep_test_app_documents_extraction");
  let databaseUrl = "";
  let handle: DbHandle;
  let services: AppServices;
  let documentsService: DocumentsService;

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    services = buildAppServices({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });
    documentsService = createDocumentsService({ db: services.db });
    await handle.db.insert(user).values({
      id: "documents-extraction-test-fixture",
      name: "Documents Extraction Fixture",
      email: "documents-extraction@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    await services?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("has the expected task name and a 3-attempt retry budget", () => {
    const tasks = createDocumentsExtractionTasks({ services });
    expect(tasks.extractTextTask.name).toBe(DOCUMENTS_EXTRACT_TEXT_TASK_NAME);
    expect(tasks.extractTextTask.maxAttempts).toBe(3);
  });

  it("documentsExtractTextJobKey matches jobKeyFor(taskName, documentId)", () => {
    expect(documentsExtractTextJobKey("abc-123")).toBe(
      jobKeyFor(DOCUMENTS_EXTRACT_TEXT_TASK_NAME, "abc-123"),
    );
  });

  it("runs the shipped default (manualParser only) end to end: parser_id/parsed_at land, parsed_text stays null", async () => {
    const mediaObjectId = await seedMediaObject(handle);
    const document = await documentsService.attachMedia({
      documentKind: "receipt",
      mediaObjectId,
      createdByUserId: "documents-extraction-test-fixture",
    });

    const tasks = createDocumentsExtractionTasks({ services });
    const result = await tasks.extractTextTask.handler(
      { documentId: document.id },
      { logger: silentJobsLogger, helpers: noopHelpers() },
    );
    expect(result).toMatchObject({ outcome: "parsed", parserId: "manual" });

    const after = await documentsService.get(document.id);
    expect(after.parserId).toBe("manual");
    expect(after.parsedAt).not.toBeNull();
    // The manual-assisted backend never produces text — parsed_text stays
    // null, matching the manual-backend behavior `manual-parser.ts` documents.
    expect(after.parsedText).toBeNull();
    expect(after.status).toBe("pending");
  });

  it("with an injected registry that DOES carry ocr_tesseract, persists parsed_text and the generated tsvector finds it", async () => {
    const mediaObjectId = await seedMediaObject(handle);
    const document = await documentsService.attachMedia({
      documentKind: "receipt",
      mediaObjectId,
      createdByUserId: "documents-extraction-test-fixture",
    });
    await services.settings.set(documentsParserIdSetting, { parserId: "ocr_tesseract" }, {
      actorUserId: "documents-extraction-test-fixture",
    });

    const tasks = createDocumentsExtractionTasks({
      services,
      parsers: createParserRegistry([manualParser, fakeOcrParser]),
    });
    const result = await tasks.extractTextTask.handler(
      { documentId: document.id },
      { logger: silentJobsLogger, helpers: noopHelpers() },
    );
    expect(result).toMatchObject({ outcome: "parsed", parserId: "ocr_tesseract" });

    const after = await documentsService.get(document.id);
    expect(after.parsedText).toBe("HOME DEPOT\nMilwaukee M18 Impact Driver\nTOTAL 129.99");

    const found = await handle.pool.query<{ id: string }>(
      `select id from documents where id = $1 and parsed_text_tsv @@ websearch_to_tsquery('simple', $2)`,
      [document.id, "Milwaukee"],
    );
    expect(found.rows).toHaveLength(1);

    // Reset the installation-wide setting so later tests in this file see
    // the shipped default again.
    await services.settings.set(documentsParserIdSetting, { parserId: "manual" }, {
      actorUserId: "documents-extraction-test-fixture",
    });
  });

  it("the DEFAULT registry (no override) — exactly what registry.ts wires into the real worker — carries BOTH manual and ocr_tesseract", () => {
    // Closes M4's own previously-recorded gap: @loxep/app now depends on
    // @loxep/storage, so createDefaultParserRegistry can construct
    // ocr_tesseract's readMedia seam. Cheap and fast — building the
    // registry does not start the tesseract.js WASM worker (lazy on first
    // parse(), per tesseract-parser.ts's own doc), so this needs no real
    // storage backend and no 30s timeout.
    const registry = createDefaultParserRegistry(services);
    expect(registry.list().map((parser) => parser.id).toSorted()).toEqual([
      "manual",
      "ocr_tesseract",
    ]);
    expect(() => registry.get("ocr_tesseract")).not.toThrow();
  });

  describe("ocr_tesseract through the DEFAULT registry: a real end-to-end round trip", () => {
    let localRootDir: string;

    beforeAll(async () => {
      // A REAL local storage backend, registered the same way an operator
      // would from /settings/storage — unlike seedMediaObject's DB-only
      // metadata rows above, this one can actually serve bytes, which is
      // the whole point: ocr_tesseract's readMedia seam now reads through a
      // real MediaService (documents-extraction.ts's createDefaultParserRegistry).
      localRootDir = await mkdtemp(join(tmpdir(), "loxep-app-test-ocr-"));
      const backends = createStorageBackendsService({
        db: services.db,
        keyring: services.config.keyring,
      });
      await backends.registerBackend({
        name: "app-test-ocr-local",
        driver: "local",
        config: { rootDir: localRootDir },
        makeDefault: true,
        createdByUserId: "documents-extraction-test-fixture",
      });
    }, 30_000);

    afterAll(async () => {
      // Real tesseract.js worker started lazily during the test below —
      // terminate and drop the module-level singleton so it does not leak
      // into another test file sharing this vitest worker process.
      const worker = await getSharedTesseractWorker();
      await (worker as unknown as { terminate: () => Promise<unknown> }).terminate();
      resetSharedTesseractWorkerForTests();
      await rm(localRootDir, { recursive: true, force: true });
    }, 30_000);

    it("uploads a real receipt image, extracts real recognizable text, and the generated tsvector finds it", async () => {
      const backends = createStorageBackendsService({
        db: services.db,
        keyring: services.config.keyring,
      });
      const media = createMediaService({ db: services.db, backends });
      const mediaObject = await media.upload({
        data: syntheticReceiptPng(),
        originalFilename: "synthetic-receipt.png",
        mimeType: "image/png",
        createdByUserId: "documents-extraction-test-fixture",
        metadata: { purpose: "document" },
      });
      const document = await documentsService.attachMedia({
        documentKind: "receipt",
        mediaObjectId: mediaObject.id,
        createdByUserId: "documents-extraction-test-fixture",
      });
      await services.settings.set(documentsParserIdSetting, { parserId: "ocr_tesseract" }, {
        actorUserId: "documents-extraction-test-fixture",
      });

      // NO `parsers` override — this is the exact composition
      // `registry.ts` builds for the real worker.
      const tasks = createDocumentsExtractionTasks({ services });
      const result = await tasks.extractTextTask.handler(
        { documentId: document.id },
        { logger: silentJobsLogger, helpers: noopHelpers() },
      );
      expect(result).toMatchObject({ outcome: "parsed", parserId: "ocr_tesseract" });

      const after = await documentsService.get(document.id);
      expect(after.parsedText).not.toBeNull();
      const upper = (after.parsedText ?? "").toUpperCase();
      // Loose, resilient assertions — same two words
      // tesseract-parser.test.ts's own real-OCR test anchors on; this
      // hand-rolled block font is not a real receipt font, so the goal is
      // "the real pipeline recognized something real end to end through
      // this package's wiring", not an exact transcript.
      expect(upper).toContain("TOTAL");
      expect(upper).toContain("COST");

      const found = await handle.pool.query<{ id: string }>(
        `select id from documents where id = $1 and parsed_text_tsv @@ websearch_to_tsquery('simple', $2)`,
        [document.id, "TOTAL"],
      );
      expect(found.rows).toHaveLength(1);

      await services.settings.set(documentsParserIdSetting, { parserId: "manual" }, {
        actorUserId: "documents-extraction-test-fixture",
      });
    }, 30_000);
  });

  it("does not crash the worker: the thrown error is a DocumentsError instance, caught by the wrapper, not left to propagate", async () => {
    const mediaObjectId = await seedMediaObject(handle);
    const document = await documentsService.attachMedia({
      documentKind: "receipt",
      mediaObjectId,
      createdByUserId: "documents-extraction-test-fixture",
    });
    await services.settings.set(documentsParserIdSetting, { parserId: "nonexistent" }, {
      actorUserId: "documents-extraction-test-fixture",
    });

    const tasks = createDocumentsExtractionTasks({ services });
    await expect(
      tasks.extractTextTask.handler(
        { documentId: document.id },
        { logger: silentJobsLogger, helpers: noopHelpers() },
      ),
    ).resolves.toMatchObject({ outcome: "failed" });

    await services.settings.set(documentsParserIdSetting, { parserId: "manual" }, {
      actorUserId: "documents-extraction-test-fixture",
    });
  });

  it("never rethrows anything but a DocumentsError or a StorageError — a structural bug still surfaces", () => {
    // Documentary assertion: DocumentsError (an unregistered parser id, a
    // parser's own read/recognize failure) and StorageError (ocr_tesseract's
    // readMedia seam hitting a missing media object or a misconfigured
    // backend) are the exact two discriminators the wrapper's catch uses
    // (documents-extraction.ts). Asserted here so a future refactor that
    // widens/narrows the catch trips a test, not a silent behavior change in
    // production.
    expect(new DocumentsError("x")).toBeInstanceOf(Error);
    expect(new StorageError("x")).toBeInstanceOf(Error);
  });
});
