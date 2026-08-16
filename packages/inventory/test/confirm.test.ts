/**
 * `confirmCandidatesAsAcquisition` (loxep-cd3.6, M6) — the acquisition-side
 * counterpart to `@loxep/accounting`'s `confirmCandidatesAsExpense`. Exercises
 * the create-new-lot path, the attach-to-existing-lot path, the never-auto-
 * commit rule, and the idempotency cases the bead calls out by name: the same
 * candidate confirmed twice, a partially confirmed document reopened, and a
 * candidate confirmed into an acquisition that was subsequently cancelled.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InventoryConflictError,
  InventoryValidationError,
  createAcquisitionConfirmService,
  createAcquisitionsService,
  createIntakeConfirmService,
} from "../src/index.ts";
import type {
  AcquisitionConfirmService,
  AcquisitionsService,
  IntakeConfirmService,
} from "../src/index.ts";
import {
  createMigratedScratchDb,
  seedCandidate,
  seedDocument,
  seedMediaObject,
  seedUser,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("confirmCandidatesAsAcquisition", () => {
  let scratch: ScratchDb;
  let acquisitions: AcquisitionsService;
  let confirm: AcquisitionConfirmService;
  let actorId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_confirm");
    acquisitions = createAcquisitionsService({ db: scratch.handle.db });
    confirm = createAcquisitionConfirmService({ db: scratch.handle.db });
    actorId = await seedUser(scratch, "acq_confirm_actor");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  it("requires a non-null, non-empty actor — a parsed line cannot reach acquisition_costs without one", async () => {
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      lineAmount: "10.00",
      description: "Vintage lamp",
    });
    await expect(
      confirm.confirmCandidatesAsAcquisition({
        documentId,
        candidateIds: [candidateId],
        // @ts-expect-error — deliberately omitting the required actor
        actorUserId: undefined,
        title: "Estate sale lot",
        sourceKind: "estate_sale",
        currency: "USD",
      }),
    ).rejects.toThrow();
    await expect(
      confirm.confirmCandidatesAsAcquisition({
        documentId,
        candidateIds: [candidateId],
        actorUserId: "",
        title: "Estate sale lot",
        sourceKind: "estate_sale",
        currency: "USD",
      }),
    ).rejects.toBeInstanceOf(InventoryValidationError);
  });

  it("creates a NEW draft acquisition from confirmed candidates — 1 candidate row -> 1 acquisition_costs row", async () => {
    const documentId = await seedDocument(scratch, {
      currency: "USD",
      documentDate: "2026-06-01",
      counterpartyName: "Route 9 Estate Sale",
    });
    const lampId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 1,
      description: "Vintage lamp",
      lineAmount: "45.00",
      disposition: "acquisition_cost",
    });
    const chairId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 2,
      description: "Wing chair",
      lineAmount: "120.00",
      // `acquisition_cost`, not `inventory_intake` — since loxep-ytu the
      // latter is `confirmCandidatesAsIntake`'s alone (see confirm.test.ts's
      // own "confirmCandidatesAsIntake" describe block below).
      disposition: "acquisition_cost",
    });
    // Not confirmable: no amount at all.
    const unreadableId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 3,
      description: "Unreadable row",
      lineAmount: null,
      disposition: "acquisition_cost",
    });

    const result = await confirm.confirmCandidatesAsAcquisition({
      documentId,
      candidateIds: [lampId, chairId, unreadableId],
      actorUserId: actorId,
      title: "Route 9 estate sale",
      sourceKind: "estate_sale",
    });

    expect(result.skipped).toBe(1);
    expect(result.acquisition).not.toBeNull();
    expect(result.costs).toHaveLength(2);
    // Currency/vendor default from the document.
    expect(result.acquisition?.currency).toBe("USD");
    expect(result.acquisition?.vendorName).toBe("Route 9 Estate Sale");
    for (const cost of result.costs) {
      expect(cost.costClass).toBe("goods");
      expect(cost.capitalize).toBe(true);
    }
    const descriptions = result.costs.map((cost) => cost.description).sort();
    expect(descriptions).toEqual(["Vintage lamp", "Wing chair"]);

    // The candidates are stamped, and the document's own counters reflect it.
    const candidateRows = await scratch.handle.pool.query(
      `select confirmed_at, target_kind, target_id from document_line_candidates where id = any($1)`,
      [[lampId, chairId]],
    );
    for (const row of candidateRows.rows) {
      expect(row["confirmed_at"]).not.toBeNull();
      expect(row["target_kind"]).toBe("acquisition");
      expect(row["target_id"]).toBe(result.acquisition?.id);
    }
    const documentRow = await scratch.handle.pool.query(
      `select status, confirmed_count, line_count from documents where id = $1`,
      [documentId],
    );
    expect(documentRow.rows[0]["confirmed_count"]).toBe(2);
    expect(documentRow.rows[0]["line_count"]).toBe(3);
    expect(documentRow.rows[0]["status"]).toBe("partially_confirmed");
  });

  it("attaches the document's evidence file to the acquisition as purpose='invoice'", async () => {
    const mediaObjectId = await seedMediaObject(scratch, "e".repeat(64));
    const documentId = await seedDocument(scratch, { mediaObjectId });
    const candidateId = await seedCandidate(scratch, { documentId, lineAmount: "42.00" });

    const result = await confirm.confirmCandidatesAsAcquisition({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      title: "Evidence lot",
      sourceKind: "thrift_retail",
      currency: "USD",
    });

    const linkRows = await scratch.handle.pool.query(
      `select purpose from media_links where resource_type = 'acquisition' and resource_id = $1`,
      [result.acquisition?.id],
    );
    expect(linkRows.rows.map((row) => row["purpose"])).toContain("invoice");
  });

  it("attaches candidate-derived costs to an EXISTING (already-created) acquisition", async () => {
    const acquisition = await acquisitions.create({
      title: "Open lot",
      sourceKind: "auction_lot",
      currency: "USD",
      createdByUserId: actorId,
    });
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      description: "Attached line",
      lineAmount: "30.00",
    });

    const result = await confirm.confirmCandidatesAsAcquisition({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      acquisitionId: acquisition.id,
    });

    expect(result.acquisition?.id).toBe(acquisition.id);
    expect(result.costs).toHaveLength(1);
    expect(result.costs[0]?.acquisitionId).toBe(acquisition.id);

    // No second acquisition was created.
    const acquisitionsForLot = await scratch.handle.pool.query(
      `select count(*)::int as n from acquisitions where id = $1`,
      [acquisition.id],
    );
    expect(acquisitionsForLot.rows[0]["n"]).toBe(1);
  });

  it("refuses to confirm candidates into a cancelled acquisition", async () => {
    const acquisition = await acquisitions.create({
      title: "Cancelled lot",
      sourceKind: "auction_lot",
      currency: "USD",
      status: "cancelled",
      createdByUserId: actorId,
    });
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, { documentId, lineAmount: "15.00" });

    await expect(
      confirm.confirmCandidatesAsAcquisition({
        documentId,
        candidateIds: [candidateId],
        actorUserId: actorId,
        acquisitionId: acquisition.id,
      }),
    ).rejects.toBeInstanceOf(InventoryConflictError);

    // Nothing was written: the candidate is still unconfirmed.
    const candidateRow = await scratch.handle.pool.query(
      `select confirmed_at from document_line_candidates where id = $1`,
      [candidateId],
    );
    expect(candidateRow.rows[0]["confirmed_at"]).toBeNull();
  });

  it("idempotency: the same candidate confirmed twice does not error and does not duplicate", async () => {
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      description: "Once only",
      lineAmount: "12.00",
    });

    const first = await confirm.confirmCandidatesAsAcquisition({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      title: "Once-only lot",
      sourceKind: "thrift_retail",
      currency: "USD",
    });
    expect(first.costs).toHaveLength(1);
    expect(first.skipped).toBe(0);

    const second = await confirm.confirmCandidatesAsAcquisition({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      title: "Once-only lot",
      sourceKind: "thrift_retail",
      currency: "USD",
    });
    // Already confirmed -> skipped, not re-confirmed, and no second
    // acquisition is created (confirmable.length === 0 and no acquisitionId
    // -> { acquisition: null }).
    expect(second.skipped).toBe(1);
    expect(second.acquisition).toBeNull();
    expect(second.costs).toHaveLength(0);

    const costCount = await scratch.handle.pool.query(
      `select count(*)::int as n from acquisition_costs where acquisition_id = $1`,
      [first.acquisition?.id],
    );
    expect(costCount.rows[0]["n"]).toBe(1);
  });

  it("a partially confirmed document, reopened: only the still-pending candidate confirms", async () => {
    const documentId = await seedDocument(scratch);
    const firstId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 1,
      description: "First pass",
      lineAmount: "20.00",
    });
    const secondId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 2,
      description: "Second pass",
      lineAmount: "5.00",
    });

    const firstConfirm = await confirm.confirmCandidatesAsAcquisition({
      documentId,
      candidateIds: [firstId],
      actorUserId: actorId,
      title: "Reopened lot",
      sourceKind: "thrift_retail",
      currency: "USD",
    });
    expect(firstConfirm.costs).toHaveLength(1);

    let documentRow = await scratch.handle.pool.query(
      `select status from documents where id = $1`,
      [documentId],
    );
    expect(documentRow.rows[0]["status"]).toBe("partially_confirmed");

    // Reopened: attach the still-pending line to the SAME lot.
    const secondConfirm = await confirm.confirmCandidatesAsAcquisition({
      documentId,
      candidateIds: [firstId, secondId],
      actorUserId: actorId,
      acquisitionId: firstConfirm.acquisition?.id,
    });
    expect(secondConfirm.skipped).toBe(1); // firstId, already confirmed
    expect(secondConfirm.costs).toHaveLength(1); // secondId only

    documentRow = await scratch.handle.pool.query(`select status from documents where id = $1`, [
      documentId,
    ]);
    expect(documentRow.rows[0]["status"]).toBe("confirmed");

    const costCount = await scratch.handle.pool.query(
      `select count(*)::int as n from acquisition_costs where acquisition_id = $1`,
      [firstConfirm.acquisition?.id],
    );
    expect(costCount.rows[0]["n"]).toBe(2);
  });

  it("skips a candidate from a different document, and a candidate with a non-confirmable disposition", async () => {
    const documentId = await seedDocument(scratch);
    const otherDocumentId = await seedDocument(scratch);
    const foreignCandidateId = await seedCandidate(scratch, {
      documentId: otherDocumentId,
      lineAmount: "5.00",
    });
    const expenseId = await seedCandidate(scratch, {
      documentId,
      lineAmount: "5.00",
      disposition: "expense",
    });

    const result = await confirm.confirmCandidatesAsAcquisition({
      documentId,
      candidateIds: [foreignCandidateId, expenseId],
      actorUserId: actorId,
      title: "Should not be created",
      sourceKind: "thrift_retail",
      currency: "USD",
    });
    expect(result.skipped).toBe(2);
    expect(result.acquisition).toBeNull();
  });
});

/**
 * `confirmCandidatesAsIntake` (loxep-ytu) — the `inventory_intake`-disposition
 * sibling of `confirmCandidatesAsAcquisition` above: a candidate becomes an
 * ACTUAL `inventory_items` row (physical stock), never an `acquisition_costs`
 * row. Mirrors that suite's own coverage: actor requirement, create-new vs
 * attach-existing, evidence attach, cancelled-lot refusal, idempotent
 * double-confirm, a partially confirmed document reopened, and skip rules —
 * plus the intake-specific assertions: `target_kind = 'inventory_item'`,
 * quantity/label/acquisitionCostAmount mapped straight off the candidate, NO
 * paired `acquisition_costs` row, and a real `receipt` movement (this goes
 * through `ItemsService.create`, never a raw `INSERT`).
 */
describe("confirmCandidatesAsIntake", () => {
  let scratch: ScratchDb;
  let acquisitions: AcquisitionsService;
  let confirm: IntakeConfirmService;
  let actorId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_intake_confirm");
    acquisitions = createAcquisitionsService({ db: scratch.handle.db });
    confirm = createIntakeConfirmService({ db: scratch.handle.db });
    actorId = await seedUser(scratch, "intake_confirm_actor");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  it("requires a non-null, non-empty actor — a parsed line cannot reach inventory_items without one", async () => {
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      lineAmount: "10.00",
      description: "Brass lamp",
      disposition: "inventory_intake",
    });
    await expect(
      confirm.confirmCandidatesAsIntake({
        documentId,
        candidateIds: [candidateId],
        // @ts-expect-error — deliberately omitting the required actor
        actorUserId: undefined,
        title: "Estate sale lot",
        sourceKind: "estate_sale",
        currency: "USD",
      }),
    ).rejects.toThrow();
    await expect(
      confirm.confirmCandidatesAsIntake({
        documentId,
        candidateIds: [candidateId],
        actorUserId: "",
        title: "Estate sale lot",
        sourceKind: "estate_sale",
        currency: "USD",
      }),
    ).rejects.toBeInstanceOf(InventoryValidationError);
  });

  it("creates a NEW draft acquisition and mints one inventory_items row per confirmed candidate", async () => {
    const documentId = await seedDocument(scratch, {
      currency: "USD",
      documentDate: "2026-06-01",
      counterpartyName: "Route 9 Estate Sale",
    });
    const lampId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 1,
      description: "Brass lamp",
      quantity: "1",
      lineAmount: "45.00",
      disposition: "inventory_intake",
    });
    const mugsId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 2,
      description: "Ceramic mugs",
      quantity: "3",
      lineAmount: "12.00",
      disposition: "inventory_intake",
    });
    // Not confirmable: no description at all — inventory_items.label is not null.
    const unreadableId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 3,
      description: null,
      lineAmount: "5.00",
      disposition: "inventory_intake",
    });
    // Not confirmable: this suite's own disposition, but the WRONG one.
    const costLineId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 4,
      description: "Sales tax",
      lineAmount: "3.20",
      disposition: "acquisition_cost",
    });

    const result = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [lampId, mugsId, unreadableId, costLineId],
      actorUserId: actorId,
      title: "Route 9 estate sale",
      sourceKind: "estate_sale",
    });

    expect(result.skipped).toBe(2);
    expect(result.acquisition).not.toBeNull();
    expect(result.items).toHaveLength(2);
    expect(result.acquisition?.currency).toBe("USD");
    expect(result.acquisition?.vendorName).toBe("Route 9 Estate Sale");

    const byLabel = new Map(result.items.map((item) => [item.label, item]));
    const lamp = byLabel.get("Brass lamp");
    const mugs = byLabel.get("Ceramic mugs");
    expect(lamp?.quantity).toBe("1.000000");
    expect(lamp?.acquisitionCostAmount).toBe("45.000000");
    expect(mugs?.quantity).toBe("3.000000");
    expect(mugs?.acquisitionCostAmount).toBe("12.000000");
    for (const item of result.items) {
      expect(item.acquisitionId).toBe(result.acquisition?.id);
      expect(item.status).toBe("intake");
      // The receipt movement was recorded — quantity_on_hand tracks quantity.
      expect(item.quantityOnHand).toBe(item.quantity);
    }

    // NO acquisition_costs row was written — the item's own price is seeded
    // directly, not paired with a cost row (see confirm.ts's top doc on why
    // that would double-count the next time allocateCosts runs).
    const costCount = await scratch.handle.pool.query(
      `select count(*)::int as n from acquisition_costs where acquisition_id = $1`,
      [result.acquisition?.id],
    );
    expect(costCount.rows[0]["n"]).toBe(0);

    // The candidates are stamped target_kind = 'inventory_item', pointing at
    // the SPECIFIC item each one became — not at the acquisition.
    const candidateRows = await scratch.handle.pool.query(
      `select id, confirmed_at, target_kind, target_id from document_line_candidates where id = any($1)`,
      [[lampId, mugsId]],
    );
    for (const row of candidateRows.rows) {
      expect(row["confirmed_at"]).not.toBeNull();
      expect(row["target_kind"]).toBe("inventory_item");
      const item = row["id"] === lampId ? lamp : mugs;
      expect(row["target_id"]).toBe(item?.id);
    }

    const documentRow = await scratch.handle.pool.query(
      `select status, confirmed_count, line_count from documents where id = $1`,
      [documentId],
    );
    expect(documentRow.rows[0]["confirmed_count"]).toBe(2);
    expect(documentRow.rows[0]["line_count"]).toBe(4);
    expect(documentRow.rows[0]["status"]).toBe("partially_confirmed");
  });

  it("defaults quantity to 1 when the candidate's quantity is absent or non-positive", async () => {
    const documentId = await seedDocument(scratch);
    const noQuantityId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 1,
      description: "No quantity given",
      quantity: null,
      lineAmount: "9.00",
      disposition: "inventory_intake",
    });
    const zeroQuantityId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 2,
      description: "Zero quantity given",
      quantity: "0",
      lineAmount: "9.00",
      disposition: "inventory_intake",
    });

    const result = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [noQuantityId, zeroQuantityId],
      actorUserId: actorId,
      title: "Quantity defaults lot",
      sourceKind: "thrift_retail",
      currency: "USD",
    });

    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.quantity).toBe("1.000000");
    }
  });

  it("applies the batch conditionCode/locationId to every item minted", async () => {
    const documentId = await seedDocument(scratch);
    const firstId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 1,
      description: "Item one",
      lineAmount: "10.00",
      disposition: "inventory_intake",
    });
    const secondId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 2,
      description: "Item two",
      lineAmount: "20.00",
      disposition: "inventory_intake",
    });

    const result = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [firstId, secondId],
      actorUserId: actorId,
      title: "Condition lot",
      sourceKind: "thrift_retail",
      currency: "USD",
      conditionCode: "very_good",
    });

    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.conditionCode).toBe("very_good");
    }
  });

  it("attaches the document's evidence file to the acquisition as purpose='invoice'", async () => {
    const mediaObjectId = await seedMediaObject(scratch, "f".repeat(64));
    const documentId = await seedDocument(scratch, { mediaObjectId });
    const candidateId = await seedCandidate(scratch, {
      documentId,
      description: "Evidenced item",
      lineAmount: "42.00",
      disposition: "inventory_intake",
    });

    const result = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      title: "Evidence lot",
      sourceKind: "thrift_retail",
      currency: "USD",
    });

    const linkRows = await scratch.handle.pool.query(
      `select purpose from media_links where resource_type = 'acquisition' and resource_id = $1`,
      [result.acquisition?.id],
    );
    expect(linkRows.rows.map((row) => row["purpose"])).toContain("invoice");
  });

  it("mints an item onto an EXISTING (already-created) acquisition", async () => {
    const acquisition = await acquisitions.create({
      title: "Open lot",
      sourceKind: "auction_lot",
      currency: "USD",
      createdByUserId: actorId,
    });
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      description: "Attached item",
      lineAmount: "30.00",
      disposition: "inventory_intake",
    });

    const result = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      acquisitionId: acquisition.id,
    });

    expect(result.acquisition?.id).toBe(acquisition.id);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.acquisitionId).toBe(acquisition.id);

    const itemsForLot = await scratch.handle.pool.query(
      `select count(*)::int as n from inventory_items where acquisition_id = $1`,
      [acquisition.id],
    );
    expect(itemsForLot.rows[0]["n"]).toBe(1);
  });

  it("refuses to confirm candidates into a cancelled acquisition", async () => {
    const acquisition = await acquisitions.create({
      title: "Cancelled lot",
      sourceKind: "auction_lot",
      currency: "USD",
      status: "cancelled",
      createdByUserId: actorId,
    });
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      lineAmount: "15.00",
      disposition: "inventory_intake",
    });

    await expect(
      confirm.confirmCandidatesAsIntake({
        documentId,
        candidateIds: [candidateId],
        actorUserId: actorId,
        acquisitionId: acquisition.id,
      }),
    ).rejects.toBeInstanceOf(InventoryConflictError);

    const candidateRow = await scratch.handle.pool.query(
      `select confirmed_at from document_line_candidates where id = $1`,
      [candidateId],
    );
    expect(candidateRow.rows[0]["confirmed_at"]).toBeNull();
  });

  it("idempotency: the same candidate confirmed twice does not error and does not duplicate", async () => {
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      description: "Once only",
      lineAmount: "12.00",
      disposition: "inventory_intake",
    });

    const first = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      title: "Once-only lot",
      sourceKind: "thrift_retail",
      currency: "USD",
    });
    expect(first.items).toHaveLength(1);
    expect(first.skipped).toBe(0);

    const second = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      title: "Once-only lot",
      sourceKind: "thrift_retail",
      currency: "USD",
    });
    expect(second.skipped).toBe(1);
    expect(second.acquisition).toBeNull();
    expect(second.items).toHaveLength(0);

    const itemCount = await scratch.handle.pool.query(
      `select count(*)::int as n from inventory_items where acquisition_id = $1`,
      [first.acquisition?.id],
    );
    expect(itemCount.rows[0]["n"]).toBe(1);
  });

  it("a partially confirmed document, reopened: only the still-pending candidate confirms", async () => {
    const documentId = await seedDocument(scratch);
    const firstId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 1,
      description: "First pass",
      lineAmount: "20.00",
      disposition: "inventory_intake",
    });
    const secondId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 2,
      description: "Second pass",
      lineAmount: "5.00",
      disposition: "inventory_intake",
    });

    const firstConfirm = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [firstId],
      actorUserId: actorId,
      title: "Reopened lot",
      sourceKind: "thrift_retail",
      currency: "USD",
    });
    expect(firstConfirm.items).toHaveLength(1);

    let documentRow = await scratch.handle.pool.query(
      `select status from documents where id = $1`,
      [documentId],
    );
    expect(documentRow.rows[0]["status"]).toBe("partially_confirmed");

    const secondConfirm = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [firstId, secondId],
      actorUserId: actorId,
      acquisitionId: firstConfirm.acquisition?.id,
    });
    expect(secondConfirm.skipped).toBe(1); // firstId, already confirmed
    expect(secondConfirm.items).toHaveLength(1); // secondId only

    documentRow = await scratch.handle.pool.query(`select status from documents where id = $1`, [
      documentId,
    ]);
    expect(documentRow.rows[0]["status"]).toBe("confirmed");

    const itemCount = await scratch.handle.pool.query(
      `select count(*)::int as n from inventory_items where acquisition_id = $1`,
      [firstConfirm.acquisition?.id],
    );
    expect(itemCount.rows[0]["n"]).toBe(2);
  });

  it("skips a candidate from a different document, and a candidate with a non-confirmable disposition", async () => {
    const documentId = await seedDocument(scratch);
    const otherDocumentId = await seedDocument(scratch);
    const foreignCandidateId = await seedCandidate(scratch, {
      documentId: otherDocumentId,
      lineAmount: "5.00",
      disposition: "inventory_intake",
    });
    const expenseId = await seedCandidate(scratch, {
      documentId,
      lineAmount: "5.00",
      disposition: "expense",
    });

    const result = await confirm.confirmCandidatesAsIntake({
      documentId,
      candidateIds: [foreignCandidateId, expenseId],
      actorUserId: actorId,
      title: "Should not be created",
      sourceKind: "thrift_retail",
      currency: "USD",
    });
    expect(result.skipped).toBe(2);
    expect(result.acquisition).toBeNull();
  });
});
