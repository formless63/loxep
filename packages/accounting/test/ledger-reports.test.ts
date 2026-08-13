/**
 * Trial balance, account balances, activity, and the entity slice.
 *
 * The end-to-end fixture at the bottom is the one the design calls "the
 * strongest available evidence that this design works": an order, its fees, a
 * refund, a depletion, a payout, and a deposit, posted by hand as the rules
 * milestone will one day post them, ending with `marketplace_clearing` at
 * exactly zero.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBooksService,
  createJournalService,
  createLedgerReports,
} from "../src/index.ts";
import {
  createMigratedScratchDb,
  seedChildEntity,
  seedEntity,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("ledger read models", () => {
  let scratch: ScratchDb;
  let books: ReturnType<typeof createBooksService>;
  let journal: ReturnType<typeof createJournalService>;
  let reports: ReturnType<typeof createLedgerReports>;
  let counter = 0;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_reports");
    books = createBooksService({ db: scratch.handle.db });
    journal = createJournalService({ db: scratch.handle.db });
    reports = createLedgerReports({ db: scratch.handle.db });
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function newBook() {
    counter += 1;
    const { book } = await books.createBook({
      code: `RPT-${counter}`,
      name: `Reports ${counter}`,
      openedOn: "2026-01-01",
    });
    return book;
  }

  describe("trial balance", () => {
    it("sums to zero and splits signed amounts into debit and credit", async () => {
      const book = await newBook();
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-02-10",
        description: "sale",
        lines: [
          { accountSystemKey: "marketplace_clearing", amount: "200" },
          { accountSystemKey: "sales_revenue", amount: "-180" },
          { accountSystemKey: "shipping_income", amount: "-20" },
        ],
      });

      const trial = await reports.trialBalance(book.id);
      expect(trial.functionalCurrency).toBe("USD");
      expect(trial.difference).toBe("0.000000");
      expect(trial.totalDebit).toBe("200.000000");
      expect(trial.totalCredit).toBe("200.000000");

      const clearing = trial.rows.find(
        (row) => row.systemKey === "marketplace_clearing",
      );
      const revenue = trial.rows.find((row) => row.systemKey === "sales_revenue");
      expect(clearing?.debit).toBe("200.000000");
      expect(clearing?.credit).toBe("0.000000");
      expect(clearing?.balance).toBe("200.000000");
      expect(revenue?.credit).toBe("180.000000");
      expect(revenue?.balance).toBe("-180.000000");
      // Only accounts with activity, unless asked otherwise.
      expect(trial.rows).toHaveLength(3);
    });

    it("EXCLUDES drafts and voids, and INCLUDES a reversed entry and its reversal", async () => {
      const book = await newBook();
      await journal.createDraft({
        accountingBookId: book.id,
        entryDate: "2026-02-10",
        description: "draft",
        lines: [
          { accountSystemKey: "marketplace_clearing", amount: "999" },
          { accountSystemKey: "sales_revenue", amount: "-999" },
        ],
      });
      const posted = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-02-10",
        description: "sale",
        lines: [
          { accountSystemKey: "marketplace_clearing", amount: "50" },
          { accountSystemKey: "sales_revenue", amount: "-50" },
        ],
      });

      const beforeReversal = await reports.trialBalance(book.id);
      expect(beforeReversal.totalDebit).toBe("50.000000");

      await journal.reverseEntry({
        journalEntryId: posted.entry.id,
        reason: "cancelled",
      });

      const afterReversal = await reports.trialBalance(book.id);
      // Both halves count: the reversed entry's lines are untouched, and the
      // reversal's lines net them out to zero.
      expect(afterReversal.totalDebit).toBe("100.000000");
      expect(afterReversal.totalCredit).toBe("100.000000");
      expect(afterReversal.difference).toBe("0.000000");
      for (const row of afterReversal.rows) {
        expect(row.balance).toBe("0.000000");
      }
    });

    it("honours a date window", async () => {
      const book = await newBook();
      for (const [date, amount] of [
        ["2026-01-15", "10"],
        ["2026-02-15", "20"],
        ["2026-03-15", "30"],
      ] as const) {
        await journal.postEntry({
          accountingBookId: book.id,
          entryDate: date,
          description: `sale ${date}`,
          lines: [
            { accountSystemKey: "marketplace_clearing", amount },
            { accountSystemKey: "sales_revenue", amount: `-${amount}` },
          ],
        });
      }
      const february = await reports.trialBalance(book.id, {
        from: "2026-02-01",
        to: "2026-02-28",
      });
      expect(february.totalDebit).toBe("20.000000");
      const throughFebruary = await reports.trialBalance(book.id, {
        to: "2026-02-28",
      });
      expect(throughFebruary.totalDebit).toBe("30.000000");
    });

    it("can show the whole chart, including accounts with no activity", async () => {
      const book = await newBook();
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-02-10",
        description: "sale",
        lines: [
          { accountSystemKey: "marketplace_clearing", amount: "5" },
          { accountSystemKey: "sales_revenue", amount: "-5" },
        ],
      });
      const full = await reports.trialBalance(book.id, {
        includeEmptyAccounts: true,
      });
      expect(full.rows.length).toBeGreaterThan(3);
      expect(full.difference).toBe("0.000000");
      const idle = full.rows.find((row) => row.systemKey === "cogs");
      expect(idle?.balance).toBe("0.000000");
      expect(idle?.lineCount).toBe(0);
    });

    it("never mixes two books", async () => {
      const first = await newBook();
      const second = await newBook();
      await journal.postEntry({
        accountingBookId: first.id,
        entryDate: "2026-02-10",
        description: "first book",
        lines: [
          { accountSystemKey: "marketplace_clearing", amount: "5" },
          { accountSystemKey: "sales_revenue", amount: "-5" },
        ],
      });
      const other = await reports.trialBalance(second.id);
      expect(other.rows).toHaveLength(0);
      expect(other.difference).toBe("0.000000");
    });
  });

  describe("the entity slice", () => {
    it("filters a P&L by entity while the book stays whole", async () => {
      const book = await newBook();
      const parentId = await seedEntity(scratch, "Parent Reports LLC");
      const childId = await seedChildEntity(scratch, "DBA Reports", parentId);
      await books.linkEntity({
        accountingBookId: book.id,
        economicEntityId: parentId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });

      await journal.postEntry({
        economicEntityId: parentId,
        entryDate: "2026-02-10",
        description: "parent sale",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "100",
            economicEntityId: parentId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-100",
            economicEntityId: parentId,
          },
        ],
      });
      // The DBA's fact routes into the parent's book and keeps its own label.
      await journal.postEntry({
        economicEntityId: childId,
        entryDate: "2026-02-11",
        description: "DBA sale",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "40",
            economicEntityId: childId,
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-40",
            economicEntityId: childId,
          },
        ],
      });

      const whole = await reports.trialBalance(book.id);
      expect(whole.totalDebit).toBe("140.000000");

      const dbaOnly = await reports.trialBalance(book.id, {
        economicEntityId: childId,
      });
      expect(dbaOnly.totalDebit).toBe("40.000000");
      expect(dbaOnly.difference).toBe("0.000000");

      const revenue = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "sales_revenue",
        filter: { economicEntityId: parentId },
      });
      expect(revenue.balance).toBe("-100.000000");
    });

    it("reports entity-dimension coverage, which gates the entity balance sheet", async () => {
      const book = await newBook();
      const entityId = await seedEntity(scratch, "Coverage LLC");
      await books.linkEntity({
        accountingBookId: book.id,
        economicEntityId: entityId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });
      await journal.postEntry({
        economicEntityId: entityId,
        entryDate: "2026-02-10",
        description: "tagged",
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
      expect(await reports.entityDimensionCoverage(book.id)).toEqual({
        total: 2,
        withEntity: 2,
        complete: true,
      });

      // One opening-balance entry nobody attributed is all it takes.
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-02-10",
        description: "opening bank balance",
        entrySource: "opening_balance",
        lines: [
          { accountSystemKey: "undeposited_funds", amount: "500" },
          { accountSystemKey: "opening_balance_equity", amount: "-500" },
        ],
      });
      const coverage = await reports.entityDimensionCoverage(book.id);
      expect(coverage).toEqual({ total: 4, withEntity: 2, complete: false });
    });
  });

  describe("account balance and activity", () => {
    it("computes a balance by system key with its normal side", async () => {
      const book = await newBook();
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-02-10",
        description: "sale",
        lines: [
          { accountSystemKey: "marketplace_clearing", amount: "60" },
          { accountSystemKey: "sales_revenue", amount: "-60" },
        ],
      });
      const clearing = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "marketplace_clearing",
      });
      expect(clearing.balance).toBe("60.000000");
      expect(clearing.normalBalance).toBe("debit");

      const returns = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "sales_returns",
      });
      // Contra revenue: no activity, and a debit normal side.
      expect(returns.balance).toBe("0.000000");
      expect(returns.normalBalance).toBe("debit");
      expect(returns.lineCount).toBe(0);
    });

    it("lists an account's lines in date order", async () => {
      const book = await newBook();
      for (const [date, amount] of [
        ["2026-02-10", "10"],
        ["2026-01-10", "20"],
      ] as const) {
        await journal.postEntry({
          accountingBookId: book.id,
          entryDate: date,
          description: `sale ${date}`,
          lines: [
            { accountSystemKey: "marketplace_clearing", amount },
            { accountSystemKey: "sales_revenue", amount: `-${amount}` },
          ],
        });
      }
      const activity = await reports.accountActivity({
        accountingBookId: book.id,
        systemKey: "marketplace_clearing",
      });
      expect(activity.map((row) => row.entryDate)).toEqual([
        "2026-01-10",
        "2026-02-10",
      ]);
      expect(activity[0]?.amount).toBe("20.000000");
      expect(activity[0]?.functionalAmount).toBe("20.000000");
    });
  });

  describe("the clearing-account invariant, end to end", () => {
    it("returns marketplace_clearing to EXACTLY zero after a settled window", async () => {
      const book = await newBook();
      const entityId = await seedEntity(scratch, "Resale LLC");
      await books.linkEntity({
        accountingBookId: book.id,
        economicEntityId: entityId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });
      const on = (entityId: string) => ({ economicEntityId: entityId });

      // ORDER: gross 120 = revenue 100 + shipping 10 + facilitator tax 10
      await journal.postEntry({
        economicEntityId: entityId,
        entryDate: "2026-02-03",
        description: "eBay sale",
        sourceFactType: "order",
        sourceFactId: "bbbbbbbb-0000-4000-8000-000000000001",
        postingKey: "pr:order_sale:v1:order:bbbb0001",
        lines: [
          { accountSystemKey: "marketplace_clearing", amount: "120", ...on(entityId) },
          { accountSystemKey: "sales_revenue", amount: "-100", ...on(entityId) },
          { accountSystemKey: "shipping_income", amount: "-10", ...on(entityId) },
          {
            accountSystemKey: "facilitator_tax_clearing",
            amount: "-10",
            ...on(entityId),
          },
        ],
      });

      // DEPLETION: COGS at the frozen landed cost.
      await journal.postEntry({
        economicEntityId: entityId,
        entryDate: "2026-02-03",
        description: "COGS on depletion",
        sourceFactType: "inventory_movement",
        sourceFactId: "bbbbbbbb-0000-4000-8000-000000000002",
        lines: [
          { accountSystemKey: "cogs", amount: "42", ...on(entityId) },
          { accountSystemKey: "inventory", amount: "-42", ...on(entityId) },
        ],
      });

      // FEE: seller_charge only — a buyer_surcharge would be income, not this.
      await journal.postEntry({
        economicEntityId: entityId,
        entryDate: "2026-02-04",
        description: "final value fee",
        sourceFactType: "order_fee",
        sourceFactId: "bbbbbbbb-0000-4000-8000-000000000003",
        lines: [
          { accountSystemKey: "marketplace_fees", amount: "15", ...on(entityId) },
          { accountSystemKey: "marketplace_clearing", amount: "-15", ...on(entityId) },
        ],
      });

      // REFUND: partial.
      await journal.postEntry({
        economicEntityId: entityId,
        entryDate: "2026-02-06",
        description: "partial refund",
        sourceFactType: "order_refund",
        sourceFactId: "bbbbbbbb-0000-4000-8000-000000000004",
        lines: [
          { accountSystemKey: "sales_returns", amount: "20", ...on(entityId) },
          { accountSystemKey: "marketplace_clearing", amount: "-20", ...on(entityId) },
        ],
      });

      // PAYOUT: clearing 85 gross settled = net 75 deposited + 10 facilitator
      // tax the marketplace withheld and remitted itself.
      await journal.postEntry({
        economicEntityId: entityId,
        entryDate: "2026-02-08",
        description: "marketplace payout",
        sourceFactType: "payout",
        sourceFactId: "bbbbbbbb-0000-4000-8000-000000000005",
        lines: [
          { accountSystemKey: "undeposited_funds", amount: "75", ...on(entityId) },
          {
            accountSystemKey: "facilitator_tax_clearing",
            amount: "10",
            ...on(entityId),
          },
          { accountSystemKey: "marketplace_clearing", amount: "-85", ...on(entityId) },
        ],
      });

      // BANK DEPOSIT: reconciliation, not a rule.
      await journal.postEntry({
        economicEntityId: entityId,
        entryDate: "2026-02-10",
        description: "bank deposit",
        lines: [
          { ledgerAccountId: await bankAccountId(book.id), amount: "75", ...on(entityId) },
          { accountSystemKey: "undeposited_funds", amount: "-75", ...on(entityId) },
        ],
      });

      const clearing = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "marketplace_clearing",
      });
      const facilitator = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "facilitator_tax_clearing",
      });
      const undeposited = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "undeposited_funds",
      });
      const sellerTax = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "sales_tax_payable",
      });

      // The findings the whole clearing pattern exists to make checkable.
      expect(clearing.balance).toBe("0.000000");
      expect(facilitator.balance).toBe("0.000000");
      expect(undeposited.balance).toBe("0.000000");
      // Facilitator-collected tax never becomes a liability we will pay.
      expect(sellerTax.balance).toBe("0.000000");

      const trial = await reports.trialBalance(book.id);
      expect(trial.difference).toBe("0.000000");

      // And the suspense account — the plug of last resort — was never used.
      const suspense = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "suspense",
      });
      expect(suspense.balance).toBe("0.000000");
      expect(suspense.lineCount).toBe(0);
    });

    async function bankAccountId(accountingBookId: string): Promise<string> {
      const result = await scratch.handle.pool.query<{ id: string }>(
        `select id from ledger_accounts
          where accounting_book_id = $1 and account_subtype = 'bank' limit 1`,
        [accountingBookId],
      );
      return result.rows[0]?.id as string;
    }
  });
});
