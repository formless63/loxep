-- Expense entry v2 (loxep-zk5) — `expense_lines.unit`.
--
-- Nullable, closed, CHECK'ed — same house rule as `line_kind`: text + TS
-- union (`EXPENSE_LINE_UNITS`, `packages/db/src/schema/expenses.ts`), no PG
-- enum. `null` is the ordinary case ("no unit" — a flat-amount line has
-- nothing to count). The column is carried verbatim end to end (web DTOs,
-- @loxep/accounting's line insert paths) and is NEVER part of any persisted
-- arithmetic: the line editor's fill-two-derive-third behavior (qty x unit
-- price -> subtotal) runs client-side before submit, and `line_amount`
-- stays the one number the server trusts.
--
-- Drizzle-generated: `bun --cwd packages/db generate` emitted this from the
-- new `unit` column added to `expenseLines` in
-- `packages/db/src/schema/expenses.ts` — nothing hand-written.
ALTER TABLE "expense_lines" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_unit_check" CHECK ("expense_lines"."unit" is null or "expense_lines"."unit" in ('each', 'pair', 'pack', 'box', 'case', 'lot', 'lb', 'oz', 'kg', 'g', 'ft', 'in', 'm', 'cm', 'sqft', 'hr', 'day', 'mi', 'km'));