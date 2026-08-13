/**
 * Income statement and balance sheet, and the reconciliation between them.
 *
 * The last two tests in this file are the strongest evidence each milestone
 * has: a book seeded end-to-end through the RULE ENGINE — an order, a seller
 * fee, a buyer surcharge, a refund, and an expense — and then a whole buy ->
 * hold -> sell life where a lot is capitalized, its intake posts nothing, and
 * the depletion turns the asset into COGS. In both, the income statement's net
 * income and the balance sheet's current earnings are the same number, the
 * balance sheet balances to the micro-unit, and the trial balance is zero.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBooksService,
  createExpensesService,
  createFiscalPeriodsService,
  createJournalService,
  createLedgerReports,
  createPostingEngine,
  createStatements,
} from "../src/index.ts";
import {
  createMigratedScratchDb,
  seedConnection,
  seedEntity,
  seedLotWithItem,
  seedMovement,
  seedOrder,
  seedOrderFee,
  seedOrderLine,
  seedOrderRefund,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("statements", () => {
  let scratch: ScratchDb;
  let books: ReturnType<typeof createBooksService>;
  let engine: ReturnType<typeof createPostingEngine>;
  let journal: ReturnType<typeof createJournalService>;
  let reports: ReturnType<typeof createLedgerReports>;
  let statements: ReturnType<typeof createStatements>;
  let expenses: ReturnType<typeof createExpensesService>;
  let periods: ReturnType<typeof createFiscalPeriodsService>;
  let connectionId = "";
  let counter = 0;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_statements");
    books = createBooksService({ db: scratch.handle.db });
    engine = createPostingEngine({ db: scratch.handle.db });
    journal = createJournalService({ db: scratch.handle.db });
    reports = createLedgerReports({ db: scratch.handle.db });
    statements = createStatements({ db: scratch.handle.db });
    expenses = createExpensesService({ db: scratch.handle.db });
    periods = createFiscalPeriodsService({ db: scratch.handle.db });
    connectionId = await seedConnection(scratch);
    await engine.seedDefaultRules();
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function newBook(options?: { requiresEntityDimension?: boolean }) {
    counter += 1;
    const entityId = await seedEntity(scratch, `Statement LLC ${counter}`);
    const { book } = await books.createBook({
      code: `STM-${counter}`,
      name: `Statements ${counter}`,
      openedOn: "2025-01-01",
      ...(options?.requiresEntityDimension === true
        ? { requiresEntityDimension: true }
        : {}),
    });
    await books.linkEntity({
      accountingBookId: book.id,
      economicEntityId: entityId,
      linkRole: "posting_primary",
      effectiveFrom: "2025-01-01",
    });
    return { book, entityId };
  }

  describe("income statement", () => {
    it("flips signs once, and nets revenue against expense", async () => {
      const { book, entityId } = await newBook();
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-03-10",
        description: "sale",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "300",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-300",
            economicEntityId: entityId,
          },
        ],
      });
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-03-11",
        description: "fee",
        lines: [
          {
            accountSystemKey: "marketplace_fees",
            amount: "45",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "marketplace_clearing",
            amount: "-45",
            economicEntityId: entityId,
          },
        ],
      });

      const income = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-01-01",
        to: "2025-12-31",
      });
      expect(income.functionalCurrency).toBe("USD");
      // Credits read as positive income; debits read as positive cost.
      expect(income.revenue.total).toBe("300.000000");
      expect(income.expense.total).toBe("45.000000");
      expect(income.netIncome).toBe("255.000000");
      expect(income.revenue.lines[0]?.amount).toBe("300.000000");
    });

    it("subtracts a contra-revenue return without flipping it twice", async () => {
      const { book, entityId } = await newBook();
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-04-01",
        description: "sale",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "100",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-100",
            economicEntityId: entityId,
          },
        ],
      });
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-04-05",
        description: "refund",
        lines: [
          {
            accountSystemKey: "sales_returns",
            amount: "30",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "marketplace_clearing",
            amount: "-30",
            economicEntityId: entityId,
          },
        ],
      });

      const income = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-01-01",
        to: "2025-12-31",
      });
      const returns = income.revenue.lines.find(
        (line) => line.systemKey === "sales_returns",
      );
      expect(returns?.isContra).toBe(true);
      expect(returns?.amount).toBe("-30.000000");
      expect(income.revenue.total).toBe("70.000000");
      expect(income.netIncome).toBe("70.000000");
    });

    it("respects the date window", async () => {
      const { book, entityId } = await newBook();
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-02-10",
        description: "february",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "10",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-10",
            economicEntityId: entityId,
          },
        ],
      });
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-03-10",
        description: "march",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "90",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-90",
            economicEntityId: entityId,
          },
        ],
      });

      const march = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-03-01",
        to: "2025-03-31",
      });
      expect(march.netIncome).toBe("90.000000");
    });

    it("slices by entity — ADR-0017's actual promise", async () => {
      const { book, entityId } = await newBook();
      const otherId = await seedEntity(scratch, `Sibling ${counter}`);
      await books.linkEntity({
        accountingBookId: book.id,
        economicEntityId: otherId,
        linkRole: "posting_primary",
        effectiveFrom: "2025-01-01",
      });
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-05-01",
        description: "entity A",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "200",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-200",
            economicEntityId: entityId,
          },
        ],
      });
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-05-02",
        description: "entity B",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "75",
            economicEntityId: otherId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-75",
            economicEntityId: otherId,
          },
        ],
      });

      const whole = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-01-01",
        to: "2025-12-31",
      });
      const sliceA = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-01-01",
        to: "2025-12-31",
        filter: { economicEntityId: entityId },
      });
      const sliceB = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-01-01",
        to: "2025-12-31",
        filter: { economicEntityId: otherId },
      });
      expect(whole.netIncome).toBe("275.000000");
      expect(sliceA.netIncome).toBe("200.000000");
      expect(sliceB.netIncome).toBe("75.000000");
    });
  });

  describe("balance sheet", () => {
    it("balances, and computes retained earnings from prior fiscal years", async () => {
      const { book, entityId } = await newBook();
      // 2025: earn 500 and spend 100 -> retained 400 at any 2026 date.
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-06-01",
        description: "2025 sale",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "500",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-500",
            economicEntityId: entityId,
          },
        ],
      });
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-06-02",
        description: "2025 fee",
        lines: [
          {
            accountSystemKey: "marketplace_fees",
            amount: "100",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "marketplace_clearing",
            amount: "-100",
            economicEntityId: entityId,
          },
        ],
      });
      // Fiscal years are GENERATED, never auto-created on demand: posting into
      // a date with no period is a backlog item, not an implicit INSERT.
      await periods.generateFiscalYear({
        accountingBookId: book.id,
        fiscalYear: 2026,
      });
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-02-01",
        description: "2026 sale",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "150",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-150",
            economicEntityId: entityId,
          },
        ],
      });

      const sheet = await statements.balanceSheet({
        accountingBookId: book.id,
        asOf: "2026-12-31",
      });
      expect(sheet.assets.total).toBe("550.000000");
      expect(sheet.liabilities.total).toBe("0.000000");
      // No closing entries and no retained-earnings ACCOUNT: both numbers are
      // computed from the entries themselves.
      expect(sheet.retainedEarnings).toBe("400.000000");
      expect(sheet.currentEarnings).toBe("150.000000");
      expect(sheet.totalEquity).toBe("550.000000");
      expect(sheet.difference).toBe("0.000000");
      expect(sheet.balanced).toBe(true);

      // And the income statement for the same window agrees with the current
      // year's earnings, because both are the same partition of one column.
      const income = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2026-01-01",
        to: "2026-12-31",
      });
      expect(income.netIncome).toBe(sheet.currentEarnings);
    });

    it("refuses an entity-filtered balance sheet the book cannot support", async () => {
      const { book, entityId } = await newBook();
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-07-01",
        description: "sale",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "10",
            economicEntityId: entityId,
          },
          { accountSystemKey: "sales_revenue", amount: "-10" },
        ],
      });
      await expect(
        statements.balanceSheet({
          accountingBookId: book.id,
          asOf: "2025-12-31",
          filter: { economicEntityId: entityId },
        }),
      ).rejects.toThrow(/does not require the entity dimension/);
    });

    it("refuses an entity slice when coverage is incomplete, even in a book that requires it", async () => {
      const { book, entityId } = await newBook({ requiresEntityDimension: true });
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-07-01",
        description: "half-dimensioned",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "10",
            economicEntityId: entityId,
          },
          // The line nobody thinks about.
          { accountSystemKey: "sales_revenue", amount: "-10" },
        ],
      });
      await expect(
        statements.balanceSheet({
          accountingBookId: book.id,
          asOf: "2025-12-31",
          filter: { economicEntityId: entityId },
        }),
      ).rejects.toThrow(/posted lines without an entity/);
    });

    it("produces an entity-filtered balance sheet when every line carries the dimension", async () => {
      const { book, entityId } = await newBook({ requiresEntityDimension: true });
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2025-07-01",
        description: "fully dimensioned",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "80",
            economicEntityId: entityId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-80",
            economicEntityId: entityId,
          },
        ],
      });
      const sheet = await statements.balanceSheet({
        accountingBookId: book.id,
        asOf: "2025-12-31",
        filter: { economicEntityId: entityId },
      });
      expect(sheet.assets.total).toBe("80.000000");
      expect(sheet.currentEarnings).toBe("80.000000");
      expect(sheet.balanced).toBe(true);
    });
  });

  describe("the end-to-end reconciliation", () => {
    it("posts a whole month through the RULES and reconciles all three reports", async () => {
      const { book, entityId } = await newBook();

      // 400 goods + 25 shipping + 30 facilitator tax + 5 buyer surcharge = 460.
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `E2E-${counter}`,
        placedAt: "2025-08-03T10:00:00Z",
        subtotal: "400",
        shipping: "25",
        tax: "30",
        fee: "52",
        total: "460",
      });
      const sellerFeeId = await seedOrderFee(scratch, {
        orderId,
        feeDirection: "seller_charge",
        feeType: "final_value",
        amount: "52",
        chargedAt: "2025-08-04T10:00:00Z",
      });
      const surchargeId = await seedOrderFee(scratch, {
        orderId,
        feeDirection: "buyer_surcharge",
        feeType: "handling",
        amount: "5",
        chargedAt: "2025-08-04T10:00:00Z",
      });
      const refundId = await seedOrderRefund(scratch, {
        orderId,
        amount: "40",
        kind: "partial",
        refundedAt: "2025-08-20T10:00:00Z",
      });
      const postage = await expenses.create({
        economicEntityId: entityId,
        expenseDate: "2025-08-06",
        category: "postage",
        payeeName: "USPS",
        currency: "USD",
        amount: "18",
        paymentMethod: "card",
        status: "recorded",
      });

      const outcomes = await engine.evaluateFacts([
        { sourceFactType: "order", sourceFactId: orderId },
        { sourceFactType: "order_fee", sourceFactId: sellerFeeId },
        { sourceFactType: "order_fee", sourceFactId: surchargeId },
        { sourceFactType: "order_refund", sourceFactId: refundId },
        { sourceFactType: "expense", sourceFactId: postage.expense.id },
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "posted",
        "posted",
        "posted",
        "posted",
        "posted",
      ]);

      /*
       * revenue   sales 400 + shipping 25 + buyer surcharge 5   =  430
       * contra    sales returns 40                              =  -40
       * expense   marketplace fees 52 + postage 18              =   70
       * net income                                              =  320
       */
      const income = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-08-01",
        to: "2025-08-31",
      });
      expect(income.revenue.total).toBe("390.000000");
      expect(income.expense.total).toBe("70.000000");
      expect(income.netIncome).toBe("320.000000");

      const sheet = await statements.balanceSheet({
        accountingBookId: book.id,
        asOf: "2025-08-31",
      });
      // Assets: clearing 460 − 52 fee − 40 refund = 368. Suspense is zero
      // because the buyer surcharge explained the sale's residue.
      expect(sheet.assets.total).toBe("368.000000");
      // Liabilities: the facilitator's 30, which is not ours and never touches
      // P&L; it clears when the payout settles (a later milestone).
      expect(sheet.liabilities.total).toBe("30.000000");
      // Equity: −18 of owner-funded postage, plus the year's earnings.
      expect(sheet.equityAccounts.total).toBe("18.000000");
      expect(sheet.currentEarnings).toBe("320.000000");
      expect(sheet.totalEquity).toBe("338.000000");

      // THE reconciliation: assets = liabilities + equity, exactly, and the
      // income statement's net income IS the balance sheet's current earnings.
      expect(sheet.difference).toBe("0.000000");
      expect(sheet.balanced).toBe(true);
      expect(sheet.currentEarnings).toBe(income.netIncome);

      // And the trial balance, the report both are partitions of, is still zero.
      const trial = await reports.trialBalance(book.id);
      expect(trial.difference).toBe("0.000000");
      expect(trial.totalDebit).toBe(trial.totalCredit);

      // Suspense — the plug of last resort — was used and fully cleared.
      const suspense = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "suspense",
      });
      expect(suspense.balance).toBe("0.000000");
      expect(suspense.lineCount).toBe(2);

      // Re-running the whole month changes nothing: every fingerprint matches.
      const again = await engine.evaluateFacts([
        { sourceFactType: "order", sourceFactId: orderId },
        { sourceFactType: "order_fee", sourceFactId: sellerFeeId },
        { sourceFactType: "order_fee", sourceFactId: surchargeId },
        { sourceFactType: "order_refund", sourceFactId: refundId },
        { sourceFactType: "expense", sourceFactId: postage.expense.id },
      ]);
      expect(again.every((outcome) => outcome.status === "unchanged")).toBe(true);
      const afterRerun = await statements.balanceSheet({
        accountingBookId: book.id,
        asOf: "2025-08-31",
      });
      expect(afterRerun.assets.total).toBe(sheet.assets.total);
      expect(afterRerun.difference).toBe("0.000000");
    });

    it("reconciles a whole buy -> hold -> sell life, with COGS in net income", async () => {
      const { book, entityId } = await newBook();

      /*
       * BUY   120 of goods, capitalized. An ASSET, not an expense.
       * HOLD  the receipt movement posts NOTHING — the same dollar again.
       * SELL  320 gross (300 goods + 20 shipping), a 40 seller fee, and the
       *       depletion that turns the 120 asset into 120 of COGS.
       */
      const lot = await seedLotWithItem(scratch, {
        referenceCode: `ACQ-LIFE-${counter}`,
        itemCode: `IT-LIFE-${counter}`,
        goodsAmount: "120.000000",
        economicEntityId: entityId,
        acquiredAt: "2025-09-02T12:00:00Z",
      });
      const receiptId = await seedMovement(scratch, {
        inventoryItemId: lot.inventoryItemId,
        movementKind: "receipt",
        quantity: "1",
        occurredAt: "2025-09-03T12:00:00Z",
      });
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `LIFE-${counter}`,
        placedAt: "2025-09-10T10:00:00Z",
        subtotal: "300",
        shipping: "20",
        fee: "40",
        total: "320",
      });
      const orderLineId = await seedOrderLine(scratch, {
        orderId,
        unitPrice: "300",
        lineTotal: "300",
      });
      const feeId = await seedOrderFee(scratch, {
        orderId,
        feeDirection: "seller_charge",
        feeType: "final_value",
        amount: "40",
        chargedAt: "2025-09-11T10:00:00Z",
      });
      const depletionId = await seedMovement(scratch, {
        inventoryItemId: lot.inventoryItemId,
        movementKind: "depletion_sale",
        quantity: "-1",
        occurredAt: "2025-09-10T12:00:00Z",
        orderLineId,
      });

      const facts = [
        { sourceFactType: "acquisition_cost", sourceFactId: lot.goodsCostId },
        { sourceFactType: "inventory_movement", sourceFactId: receiptId },
        { sourceFactType: "order", sourceFactId: orderId },
        { sourceFactType: "order_fee", sourceFactId: feeId },
        { sourceFactType: "inventory_movement", sourceFactId: depletionId },
      ];
      const outcomes = await engine.evaluateFacts(facts);
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "posted",
        // The intake, deliberately: its dollar is already in inventory.
        "unpostable",
        "posted",
        "posted",
        "posted",
      ]);
      expect(outcomes[1]?.reason).toBe("fact_ineligible");

      /*
       * revenue   sales 300 + shipping 20                =  320
       * expense   marketplace fees 40 + COGS 120         =  160
       * net income                                       =  160
       */
      const income = await statements.incomeStatement({
        accountingBookId: book.id,
        from: "2025-09-01",
        to: "2025-09-30",
      });
      expect(income.revenue.total).toBe("320.000000");
      expect(income.expense.total).toBe("160.000000");
      expect(income.netIncome).toBe("160.000000");

      const cogs = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "cogs",
      });
      expect(cogs.balance).toBe("120.000000");
      // The asset came and went, to the micro-unit, through the two facts.
      const inventory = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "inventory",
      });
      expect(inventory.balance).toBe("0.000000");

      const sheet = await statements.balanceSheet({
        accountingBookId: book.id,
        asOf: "2025-09-30",
      });
      // Assets: clearing 320 − 40 fee = 280, and no inventory left.
      expect(sheet.assets.total).toBe("280.000000");
      expect(sheet.liabilities.total).toBe("0.000000");
      // Equity: 120 of owner-funded goods, plus the year's earnings.
      expect(sheet.equityAccounts.total).toBe("120.000000");
      expect(sheet.currentEarnings).toBe("160.000000");
      expect(sheet.totalEquity).toBe("280.000000");
      expect(sheet.difference).toBe("0.000000");
      expect(sheet.balanced).toBe(true);
      expect(sheet.currentEarnings).toBe(income.netIncome);

      const trial = await reports.trialBalance(book.id);
      expect(trial.difference).toBe("0.000000");

      const again = await engine.evaluateFacts(facts);
      expect(again.map((outcome) => outcome.status)).toEqual([
        "unchanged",
        "unpostable",
        "unchanged",
        "unchanged",
        "unchanged",
      ]);
      const afterRerun = await statements.balanceSheet({
        accountingBookId: book.id,
        asOf: "2025-09-30",
      });
      expect(afterRerun.difference).toBe("0.000000");
      expect(afterRerun.currentEarnings).toBe("160.000000");
    });
  });
});
