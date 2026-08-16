/**
 * The expenses service: lifecycle, the allocation invariant, currency
 * discipline, attribution, and the audit trail.
 *
 * The design's instruction for the allocation rule is that it is *"a service
 * rule and a reconciliation report, not a constraint"*, which means the
 * database will happily accept arithmetic this service must refuse — so these
 * are the tests that carry the invariant, and `schema.test.ts` asserts the
 * absence of the constraint they stand in for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccountingNotFoundError,
  ExpenseNotEditableError,
  ExpenseOverAllocatedError,
  AccountingValidationError,
  allocationsFit,
  createExpensesService,
  expenseSourceFact,
  isPostable,
  resolveExpenseAttribution,
} from "../src/index.ts";
import type { ExpensesService } from "../src/index.ts";
import {
  auditEventsFor,
  createMigratedScratchDb,
  seedAcquisition,
  seedCounterparty,
  seedEntity,
  seedUser,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("expenses service", () => {
  let scratch: ScratchDb;
  let expenses: ExpensesService;
  let entityId: string;
  let otherEntityId: string;
  let acquisitionId: string;
  let acquisitionCostId: string;
  let actorId: string;
  let payeeCounterpartyId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_expenses");
    expenses = createExpensesService({ db: scratch.handle.db });
    entityId = await seedEntity(scratch, "Loxep LLC");
    otherEntityId = await seedEntity(scratch, "Side Hustle", "sole_proprietorship");
    ({ acquisitionId, acquisitionCostId } = await seedAcquisition(
      scratch,
      "ACQ-2026-8001",
    ));
    actorId = await seedUser(scratch, "acct_actor");
    payeeCounterpartyId = await seedCounterparty(
      scratch,
      "Fixture Supply Co",
      "CP-2026-8001",
    );
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  const base = {
    expenseDate: "2026-03-15",
    category: "supplies",
    currency: "USD",
    amount: "100.00",
    paymentMethod: "card",
  } as const;

  describe("creation and reference codes", () => {
    it("generates EXP-<year>-NNNN per year and increments", async () => {
      const first = await expenses.create({ ...base, amount: "10.00" });
      const second = await expenses.create({ ...base, amount: "20.00" });
      expect(first.expense.referenceCode).toMatch(/^EXP-2026-\d{4}$/);
      const firstSeq = Number(first.expense.referenceCode.slice(-4));
      const secondSeq = Number(second.expense.referenceCode.slice(-4));
      expect(secondSeq).toBe(firstSeq + 1);
    });

    it("derives the code year from the EXPENSE date, not from today", async () => {
      const created = await expenses.create({
        ...base,
        expenseDate: "2025-12-31",
        amount: "5.00",
      });
      expect(created.expense.referenceCode).toMatch(/^EXP-2025-\d{4}$/);
    });

    it("stores currency uppercase so `usd` and `USD` are one currency", async () => {
      const created = await expenses.create({ ...base, currency: "eur" });
      expect(created.expense.currency).toBe("EUR");
    });

    it("normalizes amounts to numeric(20,6) scale", async () => {
      const created = await expenses.create({ ...base, amount: "19.9" });
      expect(created.expense.amount).toBe("19.900000");
      expect(created.expense.taxAmount).toBe("0.000000");
    });

    it("starts in draft unless told otherwise", async () => {
      const created = await expenses.create(base);
      expect(created.expense.status).toBe("draft");
      const recorded = await expenses.create({ ...base, status: "recorded" });
      expect(recorded.expense.status).toBe("recorded");
    });

    it("cannot be created directly as posted — the posting engine owns that", async () => {
      await expect(
        // @ts-expect-error `posted` is deliberately outside the create union
        expenses.create({ ...base, status: "posted" }),
      ).rejects.toThrow(AccountingValidationError);
    });
  });

  describe("entity attribution", () => {
    it("records `manual` for an explicit entity", async () => {
      const created = await expenses.create({
        ...base,
        economicEntityId: entityId,
        createdByUserId: actorId,
      });
      expect(created.expense.economicEntityId).toBe(entityId);
      expect(created.expense.entityAttributionSource).toBe("manual");
      expect(created.expense.entityAttributedByUserId).toBe(actorId);
    });

    it("records `installation_default` when only a default is supplied", async () => {
      const created = await expenses.create({
        ...base,
        installationDefaultEntityId: entityId,
      });
      expect(created.expense.economicEntityId).toBe(entityId);
      expect(created.expense.entityAttributionSource).toBe(
        "installation_default",
      );
      // Not a human choice, so no attributing user is stamped.
      expect(created.expense.entityAttributedByUserId).toBeNull();
    });

    it("treats an explicit null as a decision, not as an omission", () => {
      expect(
        resolveExpenseAttribution({
          explicitEntityId: null,
          installationDefaultEntityId: entityId,
        }),
      ).toEqual({
        economicEntityId: null,
        entityAttributionSource: "unattributed",
      });
      expect(
        resolveExpenseAttribution({ installationDefaultEntityId: entityId }),
      ).toEqual({
        economicEntityId: entityId,
        entityAttributionSource: "installation_default",
      });
    });

    it("bulk re-attribution never rewrites a `manual` row", async () => {
      const manual = await expenses.create({
        ...base,
        expenseDate: "2026-06-01",
        economicEntityId: entityId,
      });
      const defaulted = await expenses.create({
        ...base,
        expenseDate: "2026-06-02",
        installationDefaultEntityId: entityId,
      });
      const unattributed = await expenses.create({
        ...base,
        expenseDate: "2026-06-03",
      });

      const result = await expenses.reattributeDefaults({
        economicEntityId: otherEntityId,
        from: "2026-06-01",
        to: "2026-06-30",
        actorUserId: actorId,
      });
      expect(result.updated).toBe(2);

      expect((await expenses.get(manual.expense.id)).economicEntityId).toBe(
        entityId,
      );
      expect((await expenses.get(defaulted.expense.id)).economicEntityId).toBe(
        otherEntityId,
      );
      expect(
        (await expenses.get(unattributed.expense.id)).economicEntityId,
      ).toBe(otherEntityId);

      const events = await auditEventsFor(
        scratch,
        "accounting.expense.reattributed",
      );
      expect(events[0]?.metadata).toMatchObject({
        updated: 2,
        neverRewrites: "manual",
      });
    });
  });

  describe("the allocation invariant", () => {
    it("computes the interval rule for positive and negative expenses", () => {
      expect(allocationsFit("100.00", "0")).toBe(true);
      expect(allocationsFit("100.00", "100.000000")).toBe(true);
      expect(allocationsFit("100.00", "100.000001")).toBe(false);
      expect(allocationsFit("100.00", "-0.000001")).toBe(false);
      // A vendor credit allocates the other way.
      expect(allocationsFit("-40.00", "-40.000000")).toBe(true);
      expect(allocationsFit("-40.00", "-40.000001")).toBe(false);
      expect(allocationsFit("-40.00", "0.000001")).toBe(false);
    });

    it("allows under-allocation — a draft is legitimately partly split", async () => {
      const { expense } = await expenses.create(base);
      await expenses.setAllocations({
        expenseId: expense.id,
        allocations: [{ amount: "60.00", economicEntityId: entityId }],
      });
      const summary = await expenses.allocationSummary(expense.id);
      expect(summary.allocatedAmount).toBe("60.000000");
      expect(summary.unallocatedAmount).toBe("40.000000");
      expect(summary.fullyAllocated).toBe(false);
    });

    it("refuses over-allocation by exactly one micro-unit", async () => {
      const { expense } = await expenses.create(base);
      await expect(
        expenses.setAllocations({
          expenseId: expense.id,
          allocations: [
            { amount: "100.000001", economicEntityId: entityId },
          ],
        }),
      ).rejects.toThrow(ExpenseOverAllocatedError);
    });

    it("refuses an incremental add that would tip the total over", async () => {
      const { expense } = await expenses.create(base);
      await expenses.addAllocation({
        expenseId: expense.id,
        allocation: { amount: "70.00", economicEntityId: entityId },
      });
      await expect(
        expenses.addAllocation({
          expenseId: expense.id,
          allocation: { amount: "30.01", economicEntityId: otherEntityId },
        }),
      ).rejects.toThrow(ExpenseOverAllocatedError);
      // The refused add left nothing behind.
      expect((await expenses.listAllocations(expense.id)).length).toBe(1);
    });

    it("permits mixed-sign lines while the running total stays inside", async () => {
      const { expense } = await expenses.create(base);
      const rows = await expenses.setAllocations({
        expenseId: expense.id,
        allocations: [
          { amount: "120.00", economicEntityId: entityId },
          { amount: "-20.00", economicEntityId: entityId, note: "rebate" },
        ],
      });
      expect(rows.length).toBe(2);
      const summary = await expenses.allocationSummary(expense.id);
      expect(summary.allocatedAmount).toBe("100.000000");
      expect(summary.fullyAllocated).toBe(true);
    });

    it("refuses a mixed-sign set whose total flips past zero", async () => {
      const { expense } = await expenses.create(base);
      await expect(
        expenses.setAllocations({
          expenseId: expense.id,
          allocations: [
            { amount: "20.00", economicEntityId: entityId },
            { amount: "-30.00", economicEntityId: entityId },
          ],
        }),
      ).rejects.toThrow(ExpenseOverAllocatedError);
    });

    it("guards the OTHER side: an amount cannot be edited below what is allocated", async () => {
      const { expense } = await expenses.create(base);
      await expenses.setAllocations({
        expenseId: expense.id,
        allocations: [{ amount: "100.00", economicEntityId: entityId }],
      });
      await expect(
        expenses.update({ expenseId: expense.id, amount: "60.00" }),
      ).rejects.toThrow(ExpenseOverAllocatedError);
      // Raising it is fine — that just under-allocates.
      const raised = await expenses.update({
        expenseId: expense.id,
        amount: "140.00",
      });
      expect(raised.amount).toBe("140.000000");
    });

    it("assigns line numbers in order and enforces exact sums with no float drift", async () => {
      const { expense } = await expenses.create({ ...base, amount: "0.30" });
      const rows = await expenses.setAllocations({
        expenseId: expense.id,
        allocations: [
          { amount: "0.10", economicEntityId: entityId },
          { amount: "0.20", economicEntityId: otherEntityId },
        ],
      });
      expect(rows.map((row) => row.lineNumber)).toEqual([1, 2]);
      const summary = await expenses.allocationSummary(expense.id);
      expect(summary.allocatedAmount).toBe("0.300000");
      expect(summary.fullyAllocated).toBe(true);
    });

    it("allocates against a real acquisition foreign key", async () => {
      const { expense } = await expenses.create(base);
      const row = await expenses.addAllocation({
        expenseId: expense.id,
        allocation: { amount: "25.00", acquisitionId, channel: "ebay" },
      });
      expect(row.acquisitionId).toBe(acquisitionId);
      expect(row.channel).toBe("ebay");
    });

    it("refuses an allocation naming no target, before the database does", async () => {
      // `schema.test.ts` proves the CHECK fires; this proves the service turns
      // a constraint name into a reason rather than leaking a query error.
      const { expense } = await expenses.create(base);
      await expect(
        expenses.addAllocation({
          expenseId: expense.id,
          allocation: { amount: "5.00" },
        }),
      ).rejects.toThrow(AccountingValidationError);
      await expect(
        expenses.addAllocation({
          expenseId: expense.id,
          allocation: { amount: "5.00" },
        }),
      ).rejects.toThrow(/must name at least one target/);
    });
  });

  describe("currency discipline", () => {
    it("refuses a currency change while allocations exist", async () => {
      const { expense } = await expenses.create(base);
      await expenses.setAllocations({
        expenseId: expense.id,
        allocations: [{ amount: "10.00", economicEntityId: entityId }],
      });
      await expect(
        expenses.update({ expenseId: expense.id, currency: "EUR" }),
      ).rejects.toThrow(/would silently redenominate/);
    });

    it("permits a currency change once the allocations are cleared", async () => {
      const { expense } = await expenses.create(base);
      await expenses.setAllocations({
        expenseId: expense.id,
        allocations: [{ amount: "10.00", economicEntityId: entityId }],
      });
      await expenses.setAllocations({
        expenseId: expense.id,
        allocations: [],
      });
      const updated = await expenses.update({
        expenseId: expense.id,
        currency: "gbp",
      });
      expect(updated.currency).toBe("GBP");
    });

    it("permits re-asserting the same currency even with allocations", async () => {
      const { expense } = await expenses.create(base);
      await expenses.setAllocations({
        expenseId: expense.id,
        allocations: [{ amount: "10.00", economicEntityId: entityId }],
      });
      const updated = await expenses.update({
        expenseId: expense.id,
        currency: "usd",
      });
      expect(updated.currency).toBe("USD");
    });

    it("rejects a non-ISO currency shape at the boundary", async () => {
      await expect(
        expenses.create({ ...base, currency: "DOLLARS" }),
      ).rejects.toThrow(AccountingValidationError);
    });
  });

  describe("lifecycle: draft is the only mutable state", () => {
    it("submits a draft to recorded and records the allocation state", async () => {
      const { expense } = await expenses.create(base);
      await expenses.setAllocations({
        expenseId: expense.id,
        allocations: [{ amount: "40.00", economicEntityId: entityId }],
      });
      const submitted = await expenses.submit({
        expenseId: expense.id,
        actorUserId: actorId,
      });
      expect(submitted.status).toBe("recorded");

      const events = await auditEventsFor(
        scratch,
        "accounting.expense.submitted",
      );
      const event = events.find((row) => row.resourceId === expense.id);
      expect(event?.metadata).toMatchObject({
        allocationCount: 1,
        allocatedAmount: "40.000000",
        unallocatedAmount: "60.000000",
      });
    });

    it("refuses to edit a recorded expense", async () => {
      const { expense } = await expenses.create(base);
      await expenses.submit({ expenseId: expense.id });
      await expect(
        expenses.update({ expenseId: expense.id, category: "postage" }),
      ).rejects.toThrow(ExpenseNotEditableError);
    });

    it("refuses to change the allocations of a recorded expense", async () => {
      const { expense } = await expenses.create(base);
      await expenses.submit({ expenseId: expense.id });
      await expect(
        expenses.setAllocations({
          expenseId: expense.id,
          allocations: [{ amount: "1.00", economicEntityId: entityId }],
        }),
      ).rejects.toThrow(ExpenseNotEditableError);
      await expect(
        expenses.addAllocation({
          expenseId: expense.id,
          allocation: { amount: "1.00", economicEntityId: entityId },
        }),
      ).rejects.toThrow(ExpenseNotEditableError);
    });

    it("refuses to remove an allocation from a recorded expense", async () => {
      const { expense } = await expenses.create(base);
      const row = await expenses.addAllocation({
        expenseId: expense.id,
        allocation: { amount: "1.00", economicEntityId: entityId },
      });
      await expenses.submit({ expenseId: expense.id });
      await expect(
        expenses.removeAllocation({ allocationId: row.id }),
      ).rejects.toThrow(ExpenseNotEditableError);
    });

    it("refuses a second submit", async () => {
      const { expense } = await expenses.create(base);
      await expenses.submit({ expenseId: expense.id });
      await expect(
        expenses.submit({ expenseId: expense.id }),
      ).rejects.toThrow(ExpenseNotEditableError);
    });

    it("voids with a reason, keeps the row, and is idempotent", async () => {
      const { expense } = await expenses.create(base);
      await expenses.submit({ expenseId: expense.id });
      const voided = await expenses.voidExpense({
        expenseId: expense.id,
        reason: "duplicate of the card statement line",
        actorUserId: actorId,
      });
      expect(voided.status).toBe("void");
      // Row retained, not deleted.
      expect((await expenses.get(expense.id)).id).toBe(expense.id);
      const again = await expenses.voidExpense({
        expenseId: expense.id,
        reason: "retry",
      });
      expect(again.status).toBe("void");
    });

    it("refuses a void with no reason", async () => {
      const { expense } = await expenses.create(base);
      await expect(
        expenses.voidExpense({ expenseId: expense.id, reason: "   " }),
      ).rejects.toThrow(AccountingValidationError);
    });
  });

  describe("promoteToAcquisitionCost (void-and-promote, loxep-ytu)", () => {
    it("voids the expense and stamps acquisition_cost_id in the same write", async () => {
      const { expense } = await expenses.create(base);
      await expenses.submit({ expenseId: expense.id });
      const promoted = await expenses.promoteToAcquisitionCost({
        expenseId: expense.id,
        acquisitionCostId,
        reason: "this was actually goods for resale, not a plain expense",
        actorUserId: actorId,
      });
      expect(promoted.status).toBe("void");
      expect(promoted.acquisitionCostId).toBe(acquisitionCostId);
      // Row retained, not deleted, and the reload agrees with the return value.
      const reloaded = await expenses.get(expense.id);
      expect(reloaded.status).toBe("void");
      expect(reloaded.acquisitionCostId).toBe(acquisitionCostId);

      const events = await auditEventsFor(
        scratch,
        "accounting.expense.promoted_to_acquisition_cost",
      );
      const event = events.find((row) => row.resourceId === expense.id);
      expect(event?.metadata).toMatchObject({
        referenceCode: expense.referenceCode,
        acquisitionCostId,
      });
    });

    it("refuses with no reason, and leaves the expense untouched", async () => {
      const { expense } = await expenses.create(base);
      await expenses.submit({ expenseId: expense.id });
      await expect(
        expenses.promoteToAcquisitionCost({
          expenseId: expense.id,
          acquisitionCostId,
          reason: "   ",
        }),
      ).rejects.toThrow(AccountingValidationError);
      expect((await expenses.get(expense.id)).status).toBe("recorded");
    });

    it("refuses to promote an already-void expense — promotion is not a follow-up edit", async () => {
      const { expense } = await expenses.create(base);
      await expenses.submit({ expenseId: expense.id });
      await expenses.voidExpense({
        expenseId: expense.id,
        reason: "recorded in error",
        actorUserId: actorId,
      });
      await expect(
        expenses.promoteToAcquisitionCost({
          expenseId: expense.id,
          acquisitionCostId,
          reason: "actually this was for resale",
          actorUserId: actorId,
        }),
      ).rejects.toThrow(ExpenseNotEditableError);
    });

    it("promotes a draft expense too — recorded is not a precondition, only posted and void are refused", async () => {
      const { expense } = await expenses.create(base);
      const promoted = await expenses.promoteToAcquisitionCost({
        expenseId: expense.id,
        acquisitionCostId,
        reason: "caught this before submitting — it was a lot purchase",
        actorUserId: actorId,
      });
      expect(promoted.status).toBe("void");
      expect(promoted.acquisitionCostId).toBe(acquisitionCostId);
    });
  });

  describe("the payee link (trading partners M1, loxep-cd3.1)", () => {
    it("free text alone stays valid — the quick-entry fast path never requires a counterparty", async () => {
      const { expense } = await expenses.create({ ...base, payeeName: "USPS" });
      expect(expense.payeeName).toBe("USPS");
      expect(expense.payeeCounterpartyId).toBeNull();
    });

    it("on create, snapshots the counterparty's display_name into payee_name, overriding any explicit payeeName", async () => {
      const { expense } = await expenses.create({
        ...base,
        payeeName: "typed before picking",
        payeeCounterpartyId,
      });
      expect(expense.payeeCounterpartyId).toBe(payeeCounterpartyId);
      expect(expense.payeeName).toBe("Fixture Supply Co");
    });

    it("create rejects an unknown payeeCounterpartyId", async () => {
      await expect(
        expenses.create({
          ...base,
          payeeCounterpartyId: "00000000-0000-4000-8000-000000000000",
        }),
      ).rejects.toThrow(AccountingNotFoundError);
    });

    it("update resolves and snapshots the same way, and is draft-gated like every other field", async () => {
      const { expense } = await expenses.create(base);
      const updated = await expenses.update({
        expenseId: expense.id,
        payeeCounterpartyId,
      });
      expect(updated.payeeCounterpartyId).toBe(payeeCounterpartyId);
      expect(updated.payeeName).toBe("Fixture Supply Co");

      await expenses.submit({ expenseId: expense.id });
      await expect(
        expenses.update({ expenseId: expense.id, payeeCounterpartyId: null }),
      ).rejects.toThrow(ExpenseNotEditableError);
    });

    it("linkPayee works on a RECORDED expense — the one field the draft lock does not gate", async () => {
      const { expense } = await expenses.create({ ...base, payeeName: "USPS" });
      await expenses.submit({ expenseId: expense.id });

      const linked = await expenses.linkPayee({
        expenseId: expense.id,
        payeeCounterpartyId,
        actorUserId: actorId,
      });
      expect(linked.status).toBe("recorded");
      expect(linked.payeeCounterpartyId).toBe(payeeCounterpartyId);
      expect(linked.payeeName).toBe("Fixture Supply Co");

      const events = await auditEventsFor(
        scratch,
        "accounting.expense.payee_linked",
      );
      const event = events.find((row) => row.resourceId === expense.id);
      expect(event?.after).toMatchObject({
        payeeCounterpartyId,
        payeeName: "Fixture Supply Co",
      });
    });

    it("linkPayee with null unlinks WITHOUT touching the last-known payee_name", async () => {
      const { expense } = await expenses.create({
        ...base,
        payeeCounterpartyId,
      });
      const unlinked = await expenses.linkPayee({
        expenseId: expense.id,
        payeeCounterpartyId: null,
      });
      expect(unlinked.payeeCounterpartyId).toBeNull();
      expect(unlinked.payeeName).toBe("Fixture Supply Co");
    });

    it("linkPayee refuses a void expense — frozen evidence, correct by void-and-re-record instead", async () => {
      const { expense } = await expenses.create(base);
      await expenses.submit({ expenseId: expense.id });
      await expenses.voidExpense({
        expenseId: expense.id,
        reason: "wrong payee typed",
      });
      await expect(
        expenses.linkPayee({ expenseId: expense.id, payeeCounterpartyId }),
      ).rejects.toThrow(ExpenseNotEditableError);
    });

    it("linkPayee rejects an unknown payeeCounterpartyId", async () => {
      const { expense } = await expenses.create(base);
      await expect(
        expenses.linkPayee({
          expenseId: expense.id,
          payeeCounterpartyId: "00000000-0000-4000-8000-000000000000",
        }),
      ).rejects.toThrow(AccountingNotFoundError);
    });
  });

  describe("the posting seam", () => {
    it("names a stable source-fact identity with no ledger row", () => {
      expect(expenseSourceFact("abc")).toEqual({
        sourceFactType: "expense",
        sourceFactId: "abc",
      });
    });

    it("treats only `recorded` as postable", () => {
      expect(isPostable("draft")).toBe(false);
      expect(isPostable("recorded")).toBe(true);
      expect(isPostable("void")).toBe(false);
      expect(isPostable("posted")).toBe(false);
    });
  });

  describe("the audit trail", () => {
    it("writes a redacted audit row for every mutation", async () => {
      const { expense } = await expenses.create({
        ...base,
        createdByUserId: actorId,
        payeeName: "Uline",
      });
      await expenses.update({
        expenseId: expense.id,
        category: "shipping_supplies",
        actorUserId: actorId,
      });
      const row = await expenses.addAllocation({
        expenseId: expense.id,
        allocation: { amount: "5.00", economicEntityId: entityId },
        actorUserId: actorId,
      });
      await expenses.removeAllocation({
        allocationId: row.id,
        actorUserId: actorId,
      });

      for (const action of [
        "accounting.expense.created",
        "accounting.expense.updated",
        "accounting.expense.allocation_added",
        "accounting.expense.allocation_removed",
      ]) {
        const events = await auditEventsFor(scratch, action);
        expect(
          events.some((event) => event.resourceId === expense.id),
        ).toBe(true);
      }

      const updates = await auditEventsFor(scratch, "accounting.expense.updated");
      const update = updates.find((event) => event.resourceId === expense.id);
      expect(update?.before).toMatchObject({ category: "supplies" });
      expect(update?.after).toMatchObject({ category: "shipping_supplies" });
    });
  });
});
