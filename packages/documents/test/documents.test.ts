/**
 * `createDocumentsService`: creation (upload and CSV), the
 * `documents_source_kind_media_object_check` `CHECK` at both the Zod and the
 * PostgreSQL layer, `recordParseResult`, `stageCsvRows` (with the row-
 * fingerprint duplicate warning), the review queue, status derivation, and
 * discard.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCandidatesService,
  createDocumentsService,
  DocumentsValidationError,
  type CandidatesService,
  type DocumentsService,
} from "../src/index.ts";
import {
  createMigratedScratchDb,
  seedEntity,
  seedMediaObject,
  seedUser,
  type ScratchDb,
} from "./helpers.ts";

describe("documents service", () => {
  let scratch: ScratchDb;
  let documentsService: DocumentsService;
  let candidates: CandidatesService;
  let actorId: string;
  let entityId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_docs_documents");
    documentsService = createDocumentsService({ db: scratch.handle.db });
    candidates = createCandidatesService({ db: scratch.handle.db });
    actorId = await seedUser(scratch, "docs_actor");
    entityId = await seedEntity(scratch, "Loxep LLC");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  describe("creation", () => {
    it("attachMedia creates a source_kind='upload' document with the media reference", async () => {
      const mediaObjectId = await seedMediaObject(scratch);
      const document = await documentsService.attachMedia({
        documentKind: "receipt",
        mediaObjectId,
        economicEntityId: entityId,
        createdByUserId: actorId,
      });
      expect(document.sourceKind).toBe("upload");
      expect(document.mediaObjectId).toBe(mediaObjectId);
      expect(document.status).toBe("pending");
      expect(document.lineCount).toBe(0);
    });

    it("createFromCsv creates a source_kind='csv' document with NO media reference", async () => {
      const document = await documentsService.createFromCsv({ createdByUserId: actorId });
      expect(document.sourceKind).toBe("csv");
      expect(document.documentKind).toBe("csv_import");
      expect(document.mediaObjectId).toBeNull();
    });

    it("refuses attachMedia with an invalid media object id before ever reaching PostgreSQL's CHECK", async () => {
      await expect(
        documentsService.attachMedia({
          documentKind: "receipt",
          mediaObjectId: "not-a-uuid",
        }),
      ).rejects.toThrow();
    });

    it("the CHECK itself refuses a hand-crafted row that violates the kind/reference pair", async () => {
      // Reach past the service to prove the DATABASE enforces the invariant
      // too, not only the service's Zod layer.
      await expect(
        scratch.handle.pool.query(
          `insert into documents (document_kind, source_kind, media_object_id, status)
           values ('receipt', 'upload', null, 'pending')`,
        ),
      ).rejects.toThrow(/documents_source_kind_media_object_check/);
      await expect(
        scratch.handle.pool.query(
          `insert into documents (document_kind, source_kind, media_object_id, status)
           values ('csv_import', 'csv', $1, 'pending')`,
          [await seedMediaObject(scratch)],
        ),
      ).rejects.toThrow(/documents_source_kind_media_object_check/);
    });
  });

  describe("recordParseResult", () => {
    it("the manual-assisted parser stages ZERO candidates and leaves the document 'pending'", async () => {
      const mediaObjectId = await seedMediaObject(scratch);
      const document = await documentsService.attachMedia({
        documentKind: "receipt",
        mediaObjectId,
      });
      const { manualParser } = await import("../src/index.ts");
      const result = await manualParser.parse({ mediaObjectId, documentKind: "receipt" });
      expect(result.lines).toHaveLength(0);
      expect(result.warnings.length).toBeGreaterThan(0);

      const { document: after, candidates: inserted } = await documentsService.recordParseResult({
        documentId: document.id,
        result,
      });
      expect(inserted).toHaveLength(0);
      expect(after.status).toBe("pending");
      expect(after.parserId).toBe("manual");
      expect(after.parsedAt).not.toBeNull();
    });
  });

  describe("stageCsvRows and the fingerprint duplicate warning", () => {
    it("stages a clean row as disposition 'expense' and a warned row as 'pending'", async () => {
      const document = await documentsService.createFromCsv({});
      const { document: after, candidates: staged } = await documentsService.stageCsvRows({
        documentId: document.id,
        rows: [
          {
            lineNumber: 1,
            description: "Office supplies",
            lineAmount: "24.990000",
            lineDate: "2026-03-01",
            currency: "USD",
            payeeName: "Staples",
            rowFingerprint: "fp-docs-test-1",
            rowWarnings: [],
          },
          {
            lineNumber: 2,
            description: "Unreadable row",
            lineAmount: null,
            lineDate: null,
            currency: null,
            payeeName: null,
            rowFingerprint: "fp-docs-test-2",
            rowWarnings: ["row has no amount"],
          },
        ],
      });
      expect(after.lineCount).toBe(2);
      expect(after.status).toBe("review");
      expect(staged[0]?.disposition).toBe("expense");
      expect(staged[1]?.disposition).toBe("pending");
      // No `payee` column exists on document_line_candidates (the design's
      // own DDL) — the payee is folded into description rather than lost.
      expect(staged[0]?.description).toBe("Staples — Office supplies");
    });

    it("findCommittedFingerprints returns only fingerprints of CONFIRMED candidates", async () => {
      const document = await documentsService.createFromCsv({});
      const { candidates: staged } = await documentsService.stageCsvRows({
        documentId: document.id,
        rows: [
          {
            lineNumber: 1,
            description: "Coffee",
            lineAmount: "4.500000",
            lineDate: "2026-03-02",
            currency: "USD",
            payeeName: "Cafe",
            rowFingerprint: "fp-docs-committed-1",
            rowWarnings: [],
          },
        ],
      });

      // Not yet confirmed: not "committed" yet.
      const beforeConfirm = await documentsService.findCommittedFingerprints([
        "fp-docs-committed-1",
      ]);
      expect(beforeConfirm.has("fp-docs-committed-1")).toBe(false);

      await candidates.stampConfirmed({
        candidateId: staged[0]!.id,
        targetKind: "expense",
        targetId: crypto.randomUUID(),
        actorUserId: actorId,
      });

      const afterConfirm = await documentsService.findCommittedFingerprints([
        "fp-docs-committed-1",
        "fp-never-staged",
      ]);
      expect(afterConfirm.has("fp-docs-committed-1")).toBe(true);
      expect(afterConfirm.has("fp-never-staged")).toBe(false);
    });
  });

  describe("status derivation", () => {
    it("goes pending -> review -> partially_confirmed -> confirmed as lines resolve", async () => {
      const document = await documentsService.createFromCsv({});
      expect(document.status).toBe("pending");

      const { candidates: staged, document: afterStage } = await documentsService.stageCsvRows({
        documentId: document.id,
        rows: [
          {
            lineNumber: 1,
            description: "A",
            lineAmount: "1.000000",
            lineDate: "2026-01-01",
            currency: "USD",
            payeeName: null,
            rowFingerprint: "fp-status-a",
            rowWarnings: [],
          },
          {
            lineNumber: 2,
            description: "B",
            lineAmount: "2.000000",
            lineDate: "2026-01-01",
            currency: "USD",
            payeeName: null,
            rowFingerprint: "fp-status-b",
            rowWarnings: [],
          },
        ],
      });
      expect(afterStage.status).toBe("review");

      await candidates.stampConfirmed({
        candidateId: staged[0]!.id,
        targetKind: "expense",
        targetId: crypto.randomUUID(),
        actorUserId: actorId,
      });
      const afterOneConfirm = await documentsService.get(document.id);
      expect(afterOneConfirm.status).toBe("partially_confirmed");
      expect(afterOneConfirm.confirmedCount).toBe(1);

      await candidates.setDisposition({
        candidateId: staged[1]!.id,
        disposition: "personal",
        actorUserId: actorId,
      });
      const afterAllResolved = await documentsService.get(document.id);
      // 'confirmed' means "review is done" — one line actually confirmed,
      // one line terminally dispositioned without ever confirming, and
      // status is 'confirmed' either way.
      expect(afterAllResolved.status).toBe("confirmed");
      expect(afterAllResolved.confirmedAt).not.toBeNull();
      expect(afterAllResolved.confirmedCount).toBe(1);
    });
  });

  describe("listQueue", () => {
    it("defaults to excluding confirmed and discarded documents", async () => {
      const pending = await documentsService.createFromCsv({});
      const discarded = await documentsService.createFromCsv({});
      await documentsService.discard({ documentId: discarded.id, reason: "wrong file" });

      const queue = await documentsService.listQueue();
      const ids = queue.map((row) => row.id);
      expect(ids).toContain(pending.id);
      expect(ids).not.toContain(discarded.id);
    });

    it("an explicit statuses filter overrides the default", async () => {
      const discarded = await documentsService.createFromCsv({});
      await documentsService.discard({ documentId: discarded.id });
      const queue = await documentsService.listQueue({ statuses: ["discarded"] });
      expect(queue.map((row) => row.id)).toContain(discarded.id);
    });
  });

  describe("discard", () => {
    it("refuses to discard a document with a confirmed candidate", async () => {
      const document = await documentsService.createFromCsv({});
      const { candidates: staged } = await documentsService.stageCsvRows({
        documentId: document.id,
        rows: [
          {
            lineNumber: 1,
            description: "X",
            lineAmount: "5.000000",
            lineDate: "2026-01-01",
            currency: "USD",
            payeeName: null,
            rowFingerprint: "fp-discard-guard",
            rowWarnings: [],
          },
        ],
      });
      await candidates.stampConfirmed({
        candidateId: staged[0]!.id,
        targetKind: "expense",
        targetId: crypto.randomUUID(),
        actorUserId: actorId,
      });
      await expect(
        documentsService.discard({ documentId: document.id }),
      ).rejects.toBeInstanceOf(DocumentsValidationError);
    });

    it("cascades pending candidates to disposition 'discarded'", async () => {
      const document = await documentsService.createFromCsv({});
      const { candidates: staged } = await documentsService.stageCsvRows({
        documentId: document.id,
        rows: [
          {
            lineNumber: 1,
            description: "Y",
            lineAmount: "6.000000",
            lineDate: "2026-01-01",
            currency: "USD",
            payeeName: null,
            rowFingerprint: "fp-discard-cascade",
            rowWarnings: [],
          },
        ],
      });
      await documentsService.discard({ documentId: document.id, reason: "duplicate upload" });
      const line = await candidates.get(staged[0]!.id);
      expect(line.disposition).toBe("discarded");
      const after = await documentsService.get(document.id);
      expect(after.status).toBe("discarded");
      expect(after.note).toBe("duplicate upload");
    });
  });
});
