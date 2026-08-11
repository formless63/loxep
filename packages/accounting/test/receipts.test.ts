/**
 * Receipt attachment, through the REAL `media_links` constraints from migration
 * 0004.
 *
 * The point of these tests is that Phase 5 adds no receipts table: it adds two
 * strings (`resource_type = 'expense'`, `purpose = 'receipt'`) to a link table
 * the foundation already owns. So what has to be proven is not that a row can
 * be written but that the shared table's natural key behaves the way the
 * accounting path depends on — including the retry case that migration 0004 was
 * written to fix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaObjectNotFoundError } from "@loxep/storage";
import type { MediaService } from "@loxep/storage";
import {
  AccountingNotFoundError,
  createExpensesService,
  createReceiptsService,
} from "../src/index.ts";
import type { ExpensesService, ReceiptsService } from "../src/index.ts";
import {
  auditEventsFor,
  createMigratedScratchDb,
  seedMedia,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("expense receipts", () => {
  let scratch: ScratchDb;
  let expenses: ExpensesService;
  let receipts: ReceiptsService;
  let media: MediaService;
  let mediaObjectId: string;
  let secondMediaObjectId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_receipts");
    expenses = createExpensesService({ db: scratch.handle.db });
    const seeded = await seedMedia(scratch, "a".repeat(64));
    media = seeded.media;
    mediaObjectId = seeded.mediaObjectId;
    secondMediaObjectId = (await seedMedia(scratch, "b".repeat(64)))
      .mediaObjectId;
    receipts = createReceiptsService({ db: scratch.handle.db, media });
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  const base = {
    expenseDate: "2026-04-02",
    category: "shipping_supplies",
    currency: "USD",
    amount: "48.20",
    paymentMethod: "card",
  } as const;

  it("attaches, lists, and detaches — the full roundtrip", async () => {
    const { expense } = await expenses.create(base);
    const attached = await receipts.attach({
      expenseId: expense.id,
      mediaObjectId,
    });
    expect(attached.created).toBe(true);
    expect(attached.link).toMatchObject({
      mediaObjectId,
      resourceType: "expense",
      resourceId: expense.id,
      purpose: "receipt",
    });

    const listed = await receipts.list(expense.id);
    expect(listed.map((link) => link.mediaObjectId)).toEqual([mediaObjectId]);

    await receipts.detach({ expenseId: expense.id, mediaObjectId });
    expect(await receipts.list(expense.id)).toEqual([]);
  });

  it("writes the row into the real media_links table, not a shadow copy", async () => {
    const { expense } = await expenses.create(base);
    await receipts.attach({ expenseId: expense.id, mediaObjectId });
    const rows = await scratch.handle.pool.query(
      `select media_object_id::text as media_object_id, resource_type,
              resource_id, purpose
         from media_links where resource_id = $1`,
      [expense.id],
    );
    expect(rows.rows).toEqual([
      {
        media_object_id: mediaObjectId,
        resource_type: "expense",
        resource_id: expense.id,
        purpose: "receipt",
      },
    ]);
  });

  it("is idempotent: a retried attach returns the existing link", async () => {
    // This is the case migration 0004 exists for. Jobs are at-least-once, and
    // before the natural key a retry silently doubled the row.
    const { expense } = await expenses.create(base);
    const first = await receipts.attach({
      expenseId: expense.id,
      mediaObjectId,
    });
    const second = await receipts.attach({
      expenseId: expense.id,
      mediaObjectId,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.link.mediaObjectId).toBe(mediaObjectId);
    expect((await receipts.list(expense.id)).length).toBe(1);
  });

  it("treats purpose as part of the fact: one object can be receipt AND invoice", async () => {
    const { expense } = await expenses.create(base);
    await receipts.attach({ expenseId: expense.id, mediaObjectId });
    const asInvoice = await receipts.attach({
      expenseId: expense.id,
      mediaObjectId,
      purpose: "invoice",
    });
    expect(asInvoice.created).toBe(true);
    expect((await receipts.list(expense.id)).length).toBe(2);
    expect(
      (await receipts.list(expense.id, "invoice")).map(
        (link) => link.purpose,
      ),
    ).toEqual(["invoice"]);
  });

  it("holds several receipts on one expense and one receipt on several expenses", async () => {
    const first = await expenses.create(base);
    const second = await expenses.create(base);
    await receipts.attach({
      expenseId: first.expense.id,
      mediaObjectId,
      sortOrder: 1,
    });
    await receipts.attach({
      expenseId: first.expense.id,
      mediaObjectId: secondMediaObjectId,
      sortOrder: 2,
    });
    await receipts.attach({
      expenseId: second.expense.id,
      mediaObjectId,
    });
    expect((await receipts.list(first.expense.id)).length).toBe(2);
    expect((await receipts.list(second.expense.id)).length).toBe(1);
  });

  it("refuses to attach to an unknown expense", async () => {
    await expect(
      receipts.attach({
        expenseId: "00000000-0000-4000-8000-000000000000",
        mediaObjectId,
      }),
    ).rejects.toThrow(AccountingNotFoundError);
  });

  it("refuses to attach a media object that was never uploaded", async () => {
    const { expense } = await expenses.create(base);
    await expect(
      receipts.attach({
        expenseId: expense.id,
        mediaObjectId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(MediaObjectNotFoundError);
  });

  it("survives the expense being voided — evidence outlives the assertion", async () => {
    const { expense } = await expenses.create(base);
    await receipts.attach({ expenseId: expense.id, mediaObjectId });
    await expenses.submit({ expenseId: expense.id });
    await expenses.voidExpense({
      expenseId: expense.id,
      reason: "wrong card",
    });
    expect((await receipts.list(expense.id)).length).toBe(1);
  });

  it("reports recorded expenses with no receipt at all", async () => {
    const withReceipt = await expenses.create({
      ...base,
      expenseDate: "2026-05-01",
    });
    const without = await expenses.create({
      ...base,
      expenseDate: "2026-05-02",
    });
    const stillDraft = await expenses.create({
      ...base,
      expenseDate: "2026-05-03",
    });
    await receipts.attach({
      expenseId: withReceipt.expense.id,
      mediaObjectId,
    });
    await expenses.submit({ expenseId: withReceipt.expense.id });
    await expenses.submit({ expenseId: without.expense.id });

    const missing = await receipts.missingReceipts({
      from: "2026-05-01",
      to: "2026-05-31",
    });
    const ids = missing.map((row) => row.expenseId);
    expect(ids).toContain(without.expense.id);
    expect(ids).not.toContain(withReceipt.expense.id);
    // Drafts are not a receipt backlog — they are not yet asserted facts.
    expect(ids).not.toContain(stillDraft.expense.id);
  });

  it("audits attach and detach, and does not audit a no-op retry", async () => {
    const { expense } = await expenses.create(base);
    await receipts.attach({
      expenseId: expense.id,
      mediaObjectId,
      actorUserId: null,
    });
    await receipts.attach({ expenseId: expense.id, mediaObjectId });
    const attachEvents = (
      await auditEventsFor(scratch, "accounting.expense.receipt_attached")
    ).filter((event) => event.resourceId === expense.id);
    expect(attachEvents.length).toBe(1);

    await receipts.detach({ expenseId: expense.id, mediaObjectId });
    const detachEvents = (
      await auditEventsFor(scratch, "accounting.expense.receipt_detached")
    ).filter((event) => event.resourceId === expense.id);
    expect(detachEvents.length).toBe(1);
  });
});
