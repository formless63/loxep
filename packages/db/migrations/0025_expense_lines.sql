-- Expense redesign M3 (loxep-cd3.3), migration C — `expense_lines`.
-- Physical realization of
-- `apps/docs/src/content/docs/architecture/expense-entry-design.md` section
-- 4 ("Line items: one shape, three destinations").
--
-- A receipt LINE (what was bought — may name no target, count fixed by the
-- document) is not an ALLOCATION (where the money is charged — must name a
-- target, count chosen by the operator). Widening `expense_allocations` was
-- rejected: it would loosen `expense_allocations_target_check` (`>= 1`) and
-- drop `expense_allocations_amount_check` (`<> 0`), two weakened invariants
-- to avoid one small table.
--
-- No currency (expenses.currency is authoritative), no date
-- (expenses.expense_date is the date), no tax_amount (a receipt's tax IS a
-- line, `line_kind = 'tax'`), no acquisition_id/catalog_item_id/
-- ledger_account_id (those are allocation targets). `line_amount` may be
-- zero or negative; `expenses.amount` keeps its own `<> 0` check.
-- `sum(|line_amount|) <= |expenses.amount|` is a SERVICE rule
-- (`@loxep/accounting`), never a `CHECK` — a draft expense is legitimately
-- half-transcribed.
--
-- `document_line_candidate_id` is a real FK with a partial unique index
-- (`expense_lines_document_line_candidate_uq`) — unlike
-- `document_line_candidates.target_kind`/`target_id`, which stamps across
-- four tables and cannot be a real constraint. `ON DELETE SET NULL`: a
-- candidate row disappearing is a bookkeeping detail, never a reason to
-- delete evidence of the purchase.
--
-- Named FK explicitly (`expense_lines_document_line_candidate_fk`): the
-- derived name
-- (`expense_lines_document_line_candidate_id_document_line_candidates_id_fk`,
-- 74 bytes) exceeds PostgreSQL's 63-byte identifier limit.
--
-- Drizzle-generated: `bun --cwd packages/db generate` emitted this from the
-- new `expense_lines` table added to
-- `packages/db/src/schema/expenses.ts` — nothing hand-written.
CREATE TABLE "expense_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text,
	"quantity" numeric(20, 6),
	"unit_amount" numeric(20, 6),
	"line_amount" numeric(20, 6) NOT NULL,
	"line_kind" text DEFAULT 'item' NOT NULL,
	"document_line_candidate_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_lines_expense_line_uq" UNIQUE("expense_id","line_number"),
	CONSTRAINT "expense_lines_line_number_check" CHECK ("expense_lines"."line_number" > 0),
	CONSTRAINT "expense_lines_line_kind_check" CHECK ("expense_lines"."line_kind" in ('item', 'shipping', 'tax', 'fee', 'discount', 'other'))
);
--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_document_line_candidate_fk" FOREIGN KEY ("document_line_candidate_id") REFERENCES "public"."document_line_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_lines_document_line_candidate_uq" ON "expense_lines" USING btree ("document_line_candidate_id") WHERE "expense_lines"."document_line_candidate_id" is not null;--> statement-breakpoint
CREATE INDEX "expense_lines_expense_id_idx" ON "expense_lines" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_lines_document_line_candidate_id_idx" ON "expense_lines" USING btree ("document_line_candidate_id") WHERE "expense_lines"."document_line_candidate_id" is not null;