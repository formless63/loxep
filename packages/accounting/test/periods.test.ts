/**
 * Fiscal-period generation and the four-state close, through the service.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBooksService,
  createFiscalPeriodsService,
  fiscalYearFor,
  fiscalYearStartDate,
  periodCodeFor,
} from "../src/index.ts";
import {
  auditEventsFor,
  createMigratedScratchDb,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("fiscal periods", () => {
  let scratch: ScratchDb;
  let books: ReturnType<typeof createBooksService>;
  let periods: ReturnType<typeof createFiscalPeriodsService>;
  let counter = 0;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_periods");
    books = createBooksService({ db: scratch.handle.db });
    periods = createFiscalPeriodsService({ db: scratch.handle.db });
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function newBook(overrides: Record<string, unknown> = {}) {
    counter += 1;
    const { book } = await books.createBook({
      code: `PER-${counter}`,
      name: `Periods ${counter}`,
      openedOn: "2026-01-01",
      seedChart: false,
      ...overrides,
    });
    return book;
  }

  describe("date helpers", () => {
    it("clamps a fiscal-year start day into the month", () => {
      expect(fiscalYearStartDate(2026, 1, 1)).toBe("2026-01-01");
      expect(fiscalYearStartDate(2026, 2, 31)).toBe("2026-02-28");
      expect(fiscalYearStartDate(2028, 2, 30)).toBe("2028-02-29");
      expect(fiscalYearStartDate(2026, 7, 1)).toBe("2026-07-01");
    });

    it("labels a fiscal year by the calendar year it STARTS in (PROVISIONAL)", () => {
      expect(fiscalYearFor("2026-08-15", 7, 1)).toBe(2026);
      expect(fiscalYearFor("2027-06-30", 7, 1)).toBe(2026);
      expect(fiscalYearFor("2027-07-01", 7, 1)).toBe(2027);
      expect(fiscalYearFor("2026-01-01", 1, 1)).toBe(2026);
      expect(fiscalYearFor("2025-12-31", 1, 1)).toBe(2025);
    });

    it("formats a period code", () => {
      expect(periodCodeFor(2026, 1)).toBe("FY2026-P01");
      expect(periodCodeFor(2026, 12)).toBe("FY2026-P12");
    });
  });

  describe("generation", () => {
    it("generates twelve contiguous monthly periods covering the year", async () => {
      const book = await newBook({ generatePeriods: false });
      const { created, periods: rows } = await periods.generateFiscalYear({
        accountingBookId: book.id,
        fiscalYear: 2026,
      });
      expect(created).toBe(12);
      expect(rows[0]?.startsOn).toBe("2026-01-01");
      expect(rows[0]?.endsOn).toBe("2026-01-31");
      expect(rows[11]?.startsOn).toBe("2026-12-01");
      expect(rows[11]?.endsOn).toBe("2026-12-31");
    });

    it("is idempotent — the button gets pressed twice", async () => {
      const book = await newBook({ generatePeriods: false });
      await periods.generateFiscalYear({
        accountingBookId: book.id,
        fiscalYear: 2026,
      });
      const second = await periods.generateFiscalYear({
        accountingBookId: book.id,
        fiscalYear: 2026,
      });
      expect(second.created).toBe(0);
      expect(second.periods).toHaveLength(12);
    });

    it("extends forward into the next fiscal year without overlapping", async () => {
      const book = await newBook();
      const next = await periods.generateFiscalYear({
        accountingBookId: book.id,
        fiscalYear: 2027,
      });
      expect(next.created).toBe(12);
      const all = await periods.listPeriods(book.id);
      expect(all).toHaveLength(24);
    });

    it("survives a month-end anchor: 31 Jan produces contiguous, non-overlapping periods", async () => {
      const book = await newBook({
        fiscalYearStartMonth: 1,
        fiscalYearStartDay: 31,
        generatePeriods: false,
      });
      const { periods: rows } = await periods.generateFiscalYear({
        accountingBookId: book.id,
        fiscalYear: 2026,
      });
      expect(rows[0]?.startsOn).toBe("2026-01-31");
      expect(rows[0]?.endsOn).toBe("2026-02-27");
      expect(rows[1]?.startsOn).toBe("2026-02-28");
      for (let index = 1; index < rows.length; index += 1) {
        const previous = new Date(`${rows[index - 1]?.endsOn}T00:00:00Z`);
        const current = new Date(`${rows[index]?.startsOn}T00:00:00Z`);
        expect(current.getTime() - previous.getTime()).toBe(86_400_000);
      }
    });

    it("refuses a fiscal year that would overlap existing periods", async () => {
      const book = await newBook();
      // A stray period inside 2027 — a misconfigured earlier generation, or a
      // hand-inserted stub. Generating FY2027 must refuse rather than produce a
      // book where "the period containing this date" has two answers.
      await scratch.handle.pool.query(
        `insert into fiscal_periods
           (accounting_book_id, period_code, fiscal_year, sequence, starts_on, ends_on)
         values ($1, 'STRAY-2027', 9999, 1, '2027-06-01', '2027-06-30')`,
        [book.id],
      );
      await expect(
        periods.generateFiscalYear({
          accountingBookId: book.id,
          fiscalYear: 2027,
        }),
      ).rejects.toThrow(/would overlap a period that already exists/);
    });
  });

  describe("resolution", () => {
    it("resolves the period containing a date, and nothing outside the year", async () => {
      const book = await newBook();
      const march = await periods.resolvePeriod(book.id, "2026-03-17");
      expect(march?.periodCode).toBe("FY2026-P03");
      expect(await periods.resolvePeriod(book.id, "2027-01-05")).toBeNull();
      await expect(periods.requirePeriod(book.id, "2027-01-05")).rejects.toThrow(
        /no fiscal period contains 2027-01-05/,
      );
    });

    it("names the unpostable backlog rather than creating a period on demand", async () => {
      const book = await newBook();
      await expect(periods.requirePeriod(book.id, "2030-05-01")).rejects.toThrow(
        /generated, never auto-created on demand/,
      );
      expect(await periods.listPeriods(book.id)).toHaveLength(12);
    });
  });

  describe("closing semantics", () => {
    it("moves through open -> soft_closed -> closed and back, audited", async () => {
      const book = await newBook();
      const january = await periods.requirePeriod(book.id, "2026-01-15");

      const soft = await periods.closePeriod({
        fiscalPeriodId: january.id,
        actorUserId: null,
        note: "month end",
      });
      expect(soft.status).toBe("soft_closed");
      expect(soft.closedAt).not.toBeNull();

      const hard = await periods.closePeriod({
        fiscalPeriodId: january.id,
        status: "closed",
      });
      expect(hard.status).toBe("closed");

      const reopened = await periods.reopenPeriod({
        fiscalPeriodId: january.id,
        note: "amended return",
      });
      expect(reopened.status).toBe("open");
      expect(reopened.closedAt).toBeNull();

      const closedEvents = await auditEventsFor(
        scratch,
        "accounting.period.closed",
      );
      const reopenedEvents = await auditEventsFor(
        scratch,
        "accounting.period.reopened",
      );
      expect(closedEvents.length).toBeGreaterThan(0);
      expect(reopenedEvents.length).toBeGreaterThan(0);
    });

    it("REFUSES to reopen a locked period", async () => {
      const book = await newBook();
      const february = await periods.requirePeriod(book.id, "2026-02-15");
      await periods.setStatus({
        fiscalPeriodId: february.id,
        status: "locked",
      });
      await expect(
        periods.reopenPeriod({ fiscalPeriodId: february.id }),
      ).rejects.toThrow(/is locked: no application path reopens it/);
      await expect(
        periods.setStatus({ fiscalPeriodId: february.id, status: "soft_closed" }),
      ).rejects.toThrow(/is locked/);
    });

    it("is a no-op when the status is unchanged", async () => {
      const book = await newBook();
      const march = await periods.requirePeriod(book.id, "2026-03-15");
      const same = await periods.setStatus({
        fiscalPeriodId: march.id,
        status: "open",
      });
      expect(same.status).toBe("open");
      expect(same.closedAt).toBeNull();
    });

    it("refuses an unknown status at the boundary", async () => {
      const book = await newBook();
      const april = await periods.requirePeriod(book.id, "2026-04-15");
      await expect(
        periods.setStatus({
          fiscalPeriodId: april.id,
          status: "finalised" as "closed",
        }),
      ).rejects.toThrow(/invalid fiscal period input/);
    });
  });
});
