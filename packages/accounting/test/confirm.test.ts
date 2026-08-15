/**
 * `confirmCandidatesAsExpense` — the ONE confirm function both expense-entry
 * flows share (expense-entry-design.md section 4). Exercises the create
 * path (flow 1, `/finance/import`), the existing-expense path (flow 2,
 * `/finance/expenses/new`), and the three invariants the bead calls out by
 * name: no confirm without an actor, over-transcription refused, and
 * confirming the same candidate twice is a no-op rather than a duplicate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccountingValidationError,
  ExpenseLinesOverTranscribedError,
  createExpenseConfirmService,
  createExpensesService,
} from "../src/index.ts";
import type { ExpenseConfirmService, ExpensesService } from "../src/index.ts";
import {
  createMigratedScratchDb,
  seedCandidate,
  seedDocument,
  seedMedia,
  seedUser,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";
import type { MediaService } from "@loxep/storage";

describe("confirmCandidatesAsExpense", () => {
  let scratch: ScratchDb;
  let expenses: ExpensesService;
  let confirm: ExpenseConfirmService;
  let media: MediaService;
  let actorId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_confirm");
    expenses = createExpensesService({ db: scratch.handle.db });
    media = (await seedMedia(scratch, "c".repeat(64))).media;
    confirm = createExpenseConfirmService({ db: scratch.handle.db, media });
    actorId = await seedUser(scratch, "confirm_actor");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  it("requires a non-null, non-empty actor — a parsed line cannot reach expense_lines without one", async () => {
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      lineAmount: "10.00",
      description: "Tape",
    });
    await expect(
      confirm.confirmCandidatesAsExpense({
        documentId,
        candidateIds: [candidateId],
        // @ts-expect-error — deliberately omitting the required actor
        actorUserId: undefined,
        category: "shipping_supplies",
        paymentMethod: "card",
      }),
    ).rejects.toThrow();
    await expect(
      confirm.confirmCandidatesAsExpense({
        documentId,
        candidateIds: [candidateId],
        actorUserId: "",
        category: "shipping_supplies",
        paymentMethod: "card",
      }),
    ).rejects.toBeInstanceOf(AccountingValidationError);
  });

  it("flow 1: creates ONE expense from N confirmed candidates — 1 candidate row -> 1 expense line", async () => {
    const documentId = await seedDocument(scratch, { currency: "USD", documentDate: "2026-06-01" });
    const shelvingId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 1,
      description: "Shelving unit",
      quantity: "2",
      unitAmount: "89.00",
      lineAmount: "178.00",
    });
    const tapeId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 2,
      description: "Packing tape",
      quantity: "12",
      unitAmount: "3.20",
      lineAmount: "38.40",
    });
    // Not confirmable: no amount at all — the importer's "unreadable row" case.
    const unreadableId = await seedCandidate(scratch, {
      documentId,
      lineNumber: 3,
      description: "Unreadable row",
      lineAmount: null,
    });

    const result = await confirm.confirmCandidatesAsExpense({
      documentId,
      candidateIds: [shelvingId, tapeId, unreadableId],
      actorUserId: actorId,
      category: "shipping_supplies",
      paymentMethod: "card",
    });

    expect(result.skipped).toBe(1);
    expect(result.expense).not.toBeNull();
    expect(result.lines).toHaveLength(2);
    // 178.00 + 38.40 = 216.40, exactly — the created expense's amount is
    // DERIVED from the confirmed candidates, not typed separately.
    expect(result.expense?.amount).toBe("216.400000");
    expect(result.expense?.currency).toBe("USD");
    expect(result.expense?.expenseDate).toBe("2026-06-01");

    const lineDescriptions = result.lines.map((line) => line.description).sort();
    expect(lineDescriptions).toEqual(["Packing tape", "Shelving unit"]);
    for (const line of result.lines) {
      expect(line.documentLineCandidateId).not.toBeNull();
    }

    // The candidates are stamped, and the document's own counters reflect it.
    const candidateRows = await scratch.handle.pool.query(
      `select confirmed_at, target_kind, target_id from document_line_candidates where id = any($1)`,
      [[shelvingId, tapeId]],
    );
    for (const row of candidateRows.rows) {
      expect(row["confirmed_at"]).not.toBeNull();
      expect(row["target_kind"]).toBe("expense");
      expect(row["target_id"]).toBe(result.expense?.id);
    }
    const documentRow = await scratch.handle.pool.query(
      `select status, confirmed_count, line_count from documents where id = $1`,
      [documentId],
    );
    expect(documentRow.rows[0]["confirmed_count"]).toBe(2);
    expect(documentRow.rows[0]["line_count"]).toBe(3);
    // One candidate (the unreadable row) is still pending, so the document
    // is not fully confirmed.
    expect(documentRow.rows[0]["status"]).toBe("partially_confirmed");
  });

  it("attaches the document's receipt image to the created expense (loxep-4mg)", async () => {
    const seeded = await seedMedia(scratch, "d".repeat(64));
    const documentId = await seedDocument(scratch, { mediaObjectId: seeded.mediaObjectId });
    const candidateId = await seedCandidate(scratch, { documentId, lineAmount: "42.00" });

    const result = await confirm.confirmCandidatesAsExpense({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      category: "supplies",
      paymentMethod: "cash",
    });

    const linkRows = await scratch.handle.pool.query(
      `select purpose from media_links where resource_type = 'expense' and resource_id = $1`,
      [result.expense?.id],
    );
    expect(linkRows.rows.map((row) => row["purpose"])).toContain("receipt");
  });

  it("flow 2: attaches candidate-derived lines to an EXISTING (already-created) expense", async () => {
    const { expense } = await expenses.create({
      expenseDate: "2026-06-05",
      category: "supplies",
      currency: "USD",
      amount: "50.00",
      paymentMethod: "card",
      createdByUserId: actorId,
    });
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      description: "Dragged-in line",
      lineAmount: "30.00",
    });

    const result = await confirm.confirmCandidatesAsExpense({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      expenseId: expense.id,
    });

    expect(result.expense?.id).toBe(expense.id);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.expenseId).toBe(expense.id);

    // No second expense was created.
    const expensesForDoc = await scratch.handle.pool.query(
      `select count(*)::int as n from expenses where id = $1`,
      [expense.id],
    );
    expect(expensesForDoc.rows[0]["n"]).toBe(1);
  });

  it("over-transcription refused: confirming candidates whose total would exceed the expense's amount", async () => {
    const { expense } = await expenses.create({
      expenseDate: "2026-06-06",
      category: "supplies",
      currency: "USD",
      amount: "10.00",
      paymentMethod: "card",
      createdByUserId: actorId,
    });
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, { documentId, lineAmount: "25.00" });

    await expect(
      confirm.confirmCandidatesAsExpense({
        documentId,
        candidateIds: [candidateId],
        actorUserId: actorId,
        expenseId: expense.id,
      }),
    ).rejects.toBeInstanceOf(ExpenseLinesOverTranscribedError);
  });

  it("under-transcription is accepted — a draft is legitimately half-transcribed", async () => {
    const { expense } = await expenses.create({
      expenseDate: "2026-06-07",
      category: "supplies",
      currency: "USD",
      amount: "100.00",
      status: "draft",
      paymentMethod: "card",
      createdByUserId: actorId,
    });
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, { documentId, lineAmount: "10.00" });

    const result = await confirm.confirmCandidatesAsExpense({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      expenseId: expense.id,
    });
    expect(result.lines).toHaveLength(1);
  });

  it("idempotency: the same candidate confirmed twice does not error and does not duplicate", async () => {
    const documentId = await seedDocument(scratch);
    const candidateId = await seedCandidate(scratch, {
      documentId,
      description: "Once only",
      lineAmount: "12.00",
    });

    const first = await confirm.confirmCandidatesAsExpense({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      category: "supplies",
      paymentMethod: "card",
    });
    expect(first.lines).toHaveLength(1);
    expect(first.skipped).toBe(0);

    const second = await confirm.confirmCandidatesAsExpense({
      documentId,
      candidateIds: [candidateId],
      actorUserId: actorId,
      category: "supplies",
      paymentMethod: "card",
    });
    // Already confirmed -> skipped, not re-confirmed, and no second expense
    // is created (candidates.length === 0 and no expenseId -> {expense: null}).
    expect(second.skipped).toBe(1);
    expect(second.expense).toBeNull();
    expect(second.lines).toHaveLength(0);

    const lineRows = await scratch.handle.pool.query(
      `select count(*)::int as n from expense_lines where document_line_candidate_id = $1`,
      [candidateId],
    );
    expect(lineRows.rows[0]["n"]).toBe(1);
  });

  it("skips a candidate from a different document, and a candidate with a non-confirmable disposition", async () => {
    const documentId = await seedDocument(scratch);
    const otherDocumentId = await seedDocument(scratch);
    const foreignCandidateId = await seedCandidate(scratch, {
      documentId: otherDocumentId,
      lineAmount: "5.00",
    });
    const personalId = await seedCandidate(scratch, {
      documentId,
      lineAmount: "5.00",
      disposition: "personal",
    });

    const result = await confirm.confirmCandidatesAsExpense({
      documentId,
      candidateIds: [foreignCandidateId, personalId],
      actorUserId: actorId,
      category: "supplies",
      paymentMethod: "card",
    });
    expect(result.skipped).toBe(2);
    expect(result.expense).toBeNull();
  });
});
