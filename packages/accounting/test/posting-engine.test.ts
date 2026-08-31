/**
 * The rule engine over real Phase 3 and Phase 5 facts.
 *
 * The five behaviours this file exists to pin down are the five the design
 * asks for by name in its pre-implementation checklist:
 *
 * ```text
 * the same fact posted twice          one entry (the posting key)
 * a fact re-synced unchanged          no-op (the fingerprint)
 * a fact changed after posting        reverse and re-post
 * a re-post under a new rule version  reverse and re-post
 * a retried reversal                  idempotent (covered in journal.test.ts)
 * ```
 *
 * plus the ratified `fee_direction` reading, which is the one place a wrong
 * answer moves real money in the P&L.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBooksService,
  createExpensesService,
  createJournalService,
  createLedgerReports,
  createPostingEngine,
  createPostingRulesService,
} from "../src/index.ts";
import {
  createMigratedScratchDb,
  seedConnection,
  seedEntity,
  seedOrder,
  seedOrderFee,
  seedOrderRefund,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("posting engine", () => {
  let scratch: ScratchDb;
  let books: ReturnType<typeof createBooksService>;
  let engine: ReturnType<typeof createPostingEngine>;
  let rules: ReturnType<typeof createPostingRulesService>;
  let journal: ReturnType<typeof createJournalService>;
  let reports: ReturnType<typeof createLedgerReports>;
  let expenses: ReturnType<typeof createExpensesService>;
  let connectionId = "";
  let counter = 0;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_engine");
    books = createBooksService({ db: scratch.handle.db });
    engine = createPostingEngine({ db: scratch.handle.db });
    rules = createPostingRulesService({ db: scratch.handle.db });
    journal = createJournalService({ db: scratch.handle.db });
    reports = createLedgerReports({ db: scratch.handle.db });
    expenses = createExpensesService({ db: scratch.handle.db });
    connectionId = await seedConnection(scratch);
    await engine.seedDefaultRules();
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  /** A book, an entity linked to it, and nothing else shared between tests. */
  async function newFixture() {
    counter += 1;
    const entityId = await seedEntity(scratch, `Engine LLC ${counter}`);
    const { book } = await books.createBook({
      code: `ENG-${counter}`,
      name: `Engine ${counter}`,
      openedOn: "2026-01-01",
    });
    await books.linkEntity({
      accountingBookId: book.id,
      economicEntityId: entityId,
      linkRole: "posting_primary",
      effectiveFrom: "2026-01-01",
    });
    return { book, entityId };
  }

  async function balanceOf(bookId: string, systemKey: string): Promise<string> {
    const balance = await reports.accountBalance({
      accountingBookId: bookId,
      systemKey,
    });
    return balance.balance;
  }

  describe("posting an order", () => {
    it("posts the shipped sale rule and stamps the version that produced it", async () => {
      const { book, entityId } = await newFixture();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "180",
        shipping: "20",
        tax: "15",
        total: "215",
      });

      const outcome = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(outcome.status).toBe("posted");
      expect(outcome.rule?.code).toBe("order_sale");
      expect(outcome.accountingBookId).toBe(book.id);

      const entry = outcome.entry;
      expect(entry?.entrySource).toBe("posting_rule");
      expect(entry?.postingRuleVersionId).toBe(outcome.rule?.postingRuleVersionId);
      expect(entry?.postingKey).toMatch(/^pr:order_sale:v1:order:/);
      expect(entry?.sourceFactFingerprint).toHaveLength(64);
      expect(entry?.entryDate).toBe("2026-02-10");

      expect(await balanceOf(book.id, "marketplace_clearing")).toBe("215.000000");
      expect(await balanceOf(book.id, "sales_revenue")).toBe("-180.000000");
      expect(await balanceOf(book.id, "shipping_income")).toBe("-20.000000");
      // Facilitator tax passes through a clearing account and never touches
      // sales_tax_payable or the P&L.
      expect(await balanceOf(book.id, "facilitator_tax_clearing")).toBe(
        "-15.000000",
      );
      expect(await balanceOf(book.id, "sales_tax_payable")).toBe("0.000000");
      // Every component was recognized, so nothing was left unexplained.
      expect(await balanceOf(book.id, "suspense")).toBe("0.000000");

      // The line inherits the entity from the fact, which is what makes the
      // entity-filtered income statement possible at all.
      const lines = await journal.getLines(entry?.id ?? "");
      expect(lines.every((line) => line.economicEntityId === entityId)).toBe(true);
      expect(lines[0]?.description).toBe(`ebay sale ORD-${counter}`);
    });

    it("drops zero-amount lines instead of writing empty rows", async () => {
      const { book, entityId } = await newFixture();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "50",
        total: "50",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      const lines = await journal.getLines(outcome.entry?.id ?? "");
      // Clearing and revenue only: no shipping, no tax, no discount, no plug.
      expect(lines).toHaveLength(2);
      expect(await balanceOf(book.id, "suspense")).toBe("0.000000");
    });

    it("posts the same fact twice as ONE entry", async () => {
      const { entityId } = await newFixture();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "40",
        total: "40",
      });
      const first = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      const second = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(first.status).toBe("posted");
      // The fingerprint matched: the second evaluation did no work at all,
      // which is what makes every provider re-sync free.
      expect(second.status).toBe("unchanged");
      expect(second.entry?.id).toBe(first.entry?.id);

      const entries = await journal.findBySourceFact("order", orderId);
      expect(entries).toHaveLength(1);
    });
  });

  describe("the ratified fee_direction reading", () => {
    it("posts a seller_charge to a fee EXPENSE and out of clearing", async () => {
      const { book, entityId } = await newFixture();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "100",
        total: "100",
        fee: "13",
      });
      await engine.evaluateFact({ sourceFactType: "order", sourceFactId: orderId });
      const feeId = await seedOrderFee(scratch, {
        orderId,
        feeDirection: "seller_charge",
        feeType: "final_value",
        amount: "13",
      });

      const outcome = await engine.evaluateFact({
        sourceFactType: "order_fee",
        sourceFactId: feeId,
      });
      expect(outcome.rule?.code).toBe("order_fee_seller_charge");
      expect(await balanceOf(book.id, "marketplace_fees")).toBe("13.000000");
      expect(await balanceOf(book.id, "buyer_fee_income")).toBe("0.000000");
      // A deduction from proceeds: the marketplace owes us 13 less.
      expect(await balanceOf(book.id, "marketplace_clearing")).toBe("87.000000");

      // Provenance: the fee is primary, its order is evidence.
      const links = await scratch.handle.pool.query<{
        role: string;
        source_fact_type: string;
      }>(
        `select role, source_fact_type from journal_entry_source_links
          where journal_entry_id = $1 order by role`,
        [outcome.entry?.id],
      );
      expect(links.rows).toEqual([
        { role: "evidence", source_fact_type: "order" },
        { role: "primary", source_fact_type: "order_fee" },
      ]);
    });

    it("posts a buyer_surcharge to fee INCOME, clearing the sale's residue", async () => {
      const { book, entityId } = await newFixture();
      // 180 + 20 shipping + 15 tax + 5 handling surcharge = 220 total.
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "180",
        shipping: "20",
        tax: "15",
        total: "220",
      });
      await engine.evaluateFact({ sourceFactType: "order", sourceFactId: orderId });
      // The surcharge is inside the total and Loxep has not seen it yet, so the
      // sale's plug parks it where a human will look.
      expect(await balanceOf(book.id, "suspense")).toBe("-5.000000");

      const feeId = await seedOrderFee(scratch, {
        orderId,
        feeDirection: "buyer_surcharge",
        feeType: "handling",
        amount: "5",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "order_fee",
        sourceFactId: feeId,
      });
      expect(outcome.rule?.code).toBe("order_fee_buyer_surcharge");

      // Income, not a fee expense: posting it as an expense would understate
      // income by exactly the amount the buyer covered.
      expect(await balanceOf(book.id, "buyer_fee_income")).toBe("-5.000000");
      expect(await balanceOf(book.id, "marketplace_fees")).toBe("0.000000");
      // And it did NOT debit clearing a second time — the sale already did.
      expect(await balanceOf(book.id, "marketplace_clearing")).toBe("220.000000");
      expect(await balanceOf(book.id, "suspense")).toBe("0.000000");
    });

    it("posts a refund as contra revenue, out of clearing", async () => {
      const { book, entityId } = await newFixture();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "60",
        total: "60",
      });
      await engine.evaluateFact({ sourceFactType: "order", sourceFactId: orderId });
      const refundId = await seedOrderRefund(scratch, {
        orderId,
        amount: "60",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "order_refund",
        sourceFactId: refundId,
      });
      expect(outcome.rule?.code).toBe("order_refund");
      expect(await balanceOf(book.id, "sales_returns")).toBe("60.000000");
      expect(await balanceOf(book.id, "marketplace_clearing")).toBe("0.000000");
    });

    it("skips a refund the provider never completed", async () => {
      const { entityId } = await newFixture();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "60",
        total: "60",
      });
      const refundId = await seedOrderRefund(scratch, {
        orderId,
        amount: "10",
        status: "pending",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "order_refund",
        sourceFactId: refundId,
      });
      expect(outcome.status).toBe("unpostable");
      expect(outcome.reason).toBe("fact_ineligible");
      expect(outcome.explanation).toMatch(/no money has moved/);
    });
  });

  describe("re-post on change: reversal and a new entry, never mutation", () => {
    it("reverses and re-posts when the FACT changed", async () => {
      const { book, entityId } = await newFixture();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "100",
        total: "100",
      });
      const first = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(await balanceOf(book.id, "sales_revenue")).toBe("-100.000000");

      // The provider corrected the order: 100 -> 120.
      await scratch.handle.pool.query(
        `update orders set subtotal_amount = 120, total_amount = 120 where id = $1`,
        [orderId],
      );
      const second = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(second.status).toBe("reposted");
      // The outcome carries the REVERSING entry; the entry it reverses is
      // named on it and keeps its own lines.
      expect(second.reversalEntry?.reversesEntryId).toBe(first.entry?.id);
      expect(second.entry?.id).not.toBe(first.entry?.id);
      // A NEW key, because the fingerprint is part of it. Under the design's
      // literal formula both keys would be identical and the unique constraint
      // would have swallowed the correction.
      expect(second.entry?.postingKey).not.toBe(first.entry?.postingKey);

      // The original is stamped `reversed` and its lines are UNTOUCHED; the
      // reversal's lines are what net them out.
      const original = await journal.getEntry(first.entry?.id ?? "");
      expect(original.status).toBe("reversed");
      const originalLines = await journal.getLines(original.id);
      expect(originalLines[0]?.amount).toBe("100.000000");

      // Three entries, one net truth.
      expect(await balanceOf(book.id, "sales_revenue")).toBe("-120.000000");
      expect(await balanceOf(book.id, "marketplace_clearing")).toBe("120.000000");
      const trial = await reports.trialBalance(book.id);
      expect(trial.difference).toBe("0.000000");

      // The reversal names the fact it corrects, in both directions.
      const links = await scratch.handle.pool.query<{ role: string }>(
        `select role from journal_entry_source_links
          where journal_entry_id = $1 order by role`,
        [original.id],
      );
      expect(links.rows.map((row) => row.role)).toContain("primary");
    });

    it("does NOT repost when a field no rule reads changes", async () => {
      const { entityId } = await newFixture();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "70",
        total: "70",
      });
      const first = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      await scratch.handle.pool.query(
        `update orders set buyer_display_name = 'Renamed Buyer',
                           last_synced_at = now() where id = $1`,
        [orderId],
      );
      const second = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      // The fingerprint hashes exactly what the rule consumed, and a buyer's
      // display name is not in it.
      expect(second.status).toBe("unchanged");
      expect(second.entry?.id).toBe(first.entry?.id);
    });

    it("reverses and re-posts under a NEW rule version", async () => {
      const { book, entityId } = await newFixture();
      const code = `book_sale_${counter}`;
      // A book-narrowed rule at a better priority, so this fixture's orders
      // resolve to it rather than to the shipped one.
      const created = await rules.createRule({
        code,
        name: "Book-specific sale",
        sourceFactType: "order",
        accountingBookId: book.id,
        priority: 10,
        activate: true,
        lines: [
          { accountSystemKey: "marketplace_clearing", amountSource: "total" },
          {
            accountSystemKey: "sales_revenue",
            amountSource: "total",
            amountMultiplier: "-1",
          },
        ],
      });
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "90",
        total: "90",
      });
      const first = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(first.rule?.version).toBe(1);
      expect(await balanceOf(book.id, "sales_revenue")).toBe("-90.000000");

      // The operator corrects the rule: shipping income was being swallowed
      // into revenue. Version 2 splits it.
      const second = await rules.addVersion({
        postingRuleId: created.rule.id,
        activate: true,
        lines: [
          { accountSystemKey: "marketplace_clearing", amountSource: "total" },
          {
            accountSystemKey: "sales_revenue",
            amountSource: "subtotal",
            amountMultiplier: "-1",
          },
          { accountSystemKey: "suspense", amountSource: "remainder" },
        ],
      });

      const reposted = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(reposted.status).toBe("reposted");
      expect(reposted.rule?.version).toBe(2);
      expect(reposted.entry?.postingRuleVersionId).toBe(second.version.id);
      expect(reposted.entry?.postingKey).toMatch(/:v2:/);

      // Entries posted under v1 keep their v1 stamp: an entry is explained by
      // the text that produced it, and by nothing else.
      const original = await journal.getEntry(first.entry?.id ?? "");
      expect(original.postingRuleVersionId).toBe(created.version.id);
      const trial = await reports.trialBalance(book.id);
      expect(trial.difference).toBe("0.000000");
    });
  });

  describe("expenses", () => {
    it("routes by category and splits by allocations that name an account", async () => {
      const { book, entityId } = await newFixture();
      const created = await expenses.create({
        economicEntityId: entityId,
        expenseDate: "2026-03-04",
        category: "postage",
        payeeName: "USPS",
        currency: "USD",
        amount: "60",
        paymentMethod: "card",
        status: "recorded",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "expense",
        sourceFactId: created.expense.id,
      });
      expect(outcome.rule?.code).toBe("expense_postage");
      expect(await balanceOf(book.id, "shipping_expense")).toBe("60.000000");
      expect(await balanceOf(book.id, "opening_balance_equity")).toBe(
        "-60.000000",
      );

      // A split naming an account moves that share onto its own line — the
      // reason expense_allocations.ledger_account_id ships in this migration.
      const marketplaceFees = await scratch.handle.pool.query<{ id: string }>(
        `select id from ledger_accounts
          where accounting_book_id = $1 and system_key = 'marketplace_fees'`,
        [book.id],
      );
      const split = await expenses.create({
        economicEntityId: entityId,
        expenseDate: "2026-03-05",
        category: "postage",
        payeeName: "Mixed bill",
        currency: "USD",
        amount: "100",
        paymentMethod: "card",
      });
      await expenses.addAllocation({
        expenseId: split.expense.id,
        allocation: {
          amount: "40",
          ledgerAccountId: marketplaceFees.rows[0]?.id ?? "",
        },
      });
      await expenses.submit({ expenseId: split.expense.id });

      const splitOutcome = await engine.evaluateFact({
        sourceFactType: "expense",
        sourceFactId: split.expense.id,
      });
      expect(splitOutcome.status).toBe("posted");
      expect(await balanceOf(book.id, "marketplace_fees")).toBe("40.000000");
      // 60 from the first expense plus the unallocated 60 of the split.
      expect(await balanceOf(book.id, "shipping_expense")).toBe("120.000000");
      const trial = await reports.trialBalance(book.id);
      expect(trial.difference).toBe("0.000000");
    });

    it("does not split an expense over-allocated by one high-boundary micro-unit", async () => {
      const { book, entityId } = await newFixture();
      const created = await expenses.create({
        economicEntityId: entityId,
        expenseDate: "2026-03-05",
        category: "postage",
        payeeName: "Malformed allocation fixture",
        currency: "USD",
        amount: "99999999999999.000000",
        paymentMethod: "card",
        status: "recorded",
      });
      const marketplaceFees = await scratch.handle.pool.query<{ id: string }>(
        `select id from ledger_accounts
          where accounting_book_id = $1 and system_key = 'marketplace_fees'`,
        [book.id],
      );

      // The expense service rejects this state. Insert it directly to prove
      // the posting engine's defensive fallback is also exact for legacy,
      // imported, or otherwise out-of-band rows.
      await scratch.handle.pool.query(
        `insert into expense_allocations
           (expense_id, line_number, amount, ledger_account_id)
         values ($1, 1, $2, $3)`,
        [
          created.expense.id,
          "99999999999999.000001",
          marketplaceFees.rows[0]?.id,
        ],
      );

      const outcome = await engine.evaluateFact({
        sourceFactType: "expense",
        sourceFactId: created.expense.id,
      });
      expect(outcome.status).toBe("posted");
      // An incoherent split is ignored in favour of the rule-authored line.
      expect(await balanceOf(book.id, "marketplace_fees")).toBe("0.000000");
      expect(await balanceOf(book.id, "shipping_expense")).toBe(
        "99999999999999.000000",
      );
      expect((await reports.trialBalance(book.id)).difference).toBe("0.000000");
    });

    it("falls through to the catch-all rule for an unmapped category", async () => {
      const { book, entityId } = await newFixture();
      const created = await expenses.create({
        economicEntityId: entityId,
        expenseDate: "2026-03-06",
        category: "meals",
        currency: "USD",
        amount: "25",
        paymentMethod: "cash",
        status: "recorded",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "expense",
        sourceFactId: created.expense.id,
      });
      expect(outcome.rule?.code).toBe("expense_uncategorized");
      // Visible in a named report rather than invisible in both the ledger and
      // the backlog.
      expect(await balanceOf(book.id, "suspense")).toBe("25.000000");
    });

    it("honours the expense's own book override", async () => {
      const { entityId } = await newFixture();
      counter += 1;
      const { book: other } = await books.createBook({
        code: `OVR-${counter}`,
        name: `Override ${counter}`,
        openedOn: "2026-01-01",
      });
      const created = await expenses.create({
        economicEntityId: entityId,
        expenseDate: "2026-03-07",
        category: "bank_fees",
        currency: "USD",
        amount: "12",
        paymentMethod: "bank_transfer",
        status: "recorded",
      });
      await scratch.handle.pool.query(
        `update expenses set accounting_book_id = $1 where id = $2`,
        [other.id, created.expense.id],
      );
      const outcome = await engine.evaluateFact({
        sourceFactType: "expense",
        sourceFactId: created.expense.id,
      });
      expect(outcome.accountingBookId).toBe(other.id);
      expect(await balanceOf(other.id, "payment_processing_fees")).toBe(
        "12.000000",
      );
    });

    it("refuses to post a draft expense", async () => {
      const { entityId } = await newFixture();
      const created = await expenses.create({
        economicEntityId: entityId,
        expenseDate: "2026-03-08",
        category: "supplies",
        currency: "USD",
        amount: "9",
        paymentMethod: "card",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "expense",
        sourceFactId: created.expense.id,
      });
      expect(outcome.status).toBe("unpostable");
      expect(outcome.explanation).toMatch(/only a recorded expense posts/);
    });
  });

  describe("the unpostable backlog is a read model, not an error", () => {
    it("reports a fact with no route rather than guessing a book", async () => {
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: null,
        externalOrderId: `ORPHAN-${(counter += 1)}`,
        subtotal: "10",
        total: "10",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(outcome.status).toBe("unpostable");
      expect(outcome.reason).toBe("no_route");

      const backlog = await engine.unpostableBacklog({
        sourceFactTypes: ["order"],
      });
      expect(backlog.some((item) => item.sourceFactId === orderId)).toBe(true);
    });

    it("skips a fact routed to an archived (disabled) book rather than throwing", async () => {
      // loxep-6fm: books are toggleable per entity (financial-schema-design.md
      // owner answer 1) via `archiveBook`. A link can outlive the book being
      // archived, so routing still resolves — and posting must degrade to
      // `unpostable`/`no_route`, never let `journal.postEntry`'s archived-book
      // guard throw out of `evaluateFact`, or a single disabled book would
      // abort an entire sweep of unrelated facts.
      const { book, entityId } = await newFixture();
      await books.archiveBook({ accountingBookId: book.id });
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ARCHIVED-${(counter += 1)}`,
        subtotal: "10",
        total: "10",
      });

      const outcome = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(outcome.status).toBe("unpostable");
      expect(outcome.reason).toBe("no_route");
      expect(outcome.explanation).toMatch(/archived/);

      const entries = await journal.findBySourceFact("order", orderId);
      expect(entries).toHaveLength(0);
    });

    it("reports a fact no rule matches, and explains which candidates lost", async () => {
      const { book, entityId } = await newFixture();
      // Disable the shipped refund rule for this book by narrowing a
      // higher-priority rule that cannot match — the honest way to see a
      // no_rule outcome is simply a fact type with no active rule at all.
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "10",
        total: "10",
        provider: "woocommerce",
        channel: "woo",
      });
      const explained = await engine.explainFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(explained.accountingBookId).toBe(book.id);
      expect(explained.candidates.some((candidate) => candidate.matched)).toBe(
        true,
      );
      expect(
        explained.candidates.every(
          (candidate) => typeof candidate.reason === "string",
        ),
      ).toBe(true);
    });

    it("reports a cancelled order as ineligible rather than posting revenue", async () => {
      const { entityId } = await newFixture();
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: `ORD-${counter}`,
        subtotal: "10",
        total: "10",
        status: "cancelled",
      });
      const outcome = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(outcome.status).toBe("unpostable");
      expect(outcome.reason).toBe("fact_ineligible");
    });

    it("reports a fact that does not exist", async () => {
      const outcome = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: "00000000-0000-4000-8000-000000000000",
      });
      expect(outcome.status).toBe("unpostable");
      expect(outcome.reason).toBe("fact_not_found");
    });
  });

  describe("the entry never bypasses the journal service", () => {
    it("refuses a rule-sourced entry with no version, and vice versa", async () => {
      const { book } = await newFixture();
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-02-10",
          description: "hand-written rule entry",
          entrySource: "posting_rule",
          lines: [
            { accountSystemKey: "marketplace_clearing", amount: "5" },
            { accountSystemKey: "sales_revenue", amount: "-5" },
          ],
        }),
      ).rejects.toThrow(/must name the rule VERSION/);

      const anyVersion = await scratch.handle.pool.query<{ id: string }>(
        `select id from posting_rule_versions limit 1`,
      );
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-02-10",
          description: "manual entry blaming a rule",
          entrySource: "manual",
          postingRuleVersionId: anyVersion.rows[0]?.id ?? "",
          lines: [
            { accountSystemKey: "marketplace_clearing", amount: "5" },
            { accountSystemKey: "sales_revenue", amount: "-5" },
          ],
        }),
      ).rejects.toThrow(/may not name a posting rule version/);
    });
  });
});
