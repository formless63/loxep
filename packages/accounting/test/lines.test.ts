/**
 * `expense_lines` — the draft-only lock, the over-transcription guard
 * (`sum(|line_amount|) <= |expenses.amount|`), and the audit trail. Mirrors
 * `expenses.test.ts`'s allocation-invariant tests, applied here to lines
 * instead of splits.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccountingNotFoundError,
  ExpenseLinesOverTranscribedError,
  ExpenseNotEditableError,
  createExpenseLinesService,
  createExpensesService,
} from "../src/index.ts";
import type { ExpenseLinesService, ExpensesService } from "../src/index.ts";
import { auditEventsFor, createMigratedScratchDb, seedUser } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("expense lines service", () => {
  let scratch: ScratchDb;
  let expenses: ExpensesService;
  let lines: ExpenseLinesService;
  let actorId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_lines");
    expenses = createExpensesService({ db: scratch.handle.db });
    lines = createExpenseLinesService({ db: scratch.handle.db });
    actorId = await seedUser(scratch, "lines_actor");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  const base = {
    expenseDate: "2026-05-01",
    category: "shipping_supplies",
    currency: "USD",
    amount: "100.00",
    paymentMethod: "card",
  } as const;

  it("a headline-only expense (no lines) stays valid", async () => {
    const { expense } = await expenses.create(base);
    const summary = await lines.lineSummary(expense.id);
    expect(summary.lineCount).toBe(0);
    expect(summary.absoluteLineTotal).toBe("0.000000");
    expect(summary.fitsWithinExpense).toBe(true);
  });

  it("adds lines to a draft expense, assigning sequential line numbers", async () => {
    const { expense } = await expenses.create({ ...base, status: "draft" });
    const first = await lines.addLine({
      expenseId: expense.id,
      description: "Shelving unit",
      quantity: "2",
      unitAmount: "40.00",
      lineAmount: "80.00",
      actorUserId: actorId,
    });
    const second = await lines.addLine({
      expenseId: expense.id,
      description: "Packing tape",
      lineAmount: "5.00",
      lineKind: "shipping",
      actorUserId: actorId,
    });
    expect(first.lineNumber).toBe(1);
    expect(second.lineNumber).toBe(2);
    expect(second.lineKind).toBe("shipping");

    const listed = await lines.listLines(expense.id);
    expect(listed.map((line) => line.id)).toEqual([first.id, second.id]);

    const events = await auditEventsFor(scratch, "accounting.expense.line_added");
    expect(events.some((event) => event.resourceId === expense.id)).toBe(true);
  });

  it("refuses adding, removing, or setting lines on a recorded (non-draft) expense", async () => {
    const { expense } = await expenses.create({ ...base, status: "recorded" });
    await expect(
      lines.addLine({ expenseId: expense.id, lineAmount: "10.00", actorUserId: actorId }),
    ).rejects.toBeInstanceOf(ExpenseNotEditableError);
    await expect(
      lines.setLines({ expenseId: expense.id, lines: [], actorUserId: actorId }),
    ).rejects.toBeInstanceOf(ExpenseNotEditableError);
  });

  it("under-transcription is allowed — a draft is legitimately half-transcribed", async () => {
    const { expense } = await expenses.create({ ...base, amount: "100.00", status: "draft" });
    const line = await lines.addLine({
      expenseId: expense.id,
      description: "Partial line",
      lineAmount: "10.00",
      actorUserId: actorId,
    });
    expect(line.lineAmount).toBe("10.000000");
    const summary = await lines.lineSummary(expense.id);
    expect(summary.fitsWithinExpense).toBe(true);
  });

  it("refuses a line that would push the absolute total past the expense amount", async () => {
    const { expense } = await expenses.create({ ...base, amount: "20.00", status: "draft" });
    await lines.addLine({ expenseId: expense.id, lineAmount: "15.00", actorUserId: actorId });
    await expect(
      lines.addLine({ expenseId: expense.id, lineAmount: "10.00", actorUserId: actorId }),
    ).rejects.toBeInstanceOf(ExpenseLinesOverTranscribedError);
  });

  it("sums ABSOLUTE values, not the signed total — a coupon still counts against the limit", async () => {
    const { expense } = await expenses.create({ ...base, amount: "10.00", status: "draft" });
    await lines.addLine({
      expenseId: expense.id,
      description: "Item",
      lineAmount: "10.00",
      actorUserId: actorId,
    });
    // Net total is now 10 - 3 = 7, well under the expense's 10.00 — but the
    // ABSOLUTE sum (10 + 3 = 13) exceeds it, so this must be refused.
    await expect(
      lines.addLine({
        expenseId: expense.id,
        description: "Coupon",
        lineAmount: "-3.00",
        lineKind: "discount",
        actorUserId: actorId,
      }),
    ).rejects.toBeInstanceOf(ExpenseLinesOverTranscribedError);
  });

  it("setLines replaces the whole set atomically", async () => {
    const { expense } = await expenses.create({ ...base, amount: "50.00", status: "draft" });
    await lines.addLine({ expenseId: expense.id, lineAmount: "5.00", actorUserId: actorId });
    const replaced = await lines.setLines({
      expenseId: expense.id,
      lines: [
        { description: "New item", lineAmount: "30.00" },
        { description: "Shipping", lineAmount: "10.00", lineKind: "shipping" },
      ],
      actorUserId: actorId,
    });
    expect(replaced).toHaveLength(2);
    const listed = await lines.listLines(expense.id);
    expect(listed).toHaveLength(2);
    expect(listed.map((line) => line.description)).toEqual(["New item", "Shipping"]);
  });

  it("removeLine deletes a draft line and is audited", async () => {
    const { expense } = await expenses.create({ ...base, amount: "50.00", status: "draft" });
    const line = await lines.addLine({
      expenseId: expense.id,
      lineAmount: "20.00",
      actorUserId: actorId,
    });
    await lines.removeLine({ lineId: line.id, actorUserId: actorId });
    const listed = await lines.listLines(expense.id);
    expect(listed).toHaveLength(0);
    const events = await auditEventsFor(scratch, "accounting.expense.line_removed");
    expect(events.some((event) => event.resourceId === expense.id)).toBe(true);
  });

  it("addLine on an unknown expense throws AccountingNotFoundError", async () => {
    await expect(
      lines.addLine({
        expenseId: "00000000-0000-0000-0000-000000000000",
        lineAmount: "1.00",
        actorUserId: actorId,
      }),
    ).rejects.toBeInstanceOf(AccountingNotFoundError);
  });
});
