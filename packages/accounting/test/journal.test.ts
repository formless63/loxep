/**
 * Posting, idempotency, the period gate, immutability, and reversal.
 *
 * The design's pre-implementation checklist asks for the balance test first,
 * the immutability tests alongside it, and the idempotency tests before the
 * posting engine. `ledger-schema.test.ts` covers the database's half; this file
 * covers the service's, plus the behaviours only the service has: routing a
 * child entity's fact into its parent's book, gapless numbering, the
 * authorized backdating path, and reversal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAccountsService,
  createBooksService,
  createFiscalPeriodsService,
  createJournalService,
  createLedgerReports,
  isUniqueViolation,
} from "../src/index.ts";
import {
  auditEventsFor,
  createMigratedScratchDb,
  seedChildEntity,
  seedEntity,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("the journal", () => {
  let scratch: ScratchDb;
  let books: ReturnType<typeof createBooksService>;
  let accounts: ReturnType<typeof createAccountsService>;
  let periods: ReturnType<typeof createFiscalPeriodsService>;
  let journal: ReturnType<typeof createJournalService>;
  let reports: ReturnType<typeof createLedgerReports>;
  let counter = 0;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_journal");
    books = createBooksService({ db: scratch.handle.db });
    accounts = createAccountsService({ db: scratch.handle.db });
    periods = createFiscalPeriodsService({ db: scratch.handle.db });
    journal = createJournalService({ db: scratch.handle.db });
    reports = createLedgerReports({ db: scratch.handle.db });
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function newBook() {
    counter += 1;
    const { book } = await books.createBook({
      code: `JRN-${counter}`,
      name: `Journal ${counter}`,
      openedOn: "2026-01-01",
    });
    return book;
  }

  /** A plain balanced sale: debit clearing, credit revenue. */
  function saleLines(amount: string, economicEntityId?: string) {
    const entity = economicEntityId === undefined ? {} : { economicEntityId };
    return [
      { accountSystemKey: "marketplace_clearing", amount, ...entity },
      { accountSystemKey: "sales_revenue", amount: `-${amount}`, ...entity },
    ];
  }

  describe("posting", () => {
    it("posts a balanced entry, numbering it and stamping its period", async () => {
      const book = await newBook();
      const { entry, lines } = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "eBay sale",
        lines: saleLines("120.50"),
      });

      expect(entry.status).toBe("posted");
      expect(entry.entryNumber).toBe(1);
      expect(entry.postedAt).not.toBeNull();
      expect(entry.isBackdated).toBe(false);
      expect(lines).toHaveLength(2);
      expect(lines[0]?.amount).toBe("120.500000");
      expect(lines[1]?.amount).toBe("-120.500000");
      // The seam, populated rather than null.
      expect(lines[0]?.functionalCurrency).toBe("USD");
      expect(lines[0]?.functionalAmount).toBe("120.500000");
      expect(lines[0]?.fxRate).toBe("1.000000000000");
      expect(lines[0]?.fxRateSource).toBe("unity");

      const period = await periods.getPeriod(entry.fiscalPeriodId ?? "");
      expect(period.periodCode).toBe("FY2026-P03");

      const events = await auditEventsFor(scratch, "accounting.journal.posted");
      expect(events.length).toBeGreaterThan(0);
    });

    it("numbers entries gaplessly per book, and independently across books", async () => {
      const first = await newBook();
      const second = await newBook();
      for (let index = 0; index < 3; index += 1) {
        await journal.postEntry({
          accountingBookId: first.id,
          entryDate: "2026-03-15",
          description: `sale ${index}`,
          lines: saleLines("10"),
        });
      }
      const other = await journal.postEntry({
        accountingBookId: second.id,
        entryDate: "2026-03-15",
        description: "first in another book",
        lines: saleLines("10"),
      });
      const numbers = (await journal.listEntries({ accountingBookId: first.id }))
        .map((entry) => entry.entryNumber);
      expect(numbers).toEqual([1, 2, 3]);
      expect(other.entry.entryNumber).toBe(1);

      const book = await books.getBook(first.id);
      expect(book.nextEntryNumber).toBe(4);
    });

    it("resolves accounts by system key OR by id, and refuses both at once", async () => {
      const book = await newBook();
      const clearing = await accounts.requireSystemAccount(
        book.id,
        "marketplace_clearing",
      );
      const revenue = await accounts.requireSystemAccount(book.id, "sales_revenue");
      const { lines } = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "explicit ids",
        lines: [
          { ledgerAccountId: clearing.id, amount: "5" },
          { ledgerAccountId: revenue.id, amount: "-5" },
        ],
      });
      expect(lines[0]?.ledgerAccountId).toBe(clearing.id);

      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "both",
          lines: [
            {
              ledgerAccountId: clearing.id,
              accountSystemKey: "marketplace_clearing",
              amount: "5",
            },
            { ledgerAccountId: revenue.id, amount: "-5" },
          ],
        }),
      ).rejects.toThrow(/exactly one of ledgerAccountId or accountSystemKey/);
    });

    it("REFUSES an unbalanced entry at the service boundary", async () => {
      const book = await newBook();
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "unbalanced",
          lines: [
            { accountSystemKey: "marketplace_clearing", amount: "100" },
            { accountSystemKey: "sales_revenue", amount: "-90" },
          ],
        }),
      ).rejects.toThrow(/the USD lines sum to 10\.000000 instead of/);
      expect(await journal.listEntries({ accountingBookId: book.id })).toHaveLength(
        0,
      );
    });

    it("refuses a single-line entry with the double-entry explanation", async () => {
      const book = await newBook();
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "one line",
          lines: [{ accountSystemKey: "marketplace_clearing", amount: "100" }],
        }),
      ).rejects.toThrow(/a double-entry needs at least two lines/);
    });

    it("refuses a roll-up header account and an archived account", async () => {
      const book = await newBook();
      const header = (await accounts.listAccounts(book.id)).find(
        (account) => !account.isPostable,
      );
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "header",
          lines: [
            { ledgerAccountId: header?.id ?? "", amount: "10" },
            { accountSystemKey: "sales_revenue", amount: "-10" },
          ],
        }),
      ).rejects.toThrow(/roll-up header and is not postable/);

      const spare = await accounts.createAccount({
        accountingBookId: book.id,
        code: "6420",
        name: "Temporary",
        accountType: "expense",
      });
      await accounts.archiveAccount({ ledgerAccountId: spare.id });
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "archived",
          lines: [
            { ledgerAccountId: spare.id, amount: "10" },
            { accountSystemKey: "sales_revenue", amount: "-10" },
          ],
        }),
      ).rejects.toThrow(/archived and cannot receive new postings/);
    });

    it("refuses an account belonging to another book", async () => {
      const book = await newBook();
      const other = await newBook();
      const foreign = await accounts.requireSystemAccount(other.id, "cogs");
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "cross-book",
          lines: [
            { ledgerAccountId: foreign.id, amount: "10" },
            { accountSystemKey: "sales_revenue", amount: "-10" },
          ],
        }),
      ).rejects.toThrow(/belongs to another book/);
    });

    it("REFUSES a non-USD line, naming the seam", async () => {
      const book = await newBook();
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "GBP sale",
          lines: [
            {
              accountSystemKey: "marketplace_clearing",
              amount: "100",
              currency: "GBP",
            },
            { accountSystemKey: "sales_revenue", amount: "-100", currency: "GBP" },
          ],
        }),
      ).rejects.toThrow(/USD-only by owner decision/);
    });

    it("refuses entry_source = 'posting_rule' while no rule engine exists", async () => {
      const book = await newBook();
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "claims a rule",
          entrySource: "posting_rule" as "manual",
          lines: saleLines("10"),
        }),
      ).rejects.toThrow(/invalid journal entry input/);
    });
  });

  describe("idempotency", () => {
    it("posts once for the same posting key, twice", async () => {
      const book = await newBook();
      const key = "pr:order_sale:v1:order:9f1c1a2e";
      const first = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "eBay sale",
        postingKey: key,
        sourceFactType: "order",
        sourceFactId: "9f1c1a2e-0000-4000-8000-000000000001",
        lines: saleLines("42"),
      });
      const second = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "eBay sale",
        postingKey: key,
        sourceFactType: "order",
        sourceFactId: "9f1c1a2e-0000-4000-8000-000000000001",
        lines: saleLines("42"),
      });

      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(second.entry.id).toBe(first.entry.id);
      expect(
        await journal.listEntries({ accountingBookId: book.id }),
      ).toHaveLength(1);

      const trial = await reports.trialBalance(book.id);
      expect(trial.difference).toBe("0.000000");
    });

    it("posts a SECOND entry under a different key for the same fact — the re-post path", async () => {
      const book = await newBook();
      const fact = "9f1c1a2e-0000-4000-8000-000000000002";
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "under rule v1",
        postingKey: `pr:order_sale:v1:order:${fact}`,
        sourceFactType: "order",
        sourceFactId: fact,
        lines: saleLines("10"),
      });
      const repost = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-16",
        description: "under rule v2",
        postingKey: `pr:order_sale:v2:order:${fact}`,
        sourceFactType: "order",
        sourceFactId: fact,
        lines: saleLines("12"),
      });
      // The version inside the key is what stops a deliberate re-post from
      // being silently swallowed by the idempotency unique.
      expect(repost.reused).toBe(false);
      const forFact = await journal.findBySourceFact("order", fact);
      expect(forFact).toHaveLength(2);
    });

    it("finds an entry by posting key and by source fact, with no foreign key involved", async () => {
      const book = await newBook();
      const fact = "9f1c1a2e-0000-4000-8000-000000000003";
      const key = `pr:expense:v1:expense:${fact}`;
      await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "expense posting",
        postingKey: key,
        sourceFactType: "expense",
        sourceFactId: fact,
        lines: [
          { accountSystemKey: "shipping_expense", amount: "30" },
          { accountSystemKey: "undeposited_funds", amount: "-30" },
        ],
      });
      expect((await journal.findByPostingKey(key))?.postingKey).toBe(key);
      expect(await journal.findBySourceFact("expense", fact)).toHaveLength(1);
    });

    it("refuses a half-written source-fact stamp", async () => {
      const book = await newBook();
      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "half stamped",
          sourceFactType: "order",
          lines: saleLines("10"),
        }),
      ).rejects.toThrow(/both a type and an id or neither/);
    });
  });

  describe("routing", () => {
    it("routes a CHILD entity's fact into its parent's book (the roll-up)", async () => {
      const book = await newBook();
      const parentId = await seedEntity(scratch, "Parent Holdings");
      const childId = await seedChildEntity(scratch, "Assumed Name", parentId);
      await books.linkEntity({
        accountingBookId: book.id,
        economicEntityId: parentId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });

      const { entry, routing, lines } = await journal.postEntry({
        economicEntityId: childId,
        entryDate: "2026-04-10",
        description: "DBA sale",
        lines: saleLines("75", childId),
      });

      expect(entry.accountingBookId).toBe(book.id);
      expect(routing?.source).toBe("parent_entity_link");
      expect(routing?.viaEconomicEntityId).toBe(parentId);
      // The child's own totals stay visible: the line carries the DBA, so the
      // per-entity view is a reporting slice rather than a separate ledger.
      expect(lines.every((line) => line.economicEntityId === childId)).toBe(true);
    });

    it("refuses to post a fact nobody has given accounting ownership", async () => {
      const orphan = await seedEntity(scratch, "Nobody's Entity");
      await expect(
        journal.postEntry({
          economicEntityId: orphan,
          entryDate: "2026-04-10",
          description: "orphan",
          lines: saleLines("10", orphan),
        }),
      ).rejects.toThrow(/unpostable backlog/);
    });

    it("uses the installation default book for an entity-less fact", async () => {
      const book = await newBook();
      const { entry, routing } = await journal.postEntry({
        installationDefaultBookId: book.id,
        entryDate: "2026-04-10",
        description: "installation-level bank fee",
        lines: [
          { accountSystemKey: "payment_processing_fees", amount: "3" },
          { accountSystemKey: "undeposited_funds", amount: "-3" },
        ],
      });
      expect(entry.accountingBookId).toBe(book.id);
      expect(routing?.source).toBe("installation_default");
    });
  });

  describe("the period gate", () => {
    it("refuses posting into a closed period and into an ungenerated month", async () => {
      const book = await newBook();
      const may = await periods.requirePeriod(book.id, "2026-05-10");
      await periods.setStatus({ fiscalPeriodId: may.id, status: "closed" });

      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-05-10",
          description: "into a closed month",
          lines: saleLines("10"),
        }),
      ).rejects.toThrow(/is closed: posting into it is blocked/);

      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2030-05-10",
          description: "into a month that has no period",
          lines: saleLines("10"),
        }),
      ).rejects.toThrow(/no fiscal period contains 2030-05-10/);
    });

    it("refuses an ordinary posting into soft_closed, and flags an authorized one", async () => {
      const book = await newBook();
      const june = await periods.requirePeriod(book.id, "2026-06-10");
      await periods.setStatus({ fiscalPeriodId: june.id, status: "soft_closed" });

      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-06-10",
          description: "ordinary",
          lines: saleLines("10"),
        }),
      ).rejects.toThrow(/soft_closed: ordinary posting is blocked/);

      const { entry } = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-06-10",
        description: "late final-value fee adjustment",
        allowBackdated: true,
        lines: [
          { accountSystemKey: "marketplace_fees", amount: "4.25" },
          { accountSystemKey: "marketplace_clearing", amount: "-4.25" },
        ],
      });
      // The flag is the point: the restatement is visible rather than silent.
      expect(entry.isBackdated).toBe(true);
    });
  });

  describe("drafts", () => {
    it("holds an unbalanced draft, then refuses to post it", async () => {
      const book = await newBook();
      const { entry } = await journal.createDraft({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "half typed",
        lines: [{ accountSystemKey: "marketplace_clearing", amount: "100" }],
      });
      expect(entry.status).toBe("draft");
      expect(entry.entryNumber).toBeNull();
      await expect(
        journal.postDraft({ journalEntryId: entry.id }),
      ).rejects.toThrow(/a double-entry needs at least two lines/);
    });

    it("posts a completed draft", async () => {
      const book = await newBook();
      const { entry } = await journal.createDraft({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "typed in full",
        lines: saleLines("60"),
      });
      const posted = await journal.postDraft({ journalEntryId: entry.id });
      expect(posted.entry.status).toBe("posted");
      expect(posted.entry.entryNumber).toBe(1);
      await expect(
        journal.postDraft({ journalEntryId: entry.id }),
      ).rejects.toThrow(/not a draft/);
    });

    it("voids a draft, keeps the row, and refuses to void a posted entry", async () => {
      const book = await newBook();
      const { entry } = await journal.createDraft({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "abandoned",
        lines: saleLines("11"),
      });
      const voided = await journal.voidDraft({
        journalEntryId: entry.id,
        reason: "typed into the wrong book",
      });
      expect(voided.status).toBe("void");

      const posted = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "real",
        lines: saleLines("11"),
      });
      await expect(
        journal.voidDraft({
          journalEntryId: posted.entry.id,
          reason: "changed my mind",
        }),
      ).rejects.toThrow(/never voided, it is reversed/);
    });

    it("requires a reason to void", async () => {
      const book = await newBook();
      const { entry } = await journal.createDraft({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "abandoned",
        lines: saleLines("11"),
      });
      await expect(
        journal.voidDraft({ journalEntryId: entry.id, reason: "   " }),
      ).rejects.toThrow(/requires a reason/);
    });
  });

  describe("reversal", () => {
    it("reverses a posted entry into a linked, negated, netting entry", async () => {
      const book = await newBook();
      const original = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "eBay sale",
        postingKey: "pr:order_sale:v1:order:aaaa",
        sourceFactType: "order",
        sourceFactId: "aaaaaaaa-0000-4000-8000-000000000001",
        lines: saleLines("100"),
      });

      const reversal = await journal.reverseEntry({
        journalEntryId: original.entry.id,
        reason: "the order was cancelled",
      });

      expect(reversal.entry.reversesEntryId).toBe(original.entry.id);
      expect(reversal.entry.status).toBe("posted");
      expect(reversal.entry.entryNumber).toBe(2);
      expect(reversal.entry.postingKey).toBe("rev:pr:order_sale:v1:order:aaaa");
      expect(reversal.lines.map((line) => line.amount)).toEqual([
        "-100.000000",
        "100.000000",
      ]);

      const stamped = await journal.getEntry(original.entry.id);
      expect(stamped.status).toBe("reversed");
      // The original's lines are untouched and still count; the reversal's own
      // lines are what net them out.
      const originalLines = await journal.getLines(original.entry.id);
      expect(originalLines.map((line) => line.amount)).toEqual([
        "100.000000",
        "-100.000000",
      ]);

      const clearing = await reports.accountBalance({
        accountingBookId: book.id,
        systemKey: "marketplace_clearing",
      });
      expect(clearing.balance).toBe("0.000000");

      const events = await auditEventsFor(scratch, "accounting.journal.reversed");
      expect(events.length).toBeGreaterThan(0);
    });

    it("is idempotent — a retried reversal returns the first one", async () => {
      const book = await newBook();
      const original = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "sale",
        lines: saleLines("50"),
      });
      const first = await journal.reverseEntry({
        journalEntryId: original.entry.id,
        reason: "duplicate ingestion",
      });
      const retried = await journal.reverseEntry({
        journalEntryId: original.entry.id,
        reason: "duplicate ingestion",
      });
      expect(retried.reused).toBe(true);
      expect(retried.entry.id).toBe(first.entry.id);
      expect(
        await journal.listEntries({ accountingBookId: book.id }),
      ).toHaveLength(2);
    });

    it("REFUSES to reverse a reversal (PROVISIONAL)", async () => {
      const book = await newBook();
      const original = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "sale",
        lines: saleLines("50"),
      });
      const reversal = await journal.reverseEntry({
        journalEntryId: original.entry.id,
        reason: "wrong amount",
      });
      await expect(
        journal.reverseEntry({
          journalEntryId: reversal.entry.id,
          reason: "undo the undo",
        }),
      ).rejects.toThrow(/itself a reversal and may not be reversed/);
    });

    it("refuses to reverse a draft or a void entry", async () => {
      const book = await newBook();
      const { entry } = await journal.createDraft({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "draft",
        lines: saleLines("10"),
      });
      await expect(
        journal.reverseEntry({ journalEntryId: entry.id, reason: "nope" }),
      ).rejects.toThrow(/has not been posted/);
    });

    it("lands the correction in a LATER open period when the original's month is shut", async () => {
      const book = await newBook();
      const original = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-07-15",
        description: "July sale",
        lines: saleLines("80"),
      });
      const july = await periods.requirePeriod(book.id, "2026-07-15");
      await periods.setStatus({ fiscalPeriodId: july.id, status: "closed" });

      // Reversing into its own month is refused …
      await expect(
        journal.reverseEntry({
          journalEntryId: original.entry.id,
          reason: "cancelled in August",
        }),
      ).rejects.toThrow(/is closed: posting into it is blocked/);

      // … and reversal-and-repost degrades gracefully to the current period,
      // which is what an accountant would do by hand.
      const reversal = await journal.reverseEntry({
        journalEntryId: original.entry.id,
        entryDate: "2026-08-03",
        reason: "cancelled in August",
      });
      expect(reversal.entry.entryDate).toBe("2026-08-03");
      const august = await periods.requirePeriod(book.id, "2026-08-03");
      expect(reversal.entry.fiscalPeriodId).toBe(august.id);

      const trial = await reports.trialBalance(book.id);
      expect(trial.difference).toBe("0.000000");
    });

    it("requires a reason", async () => {
      const book = await newBook();
      const original = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "sale",
        lines: saleLines("10"),
      });
      await expect(
        journal.reverseEntry({ journalEntryId: original.entry.id, reason: "" }),
      ).rejects.toThrow(/requires a reason/);
    });
  });

  describe("required dimensions", () => {
    it("blocks posting a line missing a required dimension, and accepts a tagged one", async () => {
      const book = await newBook();
      const dimension = await scratch.handle.pool.query<{ id: string }>(
        `insert into accounting_dimensions
           (accounting_book_id, code, name, is_required)
         values ($1, 'department', 'Department', true) returning id`,
        [book.id],
      );
      const dimensionId = dimension.rows[0]?.id as string;
      const value = await scratch.handle.pool.query<{ id: string }>(
        `insert into accounting_dimension_values (dimension_id, code, name)
         values ($1, 'resale', 'Resale') returning id`,
        [dimensionId],
      );
      const dimensionValueId = value.rows[0]?.id as string;

      await expect(
        journal.postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "untagged",
          lines: saleLines("20"),
        }),
      ).rejects.toThrow(/missing required dimension "department"/);

      const tagged = await journal.postEntry({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "tagged",
        lines: [
          {
            accountSystemKey: "marketplace_clearing",
            amount: "20",
            dimensions: [{ dimensionId, dimensionValueId }],
          },
          {
            accountSystemKey: "sales_revenue",
            amount: "-20",
            dimensions: [{ dimensionId, dimensionValueId }],
          },
        ],
      });
      expect(tagged.entry.status).toBe("posted");

      const tags = await scratch.handle.pool.query(
        `select 1 from journal_line_dimensions d
           join journal_lines l on l.id = d.journal_line_id
          where l.journal_entry_id = $1`,
        [tagged.entry.id],
      );
      expect(tags.rowCount).toBe(2);

      // A draft may legitimately lack them while it is being built.
      const draft = await journal.createDraft({
        accountingBookId: book.id,
        entryDate: "2026-03-15",
        description: "untagged draft",
        lines: saleLines("20"),
      });
      expect(draft.entry.status).toBe("draft");
    });

    it("refuses two values of one dimension on one line", async () => {
      const book = await newBook();
      const dimension = await scratch.handle.pool.query<{ id: string }>(
        `insert into accounting_dimensions (accounting_book_id, code, name)
         values ($1, 'class', 'Class') returning id`,
        [book.id],
      );
      const dimensionId = dimension.rows[0]?.id as string;
      const values = await scratch.handle.pool.query<{ id: string }>(
        `insert into accounting_dimension_values (dimension_id, code, name)
         values ($1, 'a', 'A'), ($1, 'b', 'B') returning id`,
        [dimensionId],
      );
      const failure = await journal
        .postEntry({
          accountingBookId: book.id,
          entryDate: "2026-03-15",
          description: "double tagged",
          lines: [
            {
              accountSystemKey: "marketplace_clearing",
              amount: "20",
              dimensions: [
                { dimensionId, dimensionValueId: values.rows[0]?.id as string },
                { dimensionId, dimensionValueId: values.rows[1]?.id as string },
              ],
            },
            { accountSystemKey: "sales_revenue", amount: "-20" },
          ],
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      // The composite primary key is the whole semantic content of "a
      // dimension": without it a line could carry two departments and every
      // report would double-count.
      expect(isUniqueViolation(failure)).toBe(true);
    });
  });
});
