/**
 * Migration 0006's expense DDL against real PostgreSQL.
 *
 * Every `CHECK`, every unique, the two real foreign keys the design left as
 * bare uuids until Phase 4 shipped, the `date`-not-`timestamptz` divergence,
 * and the deliberate ABSENCE of any ledger column. These are constraint tests,
 * so they write through the pool rather than through the service — a service
 * that validates first would hide whether the database validates at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMigratedScratchDb,
  seedAcquisition,
  seedCatalogItem,
  seedEntity,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("expenses schema (migration 0006)", () => {
  let scratch: ScratchDb;
  let entityId: string;
  let acquisitionId: string;
  let acquisitionCostId: string;
  let catalogItemId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_schema");
    entityId = await seedEntity(scratch, "Test LLC");
    const lot = await seedAcquisition(scratch, "ACQ-2026-9001");
    acquisitionId = lot.acquisitionId;
    acquisitionCostId = lot.acquisitionCostId;
    catalogItemId = await seedCatalogItem(scratch, "SKU-9001");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function insertExpense(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    const columns: Record<string, string> = {
      entity_attribution_source: `'unattributed'`,
      reference_code: `'EXP-2026-${Math.floor(Math.random() * 1_000_000)}'`,
      expense_date: `'2026-03-15'`,
      category: `'supplies'`,
      currency: `'USD'`,
      amount: `100.000000`,
      payment_method: `'card'`,
      ...overrides,
    };
    const result = await scratch.handle.pool.query<{ id: string }>(
      `insert into expenses (${Object.keys(columns).join(", ")})
       values (${Object.values(columns).join(", ")}) returning id`,
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error("expense insert returned no row");
    return id;
  }

  describe("expenses CHECK constraints", () => {
    it("rejects a zero amount — an empty form is not a fact", async () => {
      await expect(insertExpense({ amount: "0" })).rejects.toThrow(
        /expenses_amount_check/,
      );
    });

    it("accepts a negative amount — a vendor credit is a real expense row", async () => {
      await expect(insertExpense({ amount: "-42.500000" })).resolves.toEqual(
        expect.any(String),
      );
    });

    it("rejects an unknown entity_attribution_source", async () => {
      await expect(
        insertExpense({ entity_attribution_source: `'connection_default'` }),
      ).rejects.toThrow(/expenses_entity_attribution_source_check/);
    });

    it("rejects an unknown status", async () => {
      await expect(insertExpense({ status: `'submitted'` })).rejects.toThrow(
        /expenses_status_check/,
      );
    });

    it("accepts every documented status, including the unreachable `posted`", async () => {
      for (const status of ["draft", "recorded", "posted", "void"]) {
        await expect(
          insertExpense({ status: `'${status}'` }),
        ).resolves.toEqual(expect.any(String));
      }
    });

    it("rejects an unknown payment_method", async () => {
      await expect(
        insertExpense({ payment_method: `'crypto'` }),
      ).rejects.toThrow(/expenses_payment_method_check/);
    });

    it("does NOT constrain category — it is the one open set", async () => {
      await expect(
        insertExpense({ category: `'llama_boarding'` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("enforces reference_code uniqueness", async () => {
      await insertExpense({ reference_code: `'EXP-2026-0001'` });
      await expect(
        insertExpense({ reference_code: `'EXP-2026-0001'` }),
      ).rejects.toThrow(/expenses_reference_code_uq/);
    });
  });

  describe("expenses column shape", () => {
    it("stores expense_date as `date`, not timestamptz (Phase 5 divergence)", async () => {
      const result = await scratch.handle.pool.query<{
        data_type: string;
        column_name: string;
      }>(
        `select column_name, data_type from information_schema.columns
          where table_name = 'expenses'
            and column_name in ('expense_date', 'created_at')`,
      );
      const byName = new Map(
        result.rows.map((row) => [row.column_name, row.data_type]),
      );
      expect(byName.get("expense_date")).toBe("date");
      expect(byName.get("created_at")).toBe("timestamp with time zone");
    });

    it("has NO ledger, book, journal, or posting column", async () => {
      // The seam is a source-fact identity, not a foreign key. If any of these
      // ever appears, the posting decision was made without the open questions
      // being answered.
      const result = await scratch.handle.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name in ('expenses', 'expense_allocations')`,
      );
      const columns = result.rows.map((row) => row.column_name);
      for (const forbidden of [
        "accounting_book_id",
        "journal_entry_id",
        "posting_key",
        "posted_at",
        "ledger_account_id",
        "dimension_value_id",
        "financial_account_id",
        "payee_counterparty_id",
        "project_id",
      ]) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it("carries a REAL foreign key to acquisition_costs (Phase 4 shipped)", async () => {
      const id = await insertExpense({
        acquisition_cost_id: `'${acquisitionCostId}'`,
      });
      expect(id).toEqual(expect.any(String));
      await expect(
        insertExpense({
          acquisition_cost_id: `'00000000-0000-4000-8000-000000000000'`,
        }),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it("nulls the ADR-0020 user reference when the auth user is deleted", async () => {
      await scratch.handle.pool.query(
        `insert into "user" (id, name, email)
         values ('expense_actor', 'Actor', 'expense_actor@example.test')`,
      );
      const id = await insertExpense({
        created_by_user_id: `'expense_actor'`,
      });
      await scratch.handle.pool.query(
        `delete from "user" where id = 'expense_actor'`,
      );
      const survivor = await scratch.handle.pool.query<{
        created_by_user_id: string | null;
      }>(`select created_by_user_id from expenses where id = $1`, [id]);
      expect(survivor.rows[0]?.created_by_user_id).toBeNull();
    });
  });

  describe("expense_allocations CHECK constraints", () => {
    async function insertAllocation(
      expenseId: string,
      overrides: Record<string, string> = {},
    ): Promise<string> {
      const columns: Record<string, string> = {
        expense_id: `'${expenseId}'`,
        line_number: "1",
        amount: "10.000000",
        economic_entity_id: `'${entityId}'`,
        ...overrides,
      };
      const result = await scratch.handle.pool.query<{ id: string }>(
        `insert into expense_allocations (${Object.keys(columns).join(", ")})
         values (${Object.values(columns).join(", ")}) returning id`,
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error("allocation insert returned no row");
      return id;
    }

    it("rejects a zero allocation amount", async () => {
      const expenseId = await insertExpense();
      await expect(
        insertAllocation(expenseId, { amount: "0" }),
      ).rejects.toThrow(/expense_allocations_amount_check/);
    });

    it("rejects a non-positive line number", async () => {
      const expenseId = await insertExpense();
      await expect(
        insertAllocation(expenseId, { line_number: "0" }),
      ).rejects.toThrow(/expense_allocations_line_number_check/);
    });

    it("rejects an allocation that names no target at all", async () => {
      const expenseId = await insertExpense();
      await expect(
        insertAllocation(expenseId, { economic_entity_id: "null" }),
      ).rejects.toThrow(/expense_allocations_target_check/);
    });

    it("accepts an allocation naming SEVERAL targets — they are orthogonal", async () => {
      const expenseId = await insertExpense();
      await expect(
        insertAllocation(expenseId, {
          acquisition_id: `'${acquisitionId}'`,
          catalog_item_id: `'${catalogItemId}'`,
          channel: `'ebay'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("accepts `channel` alone as the sole target", async () => {
      const expenseId = await insertExpense();
      await expect(
        insertAllocation(expenseId, {
          economic_entity_id: "null",
          channel: `'woo'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("enforces (expense_id, line_number) uniqueness", async () => {
      const expenseId = await insertExpense();
      await insertAllocation(expenseId, { line_number: "7" });
      await expect(
        insertAllocation(expenseId, { line_number: "7" }),
      ).rejects.toThrow(/expense_allocations_expense_line_uq/);
    });

    it("cascades allocations when the expense is deleted", async () => {
      const expenseId = await insertExpense();
      await insertAllocation(expenseId);
      await scratch.handle.pool.query(`delete from expenses where id = $1`, [
        expenseId,
      ]);
      const remaining = await scratch.handle.pool.query(
        `select 1 from expense_allocations where expense_id = $1`,
        [expenseId],
      );
      expect(remaining.rowCount).toBe(0);
    });

    it("does NOT enforce the allocation sum — that is a service rule", async () => {
      // The design is explicit: a draft expense is legitimately partly
      // allocated, so the equality lives in the service and the report. This
      // asserts the absence, because an accidental trigger here would break
      // every draft.
      const expenseId = await insertExpense({ amount: "100.000000" });
      await insertAllocation(expenseId, { amount: "5000.000000" });
      const rows = await scratch.handle.pool.query(
        `select 1 from expense_allocations where expense_id = $1`,
        [expenseId],
      );
      expect(rows.rowCount).toBe(1);
    });
  });

  it("declares no PostgreSQL enum type for any new column", async () => {
    const enums = await scratch.handle.pool.query<{ count: string }>(
      `select count(*)::text as count
         from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where t.typtype = 'e' and n.nspname not in ('pg_catalog', 'information_schema')`,
    );
    expect(enums.rows[0]?.count).toBe("0");
  });

  it("creates the design's named indexes and no more on expenses", async () => {
    const result = await scratch.handle.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where tablename in ('expenses', 'expense_allocations')
        order by indexname`,
    );
    const names = result.rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "expenses_entity_date_idx",
        "expenses_category_date_idx",
        "expenses_posting_backlog_idx",
        "expense_allocations_expense_id_idx",
        "expense_allocations_acquisition_id_idx",
      ]),
    );
  });
});
