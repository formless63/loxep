-- Phase 5, milestone 2 of the financial core: the DECLARATIVE POSTING-RULE
-- model and multi-fact provenance. Four of the design's twenty-two tables —
-- its own "Migration B" — plus the three columns migration 0009 and migration
-- 0006 each deliberately deferred to the milestone that would read them.
--
--   posting_rules              a source-fact SELECTOR: fact type, priority,
--                              optional book narrowing, first match wins
--   posting_rule_versions      IMMUTABLE rule text: predicates and dating.
--                              All predicates null = every fact of this type;
--                              every non-null predicate is an AND. No OR, no
--                              negation, no nesting, no expression column.
--   posting_rule_lines         the line template. Account by system_key OR by
--                              explicit id, exactly one; amount is
--                              amount_source x multiplier and debit/credit
--                              falls out of the SIGN; at most one `remainder`
--                              plug line per version, which is what makes it
--                              impossible to author a template that cannot
--                              balance.
--   journal_entry_source_links which operational facts produced an entry, for
--                              the many case the header stamp cannot express
--
-- ## The columns this migration activates, and why they waited
--
--   journal_entries.posting_rule_version_id  + the paired CHECK
--       (entry_source = 'posting_rule') = (posting_rule_version_id is not null)
--     0009 omitted both under this design's own rule — a column pointing at a
--     table that does not exist is worse than no column — and its plan named
--     this migration as the place they land. The biconditional is what makes
--     "explain this number" a lookup: an entry claims a rule exactly when a
--     rule produced it, so no entry can claim `posting_rule` and name nothing,
--     and no manual entry can blame a rule for a human's number.
--   expenses.accounting_book_id                   a nullable book OVERRIDE
--   expense_allocations.ledger_account_id         a per-split account
--   expense_allocations.dimension_value_id        a per-split dimension value
--     Deferred by 0006 (no target table) and again by 0009 (no reader). This
--     milestone's rule engine reads all three, which is the condition the
--     design set for adding them.
--   expense_allocations_target_check is WIDENED, strictly loosening, to count
--     the two new columns: "$40 of this bill is Shipping Expense" is an
--     attribution naming exactly one thing, and it was previously refused for
--     naming the wrong one. No existing row can fail a loosened check.
--
-- ## The owner's answer 2, made physical for rules
--
-- "Immutable versions; corrections are always reversal plus repost." 0009 made
-- the ENTRY half physical (the immutability triggers, reverses_entry_id). This
-- migration makes the RULE half physical: once any journal entry references a
-- version, that version's text and its lines are frozen at the database, not
-- merely by service convention. An entry posted in March must be explainable by
-- exactly the rule text that produced it, and a mutable rule makes every
-- historical entry unexplainable.
--
-- ## What this migration deliberately does NOT create
--
--   financial_accounts / payouts / payout_lines           banking milestone
--   bank_statement_imports / bank_transactions            banking milestone
--   reconciliation_matches / sales_tax_facts              later milestones
--   expenses.financial_account_id      still no financial_accounts table, so
--                                      still no column — the same rule that
--                                      kept the other three out until today
--   no expression language, no jsonb rule payload, no stored closing entries,
--   and no database view: the income statement and balance sheet are read
--   models in @loxep/accounting, where the type system and the test suite can
--   see them.
--
-- Verified at implementation time against drizzle-kit 0.31.10 / drizzle-orm
-- 0.45.2 and timescale/timescaledb-ha:pg18.4-ts2.29.1-all (PostgreSQL 18.4):
-- the mutual foreign keys between posting_rules and posting_rule_versions, the
-- partial unique index on the remainder line, and num_nonnulls CHECKs all
-- generate correctly and nothing was weakened to fit. Only the two immutability
-- triggers at the end are hand-written.

CREATE TABLE "journal_entry_source_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"source_fact_type" text NOT NULL,
	"source_fact_id" uuid NOT NULL,
	"role" text NOT NULL,
	"amount_contributed" numeric(20, 6),
	"currency" char(3),
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entry_source_links_natural_uq" UNIQUE("journal_entry_id","source_fact_type","source_fact_id","role"),
	CONSTRAINT "journal_entry_source_links_role_check" CHECK ("journal_entry_source_links"."role" in ('primary', 'settled', 'allocated', 'reversed_from', 'evidence'))
);
--> statement-breakpoint
CREATE TABLE "posting_rule_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"posting_rule_version_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_system_key" text,
	"ledger_account_id" uuid,
	"amount_source" text NOT NULL,
	"amount_multiplier" numeric(20, 6) DEFAULT '1' NOT NULL,
	"inherit_entity" boolean DEFAULT true NOT NULL,
	"dimension_value_id" uuid,
	"description_template" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_rule_lines_version_line_uq" UNIQUE("posting_rule_version_id","line_number"),
	CONSTRAINT "posting_rule_lines_account_check" CHECK (num_nonnulls("posting_rule_lines"."account_system_key", "posting_rule_lines"."ledger_account_id") = 1),
	CONSTRAINT "posting_rule_lines_multiplier_check" CHECK ("posting_rule_lines"."amount_multiplier" <> 0),
	CONSTRAINT "posting_rule_lines_line_number_check" CHECK ("posting_rule_lines"."line_number" > 0),
	CONSTRAINT "posting_rule_lines_amount_source_check" CHECK ("posting_rule_lines"."amount_source" in ('total', 'subtotal', 'shipping', 'discount',
                                   'tax', 'fee', 'refund', 'net', 'cost_basis',
                                   'quantity_times_basis', 'remainder'))
);
--> statement-breakpoint
CREATE TABLE "posting_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"posting_rule_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"match_provider" text,
	"match_channel" text,
	"match_economic_entity_id" uuid,
	"match_fee_type" text,
	"match_fee_direction" text,
	"match_movement_kind" text,
	"match_source_kind" text,
	"match_expense_category" text,
	"match_capitalize" boolean,
	"match_currency" char(3),
	"match_min_amount" numeric(20, 6),
	"match_max_amount" numeric(20, 6),
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_rule_versions_rule_version_uq" UNIQUE("posting_rule_id","version"),
	CONSTRAINT "posting_rule_versions_status_check" CHECK ("posting_rule_versions"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "posting_rule_versions_effective_range_check" CHECK ("posting_rule_versions"."effective_to" is null or "posting_rule_versions"."effective_from" is null
          or "posting_rule_versions"."effective_to" >= "posting_rule_versions"."effective_from"),
	CONSTRAINT "posting_rule_versions_amount_range_check" CHECK ("posting_rule_versions"."match_max_amount" is null or "posting_rule_versions"."match_min_amount" is null
          or "posting_rule_versions"."match_max_amount" >= "posting_rule_versions"."match_min_amount"),
	CONSTRAINT "posting_rule_versions_version_check" CHECK ("posting_rule_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "posting_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"source_fact_type" text NOT NULL,
	"accounting_book_id" uuid,
	"priority" integer DEFAULT 100 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"description" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_rules_code_uq" UNIQUE("code"),
	CONSTRAINT "posting_rules_status_check" CHECK ("posting_rules"."status" in ('draft', 'active', 'disabled')),
	CONSTRAINT "posting_rules_source_fact_type_check" CHECK ("posting_rules"."source_fact_type" in ('order', 'order_fee', 'order_refund',
                                     'order_fulfillment', 'inventory_movement',
                                     'acquisition_cost', 'shipment', 'expense',
                                     'payout', 'payout_line', 'bank_transaction',
                                     'sales_tax_fact', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "expense_allocations" DROP CONSTRAINT "expense_allocations_target_check";--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD COLUMN "ledger_account_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD COLUMN "dimension_value_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "accounting_book_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "posting_rule_version_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_entry_source_links" ADD CONSTRAINT "journal_entry_source_links_entry_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rule_lines" ADD CONSTRAINT "posting_rule_lines_version_fk" FOREIGN KEY ("posting_rule_version_id") REFERENCES "public"."posting_rule_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rule_lines" ADD CONSTRAINT "posting_rule_lines_account_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rule_lines" ADD CONSTRAINT "posting_rule_lines_dimension_value_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."accounting_dimension_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rule_versions" ADD CONSTRAINT "posting_rule_versions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rule_versions" ADD CONSTRAINT "posting_rule_versions_rule_fk" FOREIGN KEY ("posting_rule_id") REFERENCES "public"."posting_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rule_versions" ADD CONSTRAINT "posting_rule_versions_entity_fk" FOREIGN KEY ("match_economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rules" ADD CONSTRAINT "posting_rules_current_version_id_posting_rule_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."posting_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rules" ADD CONSTRAINT "posting_rules_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rules" ADD CONSTRAINT "posting_rules_book_fk" FOREIGN KEY ("accounting_book_id") REFERENCES "public"."accounting_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entry_source_links_source_fact_idx" ON "journal_entry_source_links" USING btree ("source_fact_type","source_fact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posting_rule_lines_version_remainder_uq" ON "posting_rule_lines" USING btree ("posting_rule_version_id") WHERE amount_source = 'remainder';--> statement-breakpoint
CREATE INDEX "posting_rule_lines_version_idx" ON "posting_rule_lines" USING btree ("posting_rule_version_id");--> statement-breakpoint
CREATE INDEX "posting_rule_versions_rule_status_idx" ON "posting_rule_versions" USING btree ("posting_rule_id","status");--> statement-breakpoint
CREATE INDEX "posting_rules_type_status_priority_idx" ON "posting_rules" USING btree ("source_fact_type","status","priority");--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_dimension_value_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."accounting_dimension_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_accounting_book_id_accounting_books_id_fk" FOREIGN KEY ("accounting_book_id") REFERENCES "public"."accounting_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posting_rule_version_fk" FOREIGN KEY ("posting_rule_version_id") REFERENCES "public"."posting_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entries_posting_rule_version_idx" ON "journal_entries" USING btree ("posting_rule_version_id") WHERE posting_rule_version_id is not null;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_target_check" CHECK (num_nonnulls("expense_allocations"."economic_entity_id", "expense_allocations"."acquisition_id", "expense_allocations"."catalog_item_id", "expense_allocations"."channel", "expense_allocations"."ledger_account_id", "expense_allocations"."dimension_value_id") >= 1);--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posting_rule_version_check" CHECK (("journal_entries"."entry_source" = 'posting_rule') = ("journal_entries"."posting_rule_version_id" is not null));
--> statement-breakpoint

-- PROVISIONAL (design open question 2, answered by the owner 2026-08-12): a
-- rule version is IMMUTABLE once any journal entry references it.
--
-- The service refuses to edit anything but a `draft` version and always mints
-- version N+1 instead; this trigger is the guarantee rather than the error
-- message, on the same reasoning 0009 used for the ledger itself — every
-- package in this monolith can reach posting_rule_versions, and an invariant
-- that lives only in TypeScript is a convention.
--
-- Two changes stay whitelisted on a referenced version, and both are the
-- lifecycle the design requires rather than an edit of its text:
--
--   status         active -> superseded, when version N+1 takes over
--   effective_to   the date the superseded text stops applying
--
-- Everything else — a predicate, the rule it belongs to, its number — is the
-- text that explains posted entries, and posted entries are not re-explained.
CREATE FUNCTION "loxep_posting_rule_versions_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $loxep_posting_rule_versions_immutable$
DECLARE
	referenced boolean;
BEGIN
	SELECT EXISTS (
		SELECT 1 FROM journal_entries e WHERE e.posting_rule_version_id = OLD.id
	) INTO referenced;

	IF NOT referenced THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;

	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION
			'posting rule version % is referenced by posted journal entries and may not be deleted',
			OLD.id
			USING ERRCODE = 'P0001',
			      HINT = 'Disable the rule or supersede the version; the text that produced an entry is kept forever.';
	END IF;

	IF (to_jsonb(NEW) - 'status' - 'effective_to')
	   = (to_jsonb(OLD) - 'status' - 'effective_to') THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION
		'posting rule version % is referenced by posted journal entries and is immutable',
		OLD.id
		USING ERRCODE = 'P0001',
		      HINT = 'Create version N+1 and mark this one superseded; entries stay explainable by the exact text that produced them.';
END;
$loxep_posting_rule_versions_immutable$;
--> statement-breakpoint
CREATE TRIGGER "posting_rule_versions_immutable"
BEFORE UPDATE OR DELETE ON "posting_rule_versions"
FOR EACH ROW EXECUTE FUNCTION "loxep_posting_rule_versions_immutable"();
--> statement-breakpoint

-- The same rule one level down, and it guards INSERT as well: adding a line to
-- a version that has already posted entries silently changes what those entries
-- would have been, which is the same failure as editing the version itself and
-- is easier to do by accident.
CREATE FUNCTION "loxep_posting_rule_lines_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $loxep_posting_rule_lines_immutable$
DECLARE
	target uuid;
	referenced boolean;
BEGIN
	IF TG_OP = 'DELETE' THEN
		target := OLD.posting_rule_version_id;
	ELSE
		target := NEW.posting_rule_version_id;
	END IF;

	-- No version: it is being cascaded away, which only an unreferenced one can
	-- be (the version trigger above refuses the delete otherwise).
	IF NOT EXISTS (SELECT 1 FROM posting_rule_versions v WHERE v.id = target) THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;

	SELECT EXISTS (
		SELECT 1 FROM journal_entries e WHERE e.posting_rule_version_id = target
	) INTO referenced;

	IF NOT referenced THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;

	RAISE EXCEPTION
		'posting rule version % has posted journal entries: % on its line template is not permitted',
		target, TG_OP
		USING ERRCODE = 'P0001',
		      HINT = 'Create version N+1 with the corrected template; entries already posted are corrected by reversal and repost.';
END;
$loxep_posting_rule_lines_immutable$;
--> statement-breakpoint
CREATE TRIGGER "posting_rule_lines_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "posting_rule_lines"
FOR EACH ROW EXECUTE FUNCTION "loxep_posting_rule_lines_immutable"();