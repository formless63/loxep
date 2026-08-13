/**
 * COGS posting: the `acquisition_cost` and `inventory_movement` readers.
 *
 * The milestone's claim is arithmetic, so the tests are arithmetic: a dollar
 * spent on goods enters the ledger exactly ONCE as an asset, leaves exactly
 * ONCE as cost of goods at the basis frozen on the item, and the two are the
 * same number to the micro-unit — including when a lot's basis has to be split
 * across a partial depletion, which is the case where "approximately equal"
 * would quietly leave inventory holding a residue forever.
 *
 * Real PostgreSQL, per the suite's standing rule: `numeric(20,6)` rounding and
 * the movement table's sign `CHECK` have no meaning anywhere else.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBooksService,
  createExpensesService,
  createLedgerReports,
  createPostingEngine,
  createStatements,
  validatePostingRuleTemplate,
} from "../src/index.ts";
import { AccountingValidationError } from "../src/errors.ts";
import {
  createMigratedScratchDb,
  seedConnection,
  seedEntity,
  seedLotWithItem,
  seedMovement,
  seedOrder,
  seedOrderLine,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("COGS posting", () => {
  let scratch: ScratchDb;
  let books: ReturnType<typeof createBooksService>;
  let engine: ReturnType<typeof createPostingEngine>;
  let reports: ReturnType<typeof createLedgerReports>;
  let statements: ReturnType<typeof createStatements>;
  let expenses: ReturnType<typeof createExpensesService>;
  let connectionId = "";
  let counter = 0;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_cogs");
    books = createBooksService({ db: scratch.handle.db });
    engine = createPostingEngine({ db: scratch.handle.db });
    reports = createLedgerReports({ db: scratch.handle.db });
    statements = createStatements({ db: scratch.handle.db });
    expenses = createExpensesService({ db: scratch.handle.db });
    connectionId = await seedConnection(scratch);
    await engine.seedDefaultRules();
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function newBook() {
    counter += 1;
    const entityId = await seedEntity(scratch, `Goods LLC ${counter}`);
    const { book } = await books.createBook({
      code: `COGS-${counter}`,
      name: `COGS ${counter}`,
      openedOn: "2025-01-01",
    });
    await books.linkEntity({
      accountingBookId: book.id,
      economicEntityId: entityId,
      linkRole: "posting_primary",
      effectiveFrom: "2025-01-01",
    });
    return { book, entityId };
  }

  async function balance(bookId: string, systemKey: string): Promise<string> {
    const account = await reports.accountBalance({
      accountingBookId: bookId,
      systemKey,
    });
    return account.balance;
  }

  /* ------------------------------------------------- the rule model accepts */

  describe("rule validation", () => {
    it("accepts a template naming the two new fact types", () => {
      expect(() =>
        validatePostingRuleTemplate(
          "inventory_movement",
          [
            { accountSystemKey: "cogs", amountSource: "quantity_times_basis", amountMultiplier: "1", inheritEntity: true },
            { accountSystemKey: "inventory", amountSource: "cost_basis", amountMultiplier: "-1", inheritEntity: true },
          ],
          ["movementKind"],
        ),
      ).not.toThrow();
      expect(() =>
        validatePostingRuleTemplate(
          "acquisition_cost",
          [
            { accountSystemKey: "inventory", amountSource: "total", amountMultiplier: "1", inheritEntity: true },
            { accountSystemKey: "opening_balance_equity", amountSource: "total", amountMultiplier: "-1", inheritEntity: true },
          ],
          ["capitalize"],
        ),
      ).not.toThrow();
    });

    it("still refuses a predicate the new fact types cannot carry", () => {
      expect(() =>
        validatePostingRuleTemplate(
          "inventory_movement",
          [
            { accountSystemKey: "cogs", amountSource: "cost_basis", amountMultiplier: "1", inheritEntity: true },
            { accountSystemKey: "inventory", amountSource: "cost_basis", amountMultiplier: "-1", inheritEntity: true },
          ],
          ["feeType"],
        ),
      ).toThrow(AccountingValidationError);
    });

    it("refuses an amount source an acquisition cost does not carry", () => {
      expect(() =>
        validatePostingRuleTemplate("acquisition_cost", [
          { accountSystemKey: "inventory", amountSource: "cost_basis", amountMultiplier: "1", inheritEntity: true },
          { accountSystemKey: "opening_balance_equity", amountSource: "total", amountMultiplier: "-1", inheritEntity: true },
        ]),
      ).toThrow(/carries no "cost_basis" amount/);
    });
  });

  /* ------------------------------------------------------ the buy side */

  describe("acquisition_cost", () => {
    it("capitalizes goods onto the balance sheet, never the P&L", async () => {
      const { book, entityId } = await newBook();
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-BUY-${counter}`,
        itemCode: `IT-BUY-${counter}`,
        goodsAmount: "250.000000",
        economicEntityId: entityId,
        acquiredAt: "2025-04-02T12:00:00Z",
      });

      const outcome = await engine.evaluateFact({
        sourceFactType: "acquisition_cost",
        sourceFactId: lot.goodsCostId,
      });
      expect(outcome.status).toBe("posted");
      expect(outcome.rule?.code).toBe("acquisition_cost_capitalized");

      expect(await balance(book.id, "inventory")).toBe("250.000000");
      expect(await balance(book.id, "opening_balance_equity")).toBe(
        "-250.000000",
      );

      const income = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-01-01",
        to: "2025-12-31",
      });
      // The whole point: buying goods is not an expense.
      expect(income.expense.total).toBe("0.000000");
      expect(income.netIncome).toBe("0.000000");

      const sheet = await statements.balanceSheet({
        accountingBookId: book.id,
        asOf: "2025-12-31",
      });
      expect(sheet.assets.total).toBe("250.000000");
      expect(sheet.difference).toBe("0.000000");
    });

    it("posts a non-capitalized cost where it sits, and never into inventory", async () => {
      const { book, entityId } = await newBook();
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-NC-${counter}`,
        itemCode: `IT-NC-${counter}`,
        goodsAmount: "80.000000",
        nonCapitalizedAmount: "12.500000",
        economicEntityId: entityId,
        acquiredAt: "2025-04-02T12:00:00Z",
      });

      const outcome = await engine.evaluateFact({
        sourceFactType: "acquisition_cost",
        sourceFactId: lot.nonCapitalizedCostId ?? "",
      });
      expect(outcome.status).toBe("posted");
      expect(outcome.rule?.code).toBe("acquisition_cost_expensed");
      // Not copied into `expenses` — posted from where it already is.
      expect(await balance(book.id, "suspense")).toBe("12.500000");
      expect(await balance(book.id, "inventory")).toBe("0.000000");
    });

    it("refuses to capitalize a foreign-currency cost into inventory", async () => {
      const { entityId } = await newBook();
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-FX-${counter}`,
        itemCode: `IT-FX-${counter}`,
        goodsAmount: "90.000000",
        costCurrency: "GBP",
        economicEntityId: entityId,
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "acquisition_cost",
        sourceFactId: lot.goodsCostId,
      });
      expect(outcome.status).toBe("unpostable");
      expect(outcome.reason).toBe("fact_ineligible");
      expect(outcome.explanation).toMatch(/excludes a foreign-currency/);
    });
  });

  /* ----------------------------------------------------- the sell side */

  describe("inventory_movement", () => {
    it("posts COGS at EXACTLY the frozen basis, and relieves inventory to zero", async () => {
      const { book, entityId } = await newBook();
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-SELL-${counter}`,
        itemCode: `IT-SELL-${counter}`,
        goodsAmount: "137.420000",
        economicEntityId: entityId,
        acquiredAt: "2025-05-01T12:00:00Z",
      });
      await engine.evaluateFact({
        sourceFactType: "acquisition_cost",
        sourceFactId: lot.goodsCostId,
      });

      const movementId = await seedMovement(scratch, {
        inventoryItemId: lot.inventoryItemId,
        movementKind: "depletion_sale",
        quantity: "-1",
        occurredAt: "2025-06-10T12:00:00Z",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "inventory_movement",
        sourceFactId: movementId,
      });
      expect(outcome.status).toBe("posted");
      expect(outcome.rule?.code).toBe("cogs_on_depletion");

      expect(await balance(book.id, "cogs")).toBe("137.420000");
      // The asset the purchase created is relieved exactly, not approximately.
      expect(await balance(book.id, "inventory")).toBe("0.000000");

      // Re-running every fact changes nothing: the fingerprints match.
      const again = await engine.evaluateFacts([
        { sourceFactType: "acquisition_cost", sourceFactId: lot.goodsCostId },
        { sourceFactType: "inventory_movement", sourceFactId: movementId },
      ]);
      expect(again.map((entry) => entry.status)).toEqual([
        "unchanged",
        "unchanged",
      ]);
      expect(await balance(book.id, "cogs")).toBe("137.420000");
    });

    it("apportions a partial depletion pro rata, and the last one takes the residue", async () => {
      const { book, entityId } = await newBook();
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-PART-${counter}`,
        itemCode: `IT-PART-${counter}`,
        goodsAmount: "100.000000",
        quantity: "3",
        economicEntityId: entityId,
        acquiredAt: "2025-05-01T12:00:00Z",
      });
      await engine.evaluateFact({
        sourceFactType: "acquisition_cost",
        sourceFactId: lot.goodsCostId,
      });
      expect(await balance(book.id, "inventory")).toBe("100.000000");

      // 100 ÷ 3 has no exact micro-unit representation, which is the point:
      // the middle share takes the rounded-up unit and the running total is
      // exact after every one of them.
      const steps: { occurredAt: string; runningCogs: string }[] = [
        { occurredAt: "2025-06-10T12:00:00Z", runningCogs: "33.333333" },
        { occurredAt: "2025-06-11T12:00:00Z", runningCogs: "66.666667" },
        { occurredAt: "2025-06-12T12:00:00Z", runningCogs: "100.000000" },
      ];
      for (const step of steps) {
        const movementId = await seedMovement(scratch, {
          inventoryItemId: lot.inventoryItemId,
          movementKind: "depletion_sale",
          quantity: "-1",
          occurredAt: step.occurredAt,
        });
        const outcome = await engine.evaluateFact({
          sourceFactType: "inventory_movement",
          sourceFactId: movementId,
        });
        expect(outcome.status).toBe("posted");
        expect(await balance(book.id, "cogs")).toBe(step.runningCogs);
      }

      // Every micro-unit of the basis reached COGS, and none of it stayed.
      expect(await balance(book.id, "cogs")).toBe("100.000000");
      expect(await balance(book.id, "inventory")).toBe("0.000000");
    });

    it("does not post an intake movement: the acquisition cost already did", async () => {
      const { book, entityId } = await newBook();
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-IN-${counter}`,
        itemCode: `IT-IN-${counter}`,
        goodsAmount: "60.000000",
        economicEntityId: entityId,
      });
      await engine.evaluateFact({
        sourceFactType: "acquisition_cost",
        sourceFactId: lot.goodsCostId,
      });
      const receiptId = await seedMovement(scratch, {
        inventoryItemId: lot.inventoryItemId,
        movementKind: "receipt",
        quantity: "1",
        occurredAt: "2025-06-01T12:00:00Z",
      });

      const outcome = await engine.evaluateFact({
        sourceFactType: "inventory_movement",
        sourceFactId: receiptId,
      });
      expect(outcome.status).toBe("unpostable");
      expect(outcome.reason).toBe("fact_ineligible");
      expect(outcome.explanation).toMatch(/count the same purchase twice/);
      // THE assertion: one purchase, one debit.
      expect(await balance(book.id, "inventory")).toBe("60.000000");
    });

    it("does not post a transfer, an adjustment, or a disposal", async () => {
      const { book, entityId } = await newBook();
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-SKIP-${counter}`,
        itemCode: `IT-SKIP-${counter}`,
        goodsAmount: "40.000000",
        quantity: "4",
        economicEntityId: entityId,
      });
      const kinds: { kind: string; reason: RegExp; transferGroupId?: string }[] = [
        {
          kind: "transfer_out",
          reason: /changes no value/,
          transferGroupId: randomUUID(),
        },
        { kind: "adjustment_out", reason: /valuation judgement/ },
        { kind: "disposal", reason: /valuation judgement/ },
      ];
      for (const { kind, reason, transferGroupId } of kinds) {
        const movementId = await seedMovement(scratch, {
          inventoryItemId: lot.inventoryItemId,
          movementKind: kind,
          quantity: "-1",
          occurredAt: "2025-06-05T12:00:00Z",
          deduplicationKey: `test:${kind}:${lot.inventoryItemId}`,
          ...(transferGroupId === undefined ? {} : { transferGroupId }),
        });
        const outcome = await engine.evaluateFact({
          sourceFactType: "inventory_movement",
          sourceFactId: movementId,
        });
        expect(outcome.status).toBe("unpostable");
        expect(outcome.explanation).toMatch(reason);
      }
      expect(await balance(book.id, "cogs")).toBe("0.000000");
    });

    it("reverses COGS when the depletion is reversed", async () => {
      const { book, entityId } = await newBook();
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-REV-${counter}`,
        itemCode: `IT-REV-${counter}`,
        goodsAmount: "75.000000",
        economicEntityId: entityId,
      });
      await engine.evaluateFact({
        sourceFactType: "acquisition_cost",
        sourceFactId: lot.goodsCostId,
      });
      const depletionId = await seedMovement(scratch, {
        inventoryItemId: lot.inventoryItemId,
        movementKind: "depletion_sale",
        quantity: "-1",
        occurredAt: "2025-06-10T12:00:00Z",
      });
      await engine.evaluateFact({
        sourceFactType: "inventory_movement",
        sourceFactId: depletionId,
      });
      expect(await balance(book.id, "cogs")).toBe("75.000000");

      const reversalId = await seedMovement(scratch, {
        inventoryItemId: lot.inventoryItemId,
        movementKind: "reversal",
        quantity: "1",
        occurredAt: "2025-06-12T12:00:00Z",
        reversesMovementId: depletionId,
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "inventory_movement",
        sourceFactId: reversalId,
      });
      expect(outcome.status).toBe("posted");
      expect(outcome.rule?.code).toBe("cogs_depletion_reversed");
      expect(await balance(book.id, "cogs")).toBe("0.000000");
      expect(await balance(book.id, "inventory")).toBe("75.000000");
    });

    it("links the COGS entry to the order the depletion sold into", async () => {
      const { entityId } = await newBook();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `LINK-${counter}`,
        placedAt: "2025-06-20T10:00:00Z",
        subtotal: "200",
        total: "200",
      });
      const orderLineId = await seedOrderLine(scratch, {
        orderId,
        unitPrice: "200",
      });
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-LINK-${counter}`,
        itemCode: `IT-LINK-${counter}`,
        goodsAmount: "55.000000",
        economicEntityId: entityId,
      });
      const movementId = await seedMovement(scratch, {
        inventoryItemId: lot.inventoryItemId,
        movementKind: "depletion_sale",
        quantity: "-1",
        occurredAt: "2025-06-21T12:00:00Z",
        orderLineId,
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "inventory_movement",
        sourceFactId: movementId,
      });
      expect(outcome.status).toBe("posted");

      const links = await scratch.handle.pool.query<{
        source_fact_type: string;
        source_fact_id: string;
        role: string;
      }>(
        `select source_fact_type, source_fact_id::text as source_fact_id, role
           from journal_entry_source_links
          where journal_entry_id = $1
          order by role`,
        [outcome.entry?.id],
      );
      expect(links.rows).toEqual([
        {
          source_fact_type: "order",
          source_fact_id: orderId,
          role: "evidence",
        },
        {
          source_fact_type: "inventory_movement",
          source_fact_id: movementId,
          role: "primary",
        },
      ]);
    });
  });

  /* ------------------------------------------------------ the seam itself */

  describe("the acquisition seam", () => {
    it("never deducts the same dollar twice when an expense is promoted to a purchase", async () => {
      const { book, entityId } = await newBook();

      // 1. The operator records the purchase as an ordinary expense, and it
      //    posts. Money spent on goods has reached the P&L, wrongly.
      const recorded = await expenses.create({
        economicEntityId: entityId,
        expenseDate: "2025-09-04",
        category: "shipping_supplies",
        payeeName: "Estate sale",
        currency: "USD",
        amount: "180",
        paymentMethod: "cash",
        status: "recorded",
      });
      const posted = await engine.evaluateFact({
        sourceFactType: "expense",
        sourceFactId: recorded.expense.id,
      });
      expect(posted.status).toBe("posted");
      expect(await balance(book.id, "shipping_expense")).toBe("180.000000");

      // 2. It was really goods. The operator opens the lot, records the cost,
      //    and voids the expense — the flipping design's void-and-promote path,
      //    with `expenses.acquisition_cost_id` as the supersession pointer that
      //    design's open question 2 recommends. Nothing in the product writes
      //    that column yet, so the fixture writes what the promotion would.
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-SEAM-${counter}`,
        itemCode: `IT-SEAM-${counter}`,
        goodsAmount: "180.000000",
        economicEntityId: entityId,
        acquiredAt: "2025-09-04T12:00:00Z",
      });
      await scratch.handle.pool.query(
        `update expenses set acquisition_cost_id = $1 where id = $2`,
        [lot.goodsCostId, recorded.expense.id],
      );
      await expenses.voidExpense({
        expenseId: recorded.expense.id,
        reason: "this bought goods; promoted to a capitalized acquisition cost",
      });

      // 3. Both facts are re-evaluated, which is what an ordinary sweep does.
      const outcomes = await engine.evaluateFacts([
        { sourceFactType: "expense", sourceFactId: recorded.expense.id },
        { sourceFactType: "acquisition_cost", sourceFactId: lot.goodsCostId },
      ]);
      expect(outcomes[0]?.status).toBe("unpostable");
      expect(outcomes[0]?.reason).toBe("fact_ineligible");
      // The entry it had already produced is REVERSED, not left standing.
      expect(outcomes[0]?.reversalEntry).toBeDefined();
      expect(outcomes[1]?.status).toBe("posted");

      // THE assertion: 180 was spent once, and it is deducted once — as an
      // asset awaiting depletion, with nothing left behind in the P&L.
      expect(await balance(book.id, "shipping_expense")).toBe("0.000000");
      expect(await balance(book.id, "inventory")).toBe("180.000000");
      expect(await balance(book.id, "opening_balance_equity")).toBe(
        "-180.000000",
      );

      const income = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-01-01",
        to: "2025-12-31",
      });
      expect(income.expense.total).toBe("0.000000");

      const sheet = await statements.balanceSheet({
        accountingBookId: book.id,
        asOf: "2025-12-31",
      });
      expect(sheet.assets.total).toBe("180.000000");
      expect(sheet.difference).toBe("0.000000");

      // And the promotion is legible from the ledger: the capitalized entry
      // names the expense it superseded.
      const entry = await scratch.handle.pool.query<{ count: string }>(
        `select count(*)::text as count from journal_entry_source_links
          where source_fact_type = 'expense' and source_fact_id = $1
            and role = 'evidence'`,
        [recorded.expense.id],
      );
      expect(entry.rows[0]?.count).toBe("1");

      // Re-running the sweep again is a no-op in both directions.
      const again = await engine.evaluateFacts([
        { sourceFactType: "expense", sourceFactId: recorded.expense.id },
        { sourceFactType: "acquisition_cost", sourceFactId: lot.goodsCostId },
      ]);
      expect(again[0]?.status).toBe("unpostable");
      expect(again[0]?.reversalEntry).toBeUndefined();
      expect(again[1]?.status).toBe("unchanged");
      expect(await balance(book.id, "inventory")).toBe("180.000000");
    });
  });
});
