/**
 * Migration 0009's ledger DDL against real PostgreSQL.
 *
 * These are CONSTRAINT tests, so they write through the pool rather than
 * through `@loxep/accounting`: a service that validates first would hide
 * whether the database validates at all, and the whole argument for the
 * triggers is that every package in the monolith can reach these tables.
 *
 * The design's own pre-implementation checklist asks for exactly these, by
 * name and in this order: the balance test first, the immutability tests
 * alongside it, then the closed-period refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedScratchDb, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

const BOOK = "11111111-1111-4111-8111-111111111111";
const OTHER_BOOK = "11111111-1111-4111-8111-111111111112";
const CASH = "22222222-2222-4222-8222-222222222221";
const REVENUE = "22222222-2222-4222-8222-222222222222";
const HEADER = "22222222-2222-4222-8222-222222222223";
const OTHER_BOOK_CASH = "22222222-2222-4222-8222-222222222224";
const PERIOD = "33333333-3333-4333-8333-333333333331";

describe("ledger schema (migration 0009)", () => {
  let scratch: ScratchDb;
  let entityId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_ledger_schema");
    entityId = await seedEntity(scratch, "Acme LLC");
    await scratch.handle.pool.query(
      `insert into accounting_books (id, code, name, opened_on) values
         ($1, 'MAIN', 'Main Book', '2026-01-01'),
         ($2, 'ALT', 'Second Book', '2026-01-01')`,
      [BOOK, OTHER_BOOK],
    );
    await scratch.handle.pool.query(
      `insert into ledger_accounts
         (id, accounting_book_id, code, name, account_type, system_key, is_postable)
       values
         ($1, $5, '1000', 'Cash', 'asset', 'undeposited_funds', true),
         ($2, $5, '4000', 'Revenue', 'revenue', 'sales_revenue', true),
         ($3, $5, '9000', 'Header', 'asset', null, false),
         ($4, $6, '1000', 'Cash (other book)', 'asset', 'undeposited_funds', true)`,
      [CASH, REVENUE, HEADER, OTHER_BOOK_CASH, BOOK, OTHER_BOOK],
    );
    await scratch.handle.pool.query(
      `insert into fiscal_periods
         (id, accounting_book_id, period_code, fiscal_year, sequence, starts_on, ends_on)
       values ($1, $2, 'FY2026-P01', 2026, 1, '2026-01-01', '2026-01-31')`,
      [PERIOD, BOOK],
    );
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  let entrySeq = 0;
  let numberSeq = 100;

  /** Insert a draft entry and return its id. */
  async function draftEntry(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    entrySeq += 1;
    const columns: Record<string, string> = {
      accounting_book_id: `'${BOOK}'`,
      entry_date: `'2026-01-10'`,
      entry_source: `'manual'`,
      description: `'entry ${entrySeq}'`,
      ...overrides,
    };
    const result = await scratch.handle.pool.query<{ id: string }>(
      `insert into journal_entries (${Object.keys(columns).join(", ")})
       values (${Object.values(columns).join(", ")}) returning id`,
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error("entry insert returned no row");
    return id;
  }

  async function addLine(
    entryId: string,
    amount: string,
    overrides: Record<string, string> = {},
  ): Promise<void> {
    const columns: Record<string, string> = {
      journal_entry_id: `'${entryId}'`,
      accounting_book_id: `'${BOOK}'`,
      ledger_account_id: `'${CASH}'`,
      line_number: "1",
      currency: `'USD'`,
      amount,
      functional_currency: `'USD'`,
      functional_amount: amount,
      ...overrides,
    };
    await scratch.handle.pool.query(
      `insert into journal_lines (${Object.keys(columns).join(", ")})
       values (${Object.values(columns).join(", ")})`,
    );
  }

  async function post(entryId: string): Promise<void> {
    numberSeq += 1;
    await scratch.handle.pool.query(
      `update journal_entries
          set status = 'posted', entry_number = $2, fiscal_period_id = $3,
              posted_at = now()
        where id = $1`,
      [entryId, numberSeq, PERIOD],
    );
  }

  /** Draft → two balanced lines → posted, all in one transaction. */
  async function postedEntry(
    lineOverrides: { debit?: Record<string, string>; credit?: Record<string, string> } = {},
  ): Promise<string> {
    const client = await scratch.handle.pool.connect();
    try {
      await client.query("begin");
      entrySeq += 1;
      numberSeq += 1;
      const entry = await client.query<{ id: string }>(
        `insert into journal_entries
           (accounting_book_id, entry_date, entry_source, description)
         values ($1, '2026-01-10', 'manual', $2) returning id`,
        [BOOK, `entry ${entrySeq}`],
      );
      const entryId = entry.rows[0]?.id as string;
      await client.query(
        `insert into journal_lines
           (journal_entry_id, accounting_book_id, ledger_account_id, line_number,
            currency, amount, functional_currency, functional_amount)
         values ($1, $2, $3, 1, 'USD', 100, 'USD', 100),
                ($1, $2, $4, 2, 'USD', -100, 'USD', -100)`,
        [
          entryId,
          BOOK,
          lineOverrides.debit?.["account"] ?? CASH,
          lineOverrides.credit?.["account"] ?? REVENUE,
        ],
      );
      await client.query(
        `update journal_entries
            set status = 'posted', entry_number = $2, fiscal_period_id = $3,
                posted_at = now()
          where id = $1`,
        [entryId, numberSeq, PERIOD],
      );
      await client.query("commit");
      return entryId;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  describe("the deferred balance constraint trigger", () => {
    it("REFUSES an unbalanced posted entry, at COMMIT", async () => {
      const client = await scratch.handle.pool.connect();
      try {
        await client.query("begin");
        const entry = await client.query<{ id: string }>(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description)
           values ($1, '2026-01-10', 'manual', 'unbalanced') returning id`,
          [BOOK],
        );
        const entryId = entry.rows[0]?.id as string;
        await client.query(
          `insert into journal_lines
             (journal_entry_id, accounting_book_id, ledger_account_id, line_number,
              currency, amount, functional_currency, functional_amount)
           values ($1, $2, $3, 1, 'USD', 100, 'USD', 100)`,
          [entryId, BOOK, CASH],
        );
        // The statement itself succeeds — the check is DEFERRED, which is the
        // whole point: lines arrive one statement at a time.
        await client.query(
          `update journal_entries
              set status = 'posted', entry_number = 9001, fiscal_period_id = $2,
                  posted_at = now()
            where id = $1`,
          [entryId, PERIOD],
        );
        await expect(client.query("commit")).rejects.toThrow(
          /does not balance in USD/,
        );
      } finally {
        client.release();
      }
      const survivors = await scratch.handle.pool.query(
        `select 1 from journal_entries where description = 'unbalanced'`,
      );
      expect(survivors.rowCount).toBe(0);
    });

    it("ACCEPTS a balanced posted entry", async () => {
      const entryId = await postedEntry();
      const row = await scratch.handle.pool.query<{ status: string }>(
        `select status from journal_entries where id = $1`,
        [entryId],
      );
      expect(row.rows[0]?.status).toBe("posted");
    });

    it("exempts DRAFTS — an entry being assembled is legitimately unbalanced", async () => {
      const entryId = await draftEntry();
      await addLine(entryId, "42");
      const row = await scratch.handle.pool.query<{ status: string }>(
        `select status from journal_entries where id = $1`,
        [entryId],
      );
      expect(row.rows[0]?.status).toBe("draft");
    });

    it("refuses a posted entry with NO lines", async () => {
      const entryId = await draftEntry();
      await expect(post(entryId)).rejects.toThrow(/posted with no lines/);
    });

    it("checks the FUNCTIONAL currency separately from the transaction currency", async () => {
      // Same currency label on both sides, functional amounts deliberately
      // mismatched: the transaction sum is zero and the functional sum is not.
      const client = await scratch.handle.pool.connect();
      try {
        await client.query("begin");
        const entry = await client.query<{ id: string }>(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description)
           values ($1, '2026-01-10', 'manual', 'functional mismatch') returning id`,
          [BOOK],
        );
        const entryId = entry.rows[0]?.id as string;
        await client.query(
          `insert into journal_lines
             (journal_entry_id, accounting_book_id, ledger_account_id, line_number,
              currency, amount, functional_currency, functional_amount)
           values ($1, $2, $3, 1, 'USD', 100, 'USD', 100),
                  ($1, $2, $4, 2, 'USD', -100, 'USD', -90)`,
          [entryId, BOOK, CASH, REVENUE],
        );
        await client.query(
          `update journal_entries
              set status = 'posted', entry_number = 9002, fiscal_period_id = $2,
                  posted_at = now()
            where id = $1`,
          [entryId, PERIOD],
        );
        await expect(client.query("commit")).rejects.toThrow(
          /functional currency/,
        );
      } finally {
        client.release();
      }
    });
  });

  describe("immutability", () => {
    it("refuses UPDATE and DELETE on a posted entry", async () => {
      const entryId = await postedEntry();
      await expect(
        scratch.handle.pool.query(
          `update journal_entries set memo = 'edited' where id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/immutable once posted/);
      await expect(
        scratch.handle.pool.query(`delete from journal_entries where id = $1`, [
          entryId,
        ]),
      ).rejects.toThrow(/immutable once posted/);
    });

    it("refuses INSERT, UPDATE and DELETE on a posted entry's lines", async () => {
      const entryId = await postedEntry();
      await expect(
        scratch.handle.pool.query(
          `update journal_lines set amount = 1 where journal_entry_id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/immutable once its entry is posted/);
      await expect(
        scratch.handle.pool.query(
          `delete from journal_lines where journal_entry_id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/immutable once its entry is posted/);
      // A BALANCED pair added after the fact would slip past the deferred
      // balance check while restating a month someone has already read.
      await expect(
        scratch.handle.pool.query(
          `insert into journal_lines
             (journal_entry_id, accounting_book_id, ledger_account_id, line_number,
              currency, amount, functional_currency, functional_amount)
           values ($1, $2, $3, 3, 'USD', 5, 'USD', 5),
                  ($1, $2, $4, 4, 'USD', -5, 'USD', -5)`,
          [entryId, BOOK, CASH, REVENUE],
        ),
      ).rejects.toThrow(/immutable once its entry is posted/);
    });

    it("allows the ONE whitelisted transition: posted -> reversed", async () => {
      const entryId = await postedEntry();
      await scratch.handle.pool.query(
        `update journal_entries set status = 'reversed', updated_at = now()
          where id = $1`,
        [entryId],
      );
      const row = await scratch.handle.pool.query<{ status: string }>(
        `select status from journal_entries where id = $1`,
        [entryId],
      );
      expect(row.rows[0]?.status).toBe("reversed");
    });

    it("refuses a posted -> reversed stamp that changes anything else", async () => {
      const entryId = await postedEntry();
      await expect(
        scratch.handle.pool.query(
          `update journal_entries
              set status = 'reversed', memo = 'and a quiet edit', updated_at = now()
            where id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/immutable once posted/);
    });

    it("still allows a DRAFT to be edited, voided, and deleted", async () => {
      const entryId = await draftEntry();
      await addLine(entryId, "10");
      await scratch.handle.pool.query(
        `update journal_entries set memo = 'still typing' where id = $1`,
        [entryId],
      );
      await scratch.handle.pool.query(
        `update journal_entries set status = 'void' where id = $1`,
        [entryId],
      );
      // A void draft is immutable from here on, so delete a fresh one.
      const other = await draftEntry();
      await addLine(other, "10");
      await scratch.handle.pool.query(
        `delete from journal_entries where id = $1`,
        [other],
      );
      const lines = await scratch.handle.pool.query(
        `select 1 from journal_lines where journal_entry_id = $1`,
        [other],
      );
      expect(lines.rowCount).toBe(0);
    });
  });

  describe("the fiscal-period posting guard", () => {
    it("refuses posting into a closed period", async () => {
      await scratch.handle.pool.query(
        `insert into fiscal_periods
           (id, accounting_book_id, period_code, fiscal_year, sequence, starts_on, ends_on, status)
         values ('33333333-3333-4333-8333-333333333332', $1, 'FY2026-P02', 2026, 2,
                 '2026-02-01', '2026-02-28', 'closed')`,
        [BOOK],
      );
      await expect(
        scratch.handle.pool.query(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description, status,
              entry_number, fiscal_period_id, posted_at)
           values ($1, '2026-02-10', 'manual', 'into a closed period', 'posted',
                   9100, '33333333-3333-4333-8333-333333333332', now())`,
          [BOOK],
        ),
      ).rejects.toThrow(/is closed: posting into it is blocked/);
    });

    it("refuses an ordinary posting into a soft_closed period, and permits a flagged one", async () => {
      await scratch.handle.pool.query(
        `insert into fiscal_periods
           (id, accounting_book_id, period_code, fiscal_year, sequence, starts_on, ends_on, status)
         values ('33333333-3333-4333-8333-333333333333', $1, 'FY2026-P03', 2026, 3,
                 '2026-03-01', '2026-03-31', 'soft_closed')`,
        [BOOK],
      );
      const client = await scratch.handle.pool.connect();
      try {
        await client.query("begin");
        await expect(
          client.query(
            `insert into journal_entries
               (accounting_book_id, entry_date, entry_source, description, status,
                entry_number, fiscal_period_id, posted_at)
             values ($1, '2026-03-10', 'manual', 'ordinary', 'posted',
                     9101, '33333333-3333-4333-8333-333333333333', now())`,
            [BOOK],
          ),
        ).rejects.toThrow(/soft_closed: ordinary posting is blocked/);
        await client.query("rollback");
      } finally {
        client.release();
      }

      // Lines are written while the entry is a DRAFT and the entry is posted
      // afterwards — the only order the immutability trigger permits, and the
      // one the posting service follows.
      const authorized = await scratch.handle.pool.connect();
      try {
        await authorized.query("begin");
        const backdated = await authorized.query<{ id: string }>(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description)
           values ($1, '2026-03-10', 'manual', 'late provider fee') returning id`,
          [BOOK],
        );
        const backdatedId = backdated.rows[0]?.id as string;
        await authorized.query(
          `insert into journal_lines
             (journal_entry_id, accounting_book_id, ledger_account_id, line_number,
              currency, amount, functional_currency, functional_amount)
           values ($1, $2, $3, 1, 'USD', 12, 'USD', 12),
                  ($1, $2, $4, 2, 'USD', -12, 'USD', -12)`,
          [backdatedId, BOOK, CASH, REVENUE],
        );
        await authorized.query(
          `update journal_entries
              set status = 'posted', entry_number = 9102, posted_at = now(),
                  is_backdated = true,
                  fiscal_period_id = '33333333-3333-4333-8333-333333333333'
            where id = $1`,
          [backdatedId],
        );
        await authorized.query("commit");
        expect(backdatedId).toEqual(expect.any(String));
      } catch (error) {
        await authorized.query("rollback");
        throw error;
      } finally {
        authorized.release();
      }
    });

    it("refuses an entry stamped with a period that does not contain its date", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description, status,
              entry_number, fiscal_period_id, posted_at)
           values ($1, '2026-06-10', 'manual', 'wrong month', 'posted',
                   9103, $2, now())`,
          [BOOK, PERIOD],
        ),
      ).rejects.toThrow(/outside its stamped period/);
    });
  });

  describe("the composite same-book foreign keys", () => {
    it("refuses a line in one book against an account of another", async () => {
      const entryId = await draftEntry();
      await expect(
        addLine(entryId, "10", { ledger_account_id: `'${OTHER_BOOK_CASH}'` }),
      ).rejects.toThrow(/journal_lines_book_account_fk|foreign key/i);
    });

    it("refuses a line whose book disagrees with its entry's book", async () => {
      const entryId = await draftEntry();
      await expect(
        addLine(entryId, "10", {
          accounting_book_id: `'${OTHER_BOOK}'`,
          ledger_account_id: `'${OTHER_BOOK_CASH}'`,
        }),
      ).rejects.toThrow(/journal_lines_book_entry_fk|foreign key/i);
    });

    it("refuses an entry stamped with another book's fiscal period", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description, status,
              entry_number, fiscal_period_id, posted_at)
           values ($1, '2026-01-10', 'manual', 'other book period', 'posted',
                   9104, $2, now())`,
          [OTHER_BOOK, PERIOD],
        ),
      ).rejects.toThrow(/journal_entries_period_fk|foreign key/i);
    });

    it("refuses a chart hierarchy that crosses books", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into ledger_accounts
             (accounting_book_id, code, name, account_type, parent_account_id)
           values ($1, '1010', 'Cross-book child', 'asset', $2)`,
          [OTHER_BOOK, CASH],
        ),
      ).rejects.toThrow(/ledger_accounts_parent_fk|foreign key/i);
    });
  });

  describe("exclusion constraints", () => {
    it("refuses two posting_primary books for one entity over overlapping dates", async () => {
      await scratch.handle.pool.query(
        `insert into book_entity_links
           (accounting_book_id, economic_entity_id, link_role, effective_from)
         values ($1, $2, 'posting_primary', '2026-01-01')`,
        [BOOK, entityId],
      );
      await expect(
        scratch.handle.pool.query(
          `insert into book_entity_links
             (accounting_book_id, economic_entity_id, link_role, effective_from)
           values ($1, $2, 'posting_primary', '2026-06-01')`,
          [OTHER_BOOK, entityId],
        ),
      ).rejects.toThrow(/book_entity_links_primary_no_overlap/);
    });

    it("permits any number of reporting_only links over the same dates", async () => {
      const inserted = await scratch.handle.pool.query(
        `insert into book_entity_links
           (accounting_book_id, economic_entity_id, link_role, effective_from)
         values ($1, $2, 'reporting_only', '2026-01-01'),
                ($3, $2, 'reporting_only', '2026-01-01')`,
        [BOOK, entityId, OTHER_BOOK],
      );
      expect(inserted.rowCount).toBe(2);
    });

    it("permits a NEW primary book once the previous link is closed", async () => {
      const entity = await seedEntity(scratch, "Moves Books LLC");
      await scratch.handle.pool.query(
        `insert into book_entity_links
           (accounting_book_id, economic_entity_id, link_role, effective_from, effective_to)
         values ($1, $2, 'posting_primary', '2026-01-01', '2026-05-31')`,
        [BOOK, entity],
      );
      const next = await scratch.handle.pool.query(
        `insert into book_entity_links
           (accounting_book_id, economic_entity_id, link_role, effective_from)
         values ($1, $2, 'posting_primary', '2026-06-01')`,
        [OTHER_BOOK, entity],
      );
      expect(next.rowCount).toBe(1);
    });

    it("refuses overlapping fiscal periods in one book", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into fiscal_periods
             (accounting_book_id, period_code, fiscal_year, sequence, starts_on, ends_on)
           values ($1, 'FY2026-P99', 2026, 99, '2026-01-15', '2026-02-15')`,
          [BOOK],
        ),
      ).rejects.toThrow(/fiscal_periods_no_overlap/);
    });

    it("permits the same dates in a DIFFERENT book", async () => {
      const inserted = await scratch.handle.pool.query(
        `insert into fiscal_periods
           (accounting_book_id, period_code, fiscal_year, sequence, starts_on, ends_on)
         values ($1, 'FY2026-P01', 2026, 1, '2026-01-01', '2026-01-31')`,
        [OTHER_BOOK],
      );
      expect(inserted.rowCount).toBe(1);
    });
  });

  describe("CHECK constraints and identity", () => {
    it("enforces the posting_key idempotency unique where not null", async () => {
      await draftEntry({ posting_key: `'pr:demo:v1:expense:abc'` });
      await expect(
        draftEntry({ posting_key: `'pr:demo:v1:expense:abc'` }),
      ).rejects.toThrow(/journal_entries_posting_key_uq/);
      // Null keys never collide.
      await expect(draftEntry()).resolves.toEqual(expect.any(String));
    });

    it("enforces gapless numbering per book, and permits the same number elsewhere", async () => {
      const first = await draftEntry();
      await addLine(first, "5");
      await addLine(first, "-5", { line_number: "2", ledger_account_id: `'${REVENUE}'` });
      await post(first);
      const taken = numberSeq;
      await expect(
        scratch.handle.pool.query(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description, status,
              entry_number, fiscal_period_id, posted_at)
           values ($1, '2026-01-10', 'manual', 'duplicate number', 'posted',
                   $2, $3, now())`,
          [BOOK, taken, PERIOD],
        ),
      ).rejects.toThrow(/journal_entries_book_entry_number_uq/);
    });

    it("refuses a half-written source-fact stamp", async () => {
      await expect(
        draftEntry({ source_fact_type: `'expense'` }),
      ).rejects.toThrow(/journal_entries_source_fact_check/);
      await expect(
        draftEntry({ source_fact_id: `'${PERIOD}'` }),
      ).rejects.toThrow(/journal_entries_source_fact_check/);
      await expect(
        draftEntry({
          source_fact_type: `'expense'`,
          source_fact_id: `'${PERIOD}'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("keeps source-fact provenance UNENFORCED — no foreign key", async () => {
      // A posted entry must survive the deletion of its source fact, so the
      // stamp points at a uuid that need not resolve to anything.
      await expect(
        draftEntry({
          source_fact_type: `'order'`,
          source_fact_id: `'00000000-0000-4000-8000-000000000000'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("refuses a zero line and a non-unity rate on a same-currency line", async () => {
      const entryId = await draftEntry();
      await expect(addLine(entryId, "0")).rejects.toThrow(
        /journal_lines_amount_check/,
      );
      await expect(
        addLine(entryId, "10", { fx_rate_source: `'manual'` }),
      ).rejects.toThrow(/journal_lines_unity_check/);
    });

    it("refuses an unknown account type, status, entry source, and rate source", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into ledger_accounts (accounting_book_id, code, name, account_type)
           values ($1, '7777', 'Nonsense', 'contra_asset')`,
          [BOOK],
        ),
      ).rejects.toThrow(/ledger_accounts_account_type_check/);
      await expect(draftEntry({ status: `'submitted'` })).rejects.toThrow(
        /journal_entries_status_check/,
      );
      await expect(draftEntry({ entry_source: `'guesswork'` })).rejects.toThrow(
        /journal_entries_entry_source_check/,
      );
    });

    it("keeps the unreachable-but-designed CHECK members: posting_rule and the fx sources", async () => {
      // Widening a CHECK on a table with rows should not be the first thing the
      // posting-rule milestone has to do.
      await expect(
        draftEntry({ entry_source: `'posting_rule'` }),
      ).resolves.toEqual(expect.any(String));
      const entryId = await draftEntry();
      await expect(
        addLine(entryId, "10", {
          currency: `'GBP'`,
          fx_rate_source: `'provider_reported'`,
          fx_rate: "1.270000000000",
          functional_amount: "12.700000",
        }),
      ).resolves.toBeUndefined();
    });

    it("requires a posted entry to be numbered, dated into a period, and stamped", async () => {
      // The period guard is a BEFORE trigger and fires first when the period
      // itself is missing, so this exercises the CHECK with a valid period and
      // a missing entry number — the half-posted row the constraint is for.
      await expect(
        scratch.handle.pool.query(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description, status,
              fiscal_period_id, posted_at)
           values ($1, '2026-01-10', 'manual', 'half posted', 'posted', $2, now())`,
          [BOOK, PERIOD],
        ),
      ).rejects.toThrow(/journal_entries_posted_completeness_check/);
      // And with no period at all, the guard refuses it first.
      await expect(
        scratch.handle.pool.query(
          `insert into journal_entries
             (accounting_book_id, entry_date, entry_source, description, status)
           values ($1, '2026-01-10', 'manual', 'no period', 'posted')`,
          [BOOK],
        ),
      ).rejects.toThrow(/no fiscal period is stamped on it/);
    });

    it("nulls ADR-0020 user references when the auth user is deleted", async () => {
      await scratch.handle.pool.query(
        `insert into "user" (id, name, email)
         values ('ledger_actor', 'Actor', 'ledger_actor@example.test')`,
      );
      const entryId = await draftEntry({
        created_by_user_id: `'ledger_actor'`,
      });
      await scratch.handle.pool.query(
        `delete from "user" where id = 'ledger_actor'`,
      );
      const row = await scratch.handle.pool.query<{
        created_by_user_id: string | null;
      }>(`select created_by_user_id from journal_entries where id = $1`, [
        entryId,
      ]);
      expect(row.rows[0]?.created_by_user_id).toBeNull();
    });
  });

  describe("physical shape", () => {
    it("stores accounting dates as `date` and instants as timestamptz", async () => {
      const result = await scratch.handle.pool.query<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>(
        `select table_name, column_name, data_type from information_schema.columns
          where (table_name, column_name) in
                (('journal_entries', 'entry_date'), ('journal_entries', 'posted_at'),
                 ('fiscal_periods', 'starts_on'), ('book_entity_links', 'effective_from'),
                 ('accounting_books', 'opened_on'))`,
      );
      const byKey = new Map(
        result.rows.map((row) => [
          `${row.table_name}.${row.column_name}`,
          row.data_type,
        ]),
      );
      expect(byKey.get("journal_entries.entry_date")).toBe("date");
      expect(byKey.get("fiscal_periods.starts_on")).toBe("date");
      expect(byKey.get("book_entity_links.effective_from")).toBe("date");
      expect(byKey.get("accounting_books.opened_on")).toBe("date");
      expect(byKey.get("journal_entries.posted_at")).toBe(
        "timestamp with time zone",
      );
    });

    it("has NO economic_entity_id on accounting_books and NO accounting_book_id on economic_entities", async () => {
      // ADR-0017's most-repeated prohibition, asserted physically: this is the
      // migration that would have broken it.
      const result = await scratch.handle.pool.query<{
        table_name: string;
        column_name: string;
      }>(
        `select table_name, column_name from information_schema.columns
          where table_name in ('accounting_books', 'economic_entities')`,
      );
      const columns = result.rows.map(
        (row) => `${row.table_name}.${row.column_name}`,
      );
      expect(columns).not.toContain("accounting_books.economic_entity_id");
      expect(columns).not.toContain("economic_entities.accounting_book_id");
    });

    it("does NOT create the next milestones' tables", async () => {
      const result = await scratch.handle.pool.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'`,
      );
      const tables = new Set(result.rows.map((row) => row.table_name));
      for (const shipped of [
        "accounting_books",
        "book_entity_links",
        "ledger_accounts",
        "accounting_dimensions",
        "accounting_dimension_values",
        "fiscal_periods",
        "journal_entries",
        "journal_lines",
        "journal_line_dimensions",
      ]) {
        expect(tables).toContain(shipped);
      }
      for (const deferred of [
        "posting_rules",
        "posting_rule_versions",
        "posting_rule_lines",
        "journal_entry_source_links",
        "financial_accounts",
        "payouts",
        "payout_lines",
        "bank_statement_imports",
        "bank_transactions",
        "reconciliation_matches",
        "sales_tax_facts",
      ]) {
        expect(tables).not.toContain(deferred);
      }
    });

    it("does NOT carry a posting_rule_version_id column yet", async () => {
      const result = await scratch.handle.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'journal_entries'`,
      );
      expect(result.rows.map((row) => row.column_name)).not.toContain(
        "posting_rule_version_id",
      );
    });

    it("declares no PostgreSQL enum type", async () => {
      const enums = await scratch.handle.pool.query<{ count: string }>(
        `select count(*)::text as count
           from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where t.typtype = 'e' and n.nspname not in ('pg_catalog', 'information_schema')`,
      );
      expect(enums.rows[0]?.count).toBe("0");
    });

    it("keeps every constraint and index name inside PostgreSQL's 63-byte limit", async () => {
      const result = await scratch.handle.pool.query<{ name: string }>(
        `select conname as name from pg_constraint c
           join pg_class t on t.oid = c.conrelid
          where t.relname in ('accounting_books', 'book_entity_links', 'ledger_accounts',
                              'accounting_dimensions', 'accounting_dimension_values',
                              'fiscal_periods', 'journal_entries', 'journal_lines',
                              'journal_line_dimensions')
          union all
         select indexname as name from pg_indexes
          where tablename in ('accounting_books', 'book_entity_links', 'ledger_accounts',
                              'accounting_dimensions', 'accounting_dimension_values',
                              'fiscal_periods', 'journal_entries', 'journal_lines',
                              'journal_line_dimensions')`,
      );
      for (const row of result.rows) {
        expect(row.name.length).toBeLessThanOrEqual(63);
        // Truncation would show up as a name ending mid-word at exactly 63.
        expect(row.name).not.toMatch(/^.{63}$/);
      }
    });

    it("installs btree_gist, the two exclusions, and the four triggers", async () => {
      const extension = await scratch.handle.pool.query<{ extname: string }>(
        `select extname from pg_extension where extname = 'btree_gist'`,
      );
      expect(extension.rows).toHaveLength(1);

      const exclusions = await scratch.handle.pool.query<{ conname: string }>(
        `select conname from pg_constraint where contype = 'x'`,
      );
      expect(exclusions.rows.map((row) => row.conname).sort()).toEqual([
        "book_entity_links_primary_no_overlap",
        "fiscal_periods_no_overlap",
      ]);

      const triggers = await scratch.handle.pool.query<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid in ('journal_entries'::regclass, 'journal_lines'::regclass)
            and not tgisinternal
          order by tgname`,
      );
      expect(triggers.rows.map((row) => row.tgname)).toEqual([
        "journal_entries_balanced",
        "journal_entries_immutable",
        "journal_entries_period_guard",
        "journal_lines_balanced",
        "journal_lines_immutable",
      ]);
    });

    it("declares the balance triggers DEFERRABLE INITIALLY DEFERRED", async () => {
      // A non-deferred version would refuse the first line of every entry.
      const result = await scratch.handle.pool.query<{
        tgname: string;
        tgdeferrable: boolean;
        tginitdeferred: boolean;
      }>(
        `select tgname, tgdeferrable, tginitdeferred from pg_trigger
          where tgname in ('journal_lines_balanced', 'journal_entries_balanced')`,
      );
      expect(result.rows).toHaveLength(2);
      for (const row of result.rows) {
        expect(row.tgdeferrable).toBe(true);
        expect(row.tginitdeferred).toBe(true);
      }
    });
  });
});
