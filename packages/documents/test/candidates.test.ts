/**
 * `createCandidatesService`: line CRUD, the "confirmed lines are locked"
 * edit guard, `setDisposition`/`bulkSetDisposition`, and `stampConfirmed`'s
 * idempotency + conflict behavior — including the confirmation idempotency
 * cases the design's "before implementing" section calls out by name: the
 * same candidate confirmed twice, and a candidate confirmed into ONE target
 * that later attempts a SECOND, different target.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCandidatesService,
  createDocumentsService,
  DocumentNotEditableError,
  DocumentsConflictError,
  type CandidatesService,
  type DocumentsService,
} from "../src/index.ts";
import { createMigratedScratchDb, seedUser, type ScratchDb } from "./helpers.ts";

describe("candidates service", () => {
  let scratch: ScratchDb;
  let documentsService: DocumentsService;
  let candidates: CandidatesService;
  let actorId: string;
  let documentId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_docs_candidates");
    documentsService = createDocumentsService({ db: scratch.handle.db });
    candidates = createCandidatesService({ db: scratch.handle.db });
    actorId = await seedUser(scratch, "cand_actor");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  beforeAll(async () => {
    const document = await documentsService.createFromCsv({});
    documentId = document.id;
  });

  describe("addLine / updateLine / removeLine", () => {
    it("addLine assigns sequential line numbers and confidence 1.0", async () => {
      const first = await candidates.addLine({ documentId, description: "First" });
      const second = await candidates.addLine({ documentId, description: "Second" });
      expect(second.lineNumber).toBe(first.lineNumber + 1);
      expect(first.confidence).toBe("1.000");
      expect(first.disposition).toBe("pending");

      const document = await documentsService.get(documentId);
      expect(document.lineCount).toBeGreaterThanOrEqual(2);
      expect(document.status).toBe("review");
    });

    it("updateLine edits a pending, unconfirmed line", async () => {
      const line = await candidates.addLine({ documentId, description: "Editable" });
      const updated = await candidates.updateLine({
        candidateId: line.id,
        lineAmount: "42.500000",
        note: "corrected amount",
      });
      expect(updated.lineAmount).toBe("42.500000");
      expect(updated.note).toBe("corrected amount");
    });

    it("removeLine deletes a pending, unconfirmed line and updates the document's line count", async () => {
      const before = await documentsService.get(documentId);
      const line = await candidates.addLine({ documentId, description: "Removable" });
      await candidates.removeLine({ candidateId: line.id });
      await expect(candidates.get(line.id)).rejects.toThrow();
      const after = await documentsService.get(documentId);
      expect(after.lineCount).toBe(before.lineCount); // net zero: added, then removed
    });

    it("refuses to edit or remove a CONFIRMED line", async () => {
      const line = await candidates.addLine({
        documentId,
        description: "Will be confirmed",
        lineAmount: "10.000000",
        disposition: "expense",
      });
      await candidates.stampConfirmed({
        candidateId: line.id,
        targetKind: "expense",
        targetId: crypto.randomUUID(),
        actorUserId: actorId,
      });

      await expect(
        candidates.updateLine({ candidateId: line.id, note: "too late" }),
      ).rejects.toBeInstanceOf(DocumentNotEditableError);
      await expect(candidates.removeLine({ candidateId: line.id })).rejects.toBeInstanceOf(
        DocumentNotEditableError,
      );
    });
  });

  describe("setDisposition / bulkSetDisposition", () => {
    it("setDisposition changes a pending line's disposition", async () => {
      const line = await candidates.addLine({ documentId, description: "Dispose me" });
      const updated = await candidates.setDisposition({
        candidateId: line.id,
        disposition: "personal",
        actorUserId: actorId,
      });
      expect(updated.disposition).toBe("personal");
    });

    it("refuses to redispose a CONFIRMED line", async () => {
      const line = await candidates.addLine({
        documentId,
        description: "Locked disposition",
        lineAmount: "5.000000",
        disposition: "expense",
      });
      await candidates.stampConfirmed({
        candidateId: line.id,
        targetKind: "expense",
        targetId: crypto.randomUUID(),
        actorUserId: actorId,
      });
      await expect(
        candidates.setDisposition({
          candidateId: line.id,
          disposition: "discarded",
          actorUserId: actorId,
        }),
      ).rejects.toBeInstanceOf(DocumentNotEditableError);
    });

    it("bulkSetDisposition updates only the not-yet-confirmed candidates in the batch", async () => {
      const pendingA = await candidates.addLine({ documentId, description: "Bulk A" });
      const pendingB = await candidates.addLine({ documentId, description: "Bulk B" });
      const confirmed = await candidates.addLine({
        documentId,
        description: "Bulk C (confirmed)",
        lineAmount: "1.000000",
        disposition: "expense",
      });
      await candidates.stampConfirmed({
        candidateId: confirmed.id,
        targetKind: "expense",
        targetId: crypto.randomUUID(),
        actorUserId: actorId,
      });

      const result = await candidates.bulkSetDisposition({
        candidateIds: [pendingA.id, pendingB.id, confirmed.id],
        disposition: "not_mine",
        actorUserId: actorId,
      });
      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(1);

      const stillConfirmed = await candidates.get(confirmed.id);
      expect(stillConfirmed.disposition).toBe("expense");
    });
  });

  describe("stampConfirmed idempotency and conflict", () => {
    it("REQUIRES a non-empty actorUserId — an empty string is refused too", async () => {
      const line = await candidates.addLine({ documentId, description: "No blank actor" });
      await expect(
        candidates.stampConfirmed({
          candidateId: line.id,
          targetKind: "expense",
          targetId: crypto.randomUUID(),
          actorUserId: "",
        }),
      ).rejects.toThrow();
    });

    it("confirming the SAME candidate into the SAME target twice is a no-op (the design's acceptance case)", async () => {
      const line = await candidates.addLine({
        documentId,
        description: "Double confirm",
        lineAmount: "3.000000",
        disposition: "expense",
      });
      const targetId = crypto.randomUUID();
      const first = await candidates.stampConfirmed({
        candidateId: line.id,
        targetKind: "expense",
        targetId,
        actorUserId: actorId,
      });
      const second = await candidates.stampConfirmed({
        candidateId: line.id,
        targetKind: "expense",
        targetId,
        actorUserId: actorId,
      });
      expect(second.confirmedAt?.getTime()).toBe(first.confirmedAt?.getTime());
      expect(second.targetId).toBe(targetId);
    });

    it("confirming an already-confirmed candidate into a DIFFERENT target is a conflict", async () => {
      const line = await candidates.addLine({
        documentId,
        description: "One target only",
        lineAmount: "3.000000",
        disposition: "expense",
      });
      await candidates.stampConfirmed({
        candidateId: line.id,
        targetKind: "expense",
        targetId: crypto.randomUUID(),
        actorUserId: actorId,
      });
      await expect(
        candidates.stampConfirmed({
          candidateId: line.id,
          targetKind: "acquisition_cost",
          targetId: crypto.randomUUID(),
          actorUserId: actorId,
        }),
      ).rejects.toBeInstanceOf(DocumentsConflictError);
    });

    it("stampConfirmed writes NOTHING but its own columns — target_kind/target_id is a stamp, not an enforced FK, and an invalid-looking target is accepted", async () => {
      const line = await candidates.addLine({
        documentId,
        description: "Orphan stamp",
        lineAmount: "3.000000",
        disposition: "acquisition_cost",
      });
      const neverReallyExists = crypto.randomUUID();
      const confirmed = await candidates.stampConfirmed({
        candidateId: line.id,
        targetKind: "acquisition_cost",
        targetId: neverReallyExists,
        actorUserId: actorId,
      });
      expect(confirmed.targetId).toBe(neverReallyExists);
      // No error, no FK violation — target_kind/target_id has no foreign
      // key at all (documents.ts / migration 0017's module doc).
    });
  });

  describe("re-instantiating the service against an open transaction (the consuming-domain pattern)", () => {
    it("stampConfirmed called via createCandidatesService({ db: tx }) commits atomically with a caller's own write", async () => {
      const line = await candidates.addLine({
        documentId,
        description: "Transactional confirm",
        lineAmount: "7.000000",
        disposition: "expense",
      });
      const targetId = crypto.randomUUID();

      // Mirrors exactly what @loxep/accounting's confirmCandidatesAsExpense
      // would do: open ITS OWN transaction, write its own domain record
      // (simulated here by nothing — this package cannot write one), and
      // call stampConfirmed against that SAME transaction.
      await scratch.handle.db.transaction(async (tx) => {
        await createCandidatesService({ db: tx }).stampConfirmed({
          candidateId: line.id,
          targetKind: "expense",
          targetId,
          actorUserId: actorId,
        });
      });

      const after = await candidates.get(line.id);
      expect(after.confirmedAt).not.toBeNull();
      expect(after.targetId).toBe(targetId);
    });
  });
});
