/**
 * The expense read models: by entity, by period, unallocated, and the posting
 * backlog.
 *
 * The load-bearing assertion in this file is the one about currency: a grouped
 * total must never merge two currencies into one number. Phase 5's design puts
 * conversion in the journal at posting time with the rate frozen on the line
 * and commits operational tables to exactly one currency forever, so a read
 * model that summed across currencies would be inventing the rate the whole
 * design refuses to invent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createExpenseReports,
  createExpensesService,
} from "../src/index.ts";
import type { ExpenseReports, ExpensesService } from "../src/index.ts";
import { createMigratedScratchDb, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("expense reports", () => {
  let scratch: ScratchDb;
  let expenses: ExpensesService;
  let reports: ExpenseReports;
  let llcId: string;
  let personalId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_reports");
    expenses = createExpensesService({ db: scratch.handle.db });
    reports = createExpenseReports({ db: scratch.handle.db });
    llcId = await seedEntity(scratch, "Loxep LLC");
    personalId = await seedEntity(scratch, "Personal", "individual");

    // A small, hand-checkable fixture. Every amount is exact.
    const fixture = [
      { date: "2026-01-10", entity: llcId, cat: "supplies", amt: "100.00", cur: "USD" },
      { date: "2026-01-20", entity: llcId, cat: "postage", amt: "40.00", cur: "USD" },
      { date: "2026-02-05", entity: llcId, cat: "supplies", amt: "60.00", cur: "USD" },
      { date: "2026-02-06", entity: personalId, cat: "supplies", amt: "25.00", cur: "USD" },
      { date: "2026-02-07", entity: null, cat: "software_subscription", amt: "12.00", cur: "EUR" },
    ] as const;

    for (const row of fixture) {
      const created = await expenses.create({
        expenseDate: row.date,
        category: row.cat,
        currency: row.cur,
        amount: row.amt,
        taxAmount: "1.00",
        paymentMethod: "card",
        payeeName: "Uline",
        ...(row.entity === null ? {} : { economicEntityId: row.entity }),
      });
      await expenses.submit({ expenseId: created.expense.id });
    }
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  describe("listExpenses", () => {
    it("filters by entity", async () => {
      const rows = await reports.listExpenses({ economicEntityId: llcId });
      expect(rows.length).toBe(3);
      expect(new Set(rows.map((row) => row.economicEntityId))).toEqual(
        new Set([llcId]),
      );
    });

    it("filters by an explicit null entity — the unattributed backlog", async () => {
      const rows = await reports.listExpenses({ economicEntityId: null });
      expect(rows.length).toBe(1);
      expect(rows[0]?.currency).toBe("EUR");
      expect(rows[0]?.entityAttributionSource).toBe("unattributed");
    });

    it("filters by inclusive period bounds", async () => {
      const january = await reports.listExpenses({
        from: "2026-01-01",
        to: "2026-01-31",
      });
      expect(january.length).toBe(2);
      const onTheBoundary = await reports.listExpenses({
        from: "2026-01-20",
        to: "2026-01-20",
      });
      expect(onTheBoundary.length).toBe(1);
    });

    it("filters by category and status", async () => {
      expect(
        (await reports.listExpenses({ category: "supplies" })).length,
      ).toBe(3);
      expect(
        (await reports.listExpenses({ statuses: ["draft"] })).length,
      ).toBe(0);
      expect(
        (await reports.listExpenses({ statuses: ["recorded"] })).length,
      ).toBe(5);
    });

    it("carries the allocation and receipt roll-up per row", async () => {
      const created = await expenses.create({
        expenseDate: "2026-03-09",
        category: "supplies",
        currency: "USD",
        amount: "80.00",
        paymentMethod: "cash",
      });
      await expenses.setAllocations({
        expenseId: created.expense.id,
        allocations: [{ amount: "30.00", economicEntityId: llcId }],
      });
      const rows = await reports.listExpenses({
        from: "2026-03-09",
        to: "2026-03-09",
      });
      expect(rows[0]).toMatchObject({
        allocatedAmount: "30.000000",
        unallocatedAmount: "50.000000",
        allocationCount: 1,
        receiptCount: 0,
      });
    });
  });

  describe("expenseTotals", () => {
    it("groups by month, keeping currency in the key", async () => {
      const rows = await reports.expenseTotals("month", {
        statuses: ["recorded"],
      });
      const january = rows.find(
        (row) => row.groupKey === "2026-01" && row.currency === "USD",
      );
      expect(january).toMatchObject({
        totalAmount: "140.000000",
        totalTaxAmount: "2.000000",
        expenseCount: 2,
      });
    });

    it("NEVER sums across currencies — February is two rows, not one", async () => {
      const rows = (
        await reports.expenseTotals("month", { statuses: ["recorded"] })
      ).filter((row) => row.groupKey === "2026-02");
      expect(rows.length).toBe(2);
      expect(
        rows.map((row) => [row.currency, row.totalAmount]).sort(),
      ).toEqual([
        ["EUR", "12.000000"],
        ["USD", "85.000000"],
      ]);
    });

    it("groups by entity, naming the unattributed bucket rather than dropping it", async () => {
      const rows = await reports.expenseTotals("entity", {
        statuses: ["recorded"],
      });
      expect(rows.map((row) => row.groupKey)).toContain("unattributed");
      const llc = rows.find((row) => row.groupKey === llcId);
      expect(llc?.totalAmount).toBe("200.000000");
    });

    it("groups by category and by payee", async () => {
      const byCategory = await reports.expenseTotals("category", {
        statuses: ["recorded"],
        currency: "USD",
      });
      const supplies = byCategory.find((row) => row.groupKey === "supplies");
      expect(supplies).toMatchObject({
        totalAmount: "185.000000",
        expenseCount: 3,
      });

      const byPayee = await reports.expenseTotals("payee", {
        statuses: ["recorded"],
      });
      expect(byPayee.map((row) => row.groupKey)).toContain("Uline");
    });
  });

  describe("unallocatedExpenses", () => {
    it("includes both never-split and partly-split expenses, distinguishably", async () => {
      const never = await expenses.create({
        expenseDate: "2026-07-01",
        category: "supplies",
        currency: "USD",
        amount: "50.00",
        paymentMethod: "card",
      });
      const partly = await expenses.create({
        expenseDate: "2026-07-02",
        category: "supplies",
        currency: "USD",
        amount: "50.00",
        paymentMethod: "card",
      });
      const fully = await expenses.create({
        expenseDate: "2026-07-03",
        category: "supplies",
        currency: "USD",
        amount: "50.00",
        paymentMethod: "card",
      });
      await expenses.setAllocations({
        expenseId: partly.expense.id,
        allocations: [{ amount: "20.00", economicEntityId: llcId }],
      });
      await expenses.setAllocations({
        expenseId: fully.expense.id,
        allocations: [{ amount: "50.00", economicEntityId: llcId }],
      });

      const rows = await reports.unallocatedExpenses({
        from: "2026-07-01",
        to: "2026-07-31",
      });
      const byId = new Map(rows.map((row) => [row.expenseId, row]));
      expect(byId.get(never.expense.id)).toMatchObject({
        allocationCount: 0,
        allocatedAmount: "0.000000",
        unallocatedAmount: "50.000000",
      });
      expect(byId.get(partly.expense.id)).toMatchObject({
        allocationCount: 1,
        unallocatedAmount: "30.000000",
      });
      expect(byId.has(fully.expense.id)).toBe(false);
    });

    it("excludes void expenses by default — a retraction is not a backlog item", async () => {
      const created = await expenses.create({
        expenseDate: "2026-08-01",
        category: "supplies",
        currency: "USD",
        amount: "9.00",
        paymentMethod: "cash",
      });
      await expenses.voidExpense({
        expenseId: created.expense.id,
        reason: "entered twice",
      });
      const rows = await reports.unallocatedExpenses({
        from: "2026-08-01",
        to: "2026-08-31",
      });
      expect(rows.map((row) => row.expenseId)).not.toContain(
        created.expense.id,
      );
    });
  });

  describe("postingBacklog", () => {
    it("names recorded expenses with their source-fact identity", async () => {
      const rows = await reports.postingBacklog({
        from: "2026-01-01",
        to: "2026-02-28",
      });
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect(row.sourceFactType).toBe("expense");
        expect(row.sourceFactId).toBe(row.expenseId);
      }
    });

    it("excludes drafts and voids", async () => {
      const draft = await expenses.create({
        expenseDate: "2026-09-01",
        category: "supplies",
        currency: "USD",
        amount: "3.00",
        paymentMethod: "cash",
      });
      const voided = await expenses.create({
        expenseDate: "2026-09-02",
        category: "supplies",
        currency: "USD",
        amount: "4.00",
        paymentMethod: "cash",
      });
      await expenses.submit({ expenseId: voided.expense.id });
      await expenses.voidExpense({
        expenseId: voided.expense.id,
        reason: "not ours",
      });
      const rows = await reports.postingBacklog({
        from: "2026-09-01",
        to: "2026-09-30",
      });
      expect(rows.length).toBe(0);
      expect(rows.map((row) => row.expenseId)).not.toContain(draft.expense.id);
    });
  });
});
