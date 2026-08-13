/**
 * Books, the chart of accounts, and the routing rule — through the services.
 *
 * The owner's first answer is the subject of most of this file: books are
 * toggleable per entity, a child entity's posting book IS its parent's book,
 * and per-entity views are reporting slices rather than separate ledgers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CHART_TEMPLATE,
  createAccountsService,
  createBooksService,
  isUniqueViolation,
  normalBalanceOf,
} from "../src/index.ts";
import { LEDGER_SYSTEM_KEYS } from "@loxep/db/schema";
import {
  auditEventsFor,
  createMigratedScratchDb,
  seedChildEntity,
  seedEntity,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("books, chart, and routing", () => {
  let scratch: ScratchDb;
  let books: ReturnType<typeof createBooksService>;
  let accounts: ReturnType<typeof createAccountsService>;
  let bookCounter = 0;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_books");
    books = createBooksService({ db: scratch.handle.db });
    accounts = createAccountsService({ db: scratch.handle.db });
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function newBook(overrides: Record<string, unknown> = {}) {
    bookCounter += 1;
    return books.createBook({
      code: `BOOK-${bookCounter}`,
      name: `Book ${bookCounter}`,
      openedOn: "2026-01-01",
      ...overrides,
    });
  }

  describe("createBook", () => {
    it("creates a book with a seeded chart and one fiscal year of periods", async () => {
      const { book, accountCount, periodCount } = await newBook();
      expect(book.functionalCurrency).toBe("USD");
      expect(book.accountingBasis).toBe("accrual");
      expect(book.nextEntryNumber).toBe(1);
      expect(accountCount).toBe(DEFAULT_CHART_TEMPLATE.length);
      expect(periodCount).toBe(12);

      const events = await auditEventsFor(scratch, "accounting.book.created");
      expect(events.length).toBeGreaterThan(0);
    });

    it("seeds EVERY system key exactly once — a rule resolving a missing key is a silent suspense posting", async () => {
      const { book } = await newBook();
      const seeded = await accounts.listAccounts(book.id);
      const keys = seeded
        .map((account) => account.systemKey)
        .filter((key): key is string => key !== null);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.sort()).toEqual([...LEDGER_SYSTEM_KEYS].sort());
    });

    it("gives the chart a hierarchy whose headers are not postable", async () => {
      const { book } = await newBook();
      const seeded = await accounts.listAccounts(book.id);
      const headers = seeded.filter((account) => !account.isPostable);
      expect(headers.length).toBeGreaterThan(0);
      for (const header of headers) {
        expect(header.systemKey).toBeNull();
      }
      const revenue = seeded.find((account) => account.systemKey === "sales_revenue");
      expect(revenue?.parentAccountId).not.toBeNull();
      expect(revenue?.accountType).toBe("revenue");
    });

    it("carries BOTH fee sides, per the ratified fee_direction reading", async () => {
      const { book } = await newBook();
      const fees = await accounts.requireSystemAccount(book.id, "marketplace_fees");
      const buyerFees = await accounts.requireSystemAccount(
        book.id,
        "buyer_fee_income",
      );
      // seller_charge is a deduction from proceeds; buyer_surcharge is money the
      // buyer paid and is already inside the order total.
      expect(fees.accountType).toBe("expense");
      expect(buyerFees.accountType).toBe("revenue");
    });

    it("marks sales returns as contra revenue, and computes its normal balance", async () => {
      const { book } = await newBook();
      const returns = await accounts.requireSystemAccount(book.id, "sales_returns");
      expect(returns.accountType).toBe("revenue");
      expect(returns.isContra).toBe(true);
      expect(normalBalanceOf("revenue", false)).toBe("credit");
      expect(normalBalanceOf("revenue", true)).toBe("debit");
      expect(normalBalanceOf("asset", false)).toBe("debit");
      expect(normalBalanceOf("expense", false)).toBe("debit");
    });

    it("REFUSES a non-USD book, naming the seam", async () => {
      await expect(
        newBook({ functionalCurrency: "EUR" }),
      ).rejects.toThrow(/USD-only by owner decision/);
      await expect(newBook({ functionalCurrency: "EUR" })).rejects.toThrow(
        /functional_amount/,
      );
    });

    it("honours a non-January fiscal year, contiguously and without gaps", async () => {
      const { book, periodCount } = await newBook({
        fiscalYearStartMonth: 7,
        fiscalYearStartDay: 1,
        openedOn: "2026-08-15",
      });
      expect(periodCount).toBe(12);
      const periods = await scratch.handle.pool.query<{
        starts_on: string;
        ends_on: string;
        fiscal_year: number;
        period_code: string;
      }>(
        `select starts_on::text, ends_on::text, fiscal_year, period_code
           from fiscal_periods where accounting_book_id = $1 order by sequence`,
        [book.id],
      );
      expect(periods.rows[0]?.starts_on).toBe("2026-07-01");
      expect(periods.rows[0]?.period_code).toBe("FY2026-P01");
      expect(periods.rows[11]?.ends_on).toBe("2027-06-30");
      for (let index = 1; index < periods.rows.length; index += 1) {
        const previousEnd = new Date(
          `${periods.rows[index - 1]?.ends_on}T00:00:00Z`,
        );
        const currentStart = new Date(
          `${periods.rows[index]?.starts_on}T00:00:00Z`,
        );
        expect(currentStart.getTime() - previousEnd.getTime()).toBe(86_400_000);
      }
    });

    it("can be created bare, with neither chart nor periods", async () => {
      const { book, accountCount, periodCount } = await newBook({
        seedChart: false,
        generatePeriods: false,
      });
      expect(accountCount).toBe(0);
      expect(periodCount).toBe(0);
      const seeded = await accounts.listAccounts(book.id);
      expect(seeded).toHaveLength(0);
    });

    it("refuses a duplicate book code", async () => {
      const { book } = await newBook();
      // Drizzle wraps the driver error, so the constraint name is on the cause
      // rather than the message — assert the CODE, which is the stable part.
      const failure = await books
        .createBook({
          code: book.code,
          name: "Duplicate",
          openedOn: "2026-01-01",
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).not.toBeNull();
      expect(isUniqueViolation(failure)).toBe(true);
    });
  });

  describe("the chart of accounts", () => {
    it("re-seeds idempotently", async () => {
      const { book } = await newBook();
      const again = await accounts.seedDefaultChart({ accountingBookId: book.id });
      expect(again).toHaveLength(DEFAULT_CHART_TEMPLATE.length);
      const rows = await accounts.listAccounts(book.id);
      expect(rows).toHaveLength(DEFAULT_CHART_TEMPLATE.length);
    });

    it("lets an operator re-code and rename a SYSTEM account freely", async () => {
      const { book } = await newBook();
      const clearing = await accounts.requireSystemAccount(
        book.id,
        "marketplace_clearing",
      );
      const renamed = await accounts.updateAccount({
        ledgerAccountId: clearing.id,
        code: "1150",
        name: "eBay Money Owed To Us",
      });
      expect(renamed.code).toBe("1150");
      expect(renamed.name).toBe("eBay Money Owed To Us");
      // The handle is untouched, so every shipped rule still resolves.
      expect(renamed.systemKey).toBe("marketplace_clearing");
      expect(renamed.accountType).toBe(clearing.accountType);
      const resolved = await accounts.requireSystemAccount(
        book.id,
        "marketplace_clearing",
      );
      expect(resolved.id).toBe(clearing.id);
    });

    it("REFUSES to archive a system account", async () => {
      const { book } = await newBook();
      const cogs = await accounts.requireSystemAccount(book.id, "cogs");
      await expect(
        accounts.archiveAccount({ ledgerAccountId: cogs.id }),
      ).rejects.toThrow(/may not be archived/);
    });

    it("archives and reactivates an ordinary account", async () => {
      const { book } = await newBook();
      const created = await accounts.createAccount({
        accountingBookId: book.id,
        code: "6410",
        name: "Shipping Supplies",
        accountType: "expense",
      });
      const archived = await accounts.archiveAccount({
        ledgerAccountId: created.id,
      });
      expect(archived.status).toBe("archived");
      expect(await accounts.listAccounts(book.id)).not.toContainEqual(
        expect.objectContaining({ id: created.id }),
      );
      const restored = await accounts.reactivateAccount({
        ledgerAccountId: created.id,
      });
      expect(restored.status).toBe("active");
    });

    it("refuses an invented system key", async () => {
      const { book } = await newBook();
      await expect(
        accounts.createAccount({
          accountingBookId: book.id,
          code: "6999",
          name: "Invented",
          accountType: "expense",
          // TypeScript refuses this too; the cast is what lets the test prove
          // the RUNTIME guard exists for callers that are not typed.
          systemKey: "marketplace_kickbacks" as "suspense",
        }),
      ).rejects.toThrow(/invalid account input/);
    });

    it("refuses a parent account from another book", async () => {
      const first = await newBook();
      const second = await newBook();
      const foreignParent = (
        await accounts.listAccounts(second.book.id)
      )[0];
      await expect(
        accounts.createAccount({
          accountingBookId: first.book.id,
          code: "1234",
          name: "Cross-book child",
          accountType: "asset",
          parentAccountId: foreignParent?.id ?? "",
        }),
      ).rejects.toThrow(/belongs to another book/);
    });

    it("refuses making an account a header once it carries lines", async () => {
      const { book } = await newBook();
      const cash = await accounts.requireSystemAccount(book.id, "undeposited_funds");
      const revenue = await accounts.requireSystemAccount(book.id, "sales_revenue");
      const period = await scratch.handle.pool.query<{ id: string }>(
        `select id from fiscal_periods where accounting_book_id = $1 order by sequence limit 1`,
        [book.id],
      );
      const client = await scratch.handle.pool.connect();
      try {
        await client.query("begin");
        const entry = await client.query<{ id: string }>(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description)
           values ($1, '2026-01-05', 'manual', 'seed activity') returning id`,
          [book.id],
        );
        const entryId = entry.rows[0]?.id as string;
        await client.query(
          `insert into journal_lines
             (journal_entry_id, accounting_book_id, ledger_account_id, line_number,
              currency, amount, functional_currency, functional_amount)
           values ($1, $2, $3, 1, 'USD', 10, 'USD', 10),
                  ($1, $2, $4, 2, 'USD', -10, 'USD', -10)`,
          [entryId, book.id, cash.id, revenue.id],
        );
        await client.query(
          `update journal_entries set status = 'posted', entry_number = 1,
                  fiscal_period_id = $2, posted_at = now() where id = $1`,
          [entryId, period.rows[0]?.id],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      await expect(
        accounts.updateAccount({
          ledgerAccountId: cash.id,
          isPostable: false,
        }),
      ).rejects.toThrow(/already carries journal lines/);
    });
  });

  describe("book/entity links and the roll-up rule", () => {
    it("links a top-level entity as posting_primary", async () => {
      const { book } = await newBook();
      const entityId = await seedEntity(scratch, "Acme LLC");
      const link = await books.linkEntity({
        accountingBookId: book.id,
        economicEntityId: entityId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
        dimensionLabel: "Acme",
      });
      expect(link.linkRole).toBe("posting_primary");
      expect(link.effectiveTo).toBeNull();
      const events = await auditEventsFor(
        scratch,
        "accounting.book.entity_linked",
      );
      expect(events.length).toBeGreaterThan(0);
    });

    it("REFUSES a child entity posting to a book other than its parent's", async () => {
      const parentBook = await newBook();
      const otherBook = await newBook();
      const parentId = await seedEntity(scratch, "Parent Co");
      const childId = await seedChildEntity(scratch, "Route 9 Vintage", parentId);
      await books.linkEntity({
        accountingBookId: parentBook.book.id,
        economicEntityId: parentId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });
      await expect(
        books.linkEntity({
          accountingBookId: otherBook.book.id,
          economicEntityId: childId,
          linkRole: "posting_primary",
          effectiveFrom: "2026-01-01",
        }),
      ).rejects.toThrow(/is part of another economic entity/);
    });

    it("PERMITS a child entity linked to its parent's own book, and a reporting_only link elsewhere", async () => {
      const parentBook = await newBook();
      const otherBook = await newBook();
      const parentId = await seedEntity(scratch, "Parent Two");
      const childId = await seedChildEntity(scratch, "DBA Two", parentId);
      await books.linkEntity({
        accountingBookId: parentBook.book.id,
        economicEntityId: parentId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });
      const sameBook = await books.linkEntity({
        accountingBookId: parentBook.book.id,
        economicEntityId: childId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });
      expect(sameBook.accountingBookId).toBe(parentBook.book.id);
      const reporting = await books.linkEntity({
        accountingBookId: otherBook.book.id,
        economicEntityId: childId,
        linkRole: "reporting_only",
        effectiveFrom: "2026-01-01",
      });
      expect(reporting.linkRole).toBe("reporting_only");
    });

    it("REFUSES a parent link that would split an existing child's book", async () => {
      const childBook = await newBook();
      const parentBook = await newBook();
      const parentId = await seedEntity(scratch, "Parent Three");
      const childId = await seedChildEntity(scratch, "DBA Three", parentId);
      // The child is linked first — an ordering an operator will hit.
      await books.linkEntity({
        accountingBookId: childBook.book.id,
        economicEntityId: childId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });
      await expect(
        books.linkEntity({
          accountingBookId: parentBook.book.id,
          economicEntityId: parentId,
          linkRole: "posting_primary",
          effectiveFrom: "2026-01-01",
        }),
      ).rejects.toThrow(/cannot post to book .* while its part/);
    });

    it("refuses an overlapping second primary book with the date-boundary explanation", async () => {
      const first = await newBook();
      const second = await newBook();
      const entityId = await seedEntity(scratch, "Overlap LLC");
      await books.linkEntity({
        accountingBookId: first.book.id,
        economicEntityId: entityId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });
      await expect(
        books.linkEntity({
          accountingBookId: second.book.id,
          economicEntityId: entityId,
          linkRole: "posting_primary",
          effectiveFrom: "2026-06-01",
        }),
      ).rejects.toThrow(/at most one primary book per entity per day/i);
    });

    it("moves an entity between books at a date boundary without rewriting history", async () => {
      const first = await newBook();
      const second = await newBook();
      const entityId = await seedEntity(scratch, "Spun Out LLC");
      const original = await books.linkEntity({
        accountingBookId: first.book.id,
        economicEntityId: entityId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });
      await books.endLink({
        bookEntityLinkId: original.id,
        effectiveTo: "2026-06-30",
      });
      await books.linkEntity({
        accountingBookId: second.book.id,
        economicEntityId: entityId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-07-01",
      });

      const before = await books.resolveBookForEntity({
        economicEntityId: entityId,
        onDate: "2026-03-15",
      });
      const after = await books.resolveBookForEntity({
        economicEntityId: entityId,
        onDate: "2026-08-15",
      });
      expect(before?.accountingBookId).toBe(first.book.id);
      expect(after?.accountingBookId).toBe(second.book.id);
    });
  });

  describe("routing", () => {
    it("routes an entity's own link, a child through its parent, and a default book", async () => {
      const main = await newBook();
      const fallback = await newBook();
      const parentId = await seedEntity(scratch, "Routing Parent");
      const childId = await seedChildEntity(scratch, "Routing DBA", parentId);
      const grandchildId = await seedChildEntity(
        scratch,
        "Routing Sub-DBA",
        childId,
      );
      await books.linkEntity({
        accountingBookId: main.book.id,
        economicEntityId: parentId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });

      const direct = await books.resolveBookForEntity({
        economicEntityId: parentId,
        onDate: "2026-03-01",
      });
      expect(direct).toEqual({
        accountingBookId: main.book.id,
        source: "entity_link",
        viaEconomicEntityId: null,
      });

      // The roll-up: a DBA's facts land in the parent company's book.
      const rolledUp = await books.resolveBookForEntity({
        economicEntityId: childId,
        onDate: "2026-03-01",
      });
      expect(rolledUp).toEqual({
        accountingBookId: main.book.id,
        source: "parent_entity_link",
        viaEconomicEntityId: parentId,
      });

      // And through two levels, because "part of" is transitive.
      const deep = await books.resolveBookForEntity({
        economicEntityId: grandchildId,
        onDate: "2026-03-01",
      });
      expect(deep?.accountingBookId).toBe(main.book.id);

      const defaulted = await books.resolveBookForEntity({
        economicEntityId: null,
        onDate: "2026-03-01",
        installationDefaultBookId: fallback.book.id,
      });
      expect(defaulted).toEqual({
        accountingBookId: fallback.book.id,
        source: "installation_default",
        viaEconomicEntityId: null,
      });
    });

    it("returns null — the unpostable backlog — rather than guessing", async () => {
      const orphanId = await seedEntity(scratch, "Unlinked LLC");
      expect(
        await books.resolveBookForEntity({
          economicEntityId: orphanId,
          onDate: "2026-03-01",
        }),
      ).toBeNull();
      expect(
        await books.resolveBookForEntity({
          economicEntityId: null,
          onDate: "2026-03-01",
        }),
      ).toBeNull();
      await expect(
        books.requireBookForEntity({
          economicEntityId: orphanId,
          onDate: "2026-03-01",
        }),
      ).rejects.toThrow(/unpostable backlog/);
    });

    it("does not route outside the link's effective range", async () => {
      const { book } = await newBook();
      const entityId = await seedEntity(scratch, "Windowed LLC");
      await books.linkEntity({
        accountingBookId: book.id,
        economicEntityId: entityId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-02-01",
        effectiveTo: "2026-02-28",
      });
      expect(
        await books.resolveBookForEntity({
          economicEntityId: entityId,
          onDate: "2026-02-15",
        }),
      ).not.toBeNull();
      expect(
        await books.resolveBookForEntity({
          economicEntityId: entityId,
          onDate: "2026-03-01",
        }),
      ).toBeNull();
    });

    it("never routes through a reporting_only link", async () => {
      const { book } = await newBook();
      const entityId = await seedEntity(scratch, "Reporting Only LLC");
      await books.linkEntity({
        accountingBookId: book.id,
        economicEntityId: entityId,
        linkRole: "reporting_only",
        effectiveFrom: "2026-01-01",
      });
      expect(
        await books.resolveBookForEntity({
          economicEntityId: entityId,
          onDate: "2026-03-01",
        }),
      ).toBeNull();
    });

    it("terminates on a cyclic parent chain instead of hanging", async () => {
      const first = await seedEntity(scratch, "Cycle A");
      const second = await seedChildEntity(scratch, "Cycle B", first);
      await scratch.handle.pool.query(
        `update economic_entities set parent_entity_id = $2 where id = $1`,
        [first, second],
      );
      expect(
        await books.resolveBookForEntity({
          economicEntityId: first,
          onDate: "2026-03-01",
        }),
      ).toBeNull();
    });
  });
});
