-- Phase 5, milestone 1: books, the chart of accounts, and the double-entry
-- journal. NINE of the financial design's twenty-two tables — its own
-- "Migration A", written after the three OWNER-REVIEW-CRITICAL open questions
-- were answered by the owner on 2026-08-12 and not one day before.
--
--   accounting_books                the explicit set of books (never an entity)
--   book_entity_links               effective-dated routing, posting_primary
--                                   at most once per entity per day
--   ledger_accounts                 the per-book chart of accounts
--   accounting_dimensions           optional classes/departments/segments,
--   accounting_dimension_values     shipped EMPTY by design
--   fiscal_periods                  boundaries and soft-close semantics
--   journal_entries / journal_lines the journal, signed amounts, composite
--                                   same-book foreign keys
--   journal_line_dimensions         at most one value per dimension per line
--
-- ## The owner's answers, and where each one is physical
--
--   1 BOOK GRANULARITY — books are toggleable per economic entity, and
--     entities relate as included-in/part-of: a child entity's posting_primary
--     book IS its parent's book, and per-entity views are reporting slices over
--     journal_lines.economic_entity_id rather than separate ledgers.
--       -> book_entity_links + the EXCLUDE constraint below. There is NO
--          economic_entity_id on accounting_books and NO accounting_book_id on
--          economic_entities. That prohibition (ADR-0017) is the single
--          most-repeated rule in the documentation and this is the migration
--          that would have broken it.
--   2 POSTING-RULE MUTABILITY — immutable versions; corrections are reversal
--     plus repost, never mutation.
--       -> journal_entries.reverses_entry_id, and the immutability triggers
--          below. The one whitelisted UPDATE on a posted entry is the
--          posted -> reversed stamp, which changes nothing else.
--   3 FUNCTIONAL CURRENCY — USD-only for the initial build, with the
--     multi-currency seam kept so other currencies wire in later without
--     restating a single stored amount.
--       -> journal_lines keeps currency/amount AND functional_currency/
--          functional_amount/fx_rate/fx_rate_source/fx_rate_at. USD is refused
--          at the @loxep/accounting service boundary, NOT by a CHECK: a
--          constraint that must be dropped to use a designed column is not a
--          safety rail.
--
-- ## What this migration deliberately does NOT create
--
--   posting_rules / posting_rule_versions / posting_rule_lines   next milestone
--   journal_entry_source_links                                   next milestone
--   journal_entries.posting_rule_version_id   a column pointing at a table that
--                                             does not exist is worse than no
--                                             column; the design's own plan
--                                             activates this FK in Migration B,
--                                             together with the paired
--                                             (entry_source = 'posting_rule') =
--                                             (version_id is not null) CHECK.
--   financial_accounts / payouts / payout_lines / bank ingestion /
--     reconciliation_matches / sales_tax_facts                   later milestone
--
-- **No existing table gains a column.** expenses keeps no accounting_book_id,
-- no journal_entry_id, and no posting_key: the seam between a fact and an entry
-- is a source-fact IDENTITY (source_fact_type, source_fact_id), deliberately
-- unenforced, so that a posted entry survives the deletion of its source fact.
--
-- ## Hand-written SQL, and why each piece is not generated
--
-- Verified against drizzle-kit 0.31.10, drizzle-orm 0.45.2, and
-- timescale/timescaledb-ha:pg18.4-ts2.29.1-all (PostgreSQL 18.4) at
-- implementation time. Composite foreign keys, partial unique indexes,
-- num_nonnulls CHECKs, and expression index predicates all generate correctly
-- and NOTHING was weakened to fit. Four things are beyond drizzle-kit and are
-- appended by hand at the end of this file:
--
--   1 EXCLUDE USING gist on book_entity_links   the routing invariant
--   2 EXCLUDE USING gist on fiscal_periods      no overlapping periods
--   3 a DEFERRABLE INITIALLY DEFERRED CONSTRAINT TRIGGER pair               the
--     per-entry, per-currency balance check. A deferred CHECK does not exist in
--     PostgreSQL — only UNIQUE, PRIMARY KEY, FOREIGN KEY and EXCLUDE may be
--     DEFERRABLE — which is worth stating because it is the first thing an
--     implementer tries.
--   4 BEFORE triggers for posted-entry immutability and the fiscal-period
--     posting guard, mirroring 0005's inventory_movements append-only trigger:
--     an invariant that lives only in TypeScript is a convention, and every
--     package in this monolith can reach these tables.
--
-- btree_gist supplies the `uuid WITH =` operand both exclusions need. It is
-- available in the deployment image (version 1.8, verified), so the design's
-- documented weaker fallback — a partial unique on open-ended rows plus a
-- service-level overlap check — was NOT needed and is not used.
--
-- ## PROVISIONAL
--
-- Every non-critical open question this milestone touched is resolved per the
-- design's own documented recommendation under the owner's provisional-decision
-- directive, pending review. See "Provisional implementation decisions" in
-- apps/docs/src/content/docs/architecture/financial-schema-design.md.
CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
CREATE TABLE "accounting_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"functional_currency" char(3) DEFAULT 'USD' NOT NULL,
	"accounting_basis" text DEFAULT 'accrual' NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"fiscal_year_start_day" integer DEFAULT 1 NOT NULL,
	"requires_entity_dimension" boolean DEFAULT false NOT NULL,
	"next_entry_number" bigint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"opened_on" date NOT NULL,
	"notes" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_books_code_uq" UNIQUE("code"),
	CONSTRAINT "accounting_books_accounting_basis_check" CHECK ("accounting_books"."accounting_basis" in ('cash', 'accrual')),
	CONSTRAINT "accounting_books_status_check" CHECK ("accounting_books"."status" in ('active', 'archived')),
	CONSTRAINT "accounting_books_fiscal_year_start_month_check" CHECK ("accounting_books"."fiscal_year_start_month" between 1 and 12),
	CONSTRAINT "accounting_books_fiscal_year_start_day_check" CHECK ("accounting_books"."fiscal_year_start_day" between 1 and 31),
	CONSTRAINT "accounting_books_next_entry_number_check" CHECK ("accounting_books"."next_entry_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "accounting_dimension_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dimension_id" uuid NOT NULL,
	"parent_value_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_dimension_values_dimension_code_uq" UNIQUE("dimension_id","code"),
	CONSTRAINT "accounting_dimension_values_parent_self_check" CHECK ("accounting_dimension_values"."parent_value_id" is distinct from "accounting_dimension_values"."id")
);
--> statement-breakpoint
CREATE TABLE "accounting_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accounting_book_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_dimensions_book_code_uq" UNIQUE("accounting_book_id","code"),
	CONSTRAINT "accounting_dimensions_book_id_uq" UNIQUE("accounting_book_id","id")
);
--> statement-breakpoint
CREATE TABLE "book_entity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accounting_book_id" uuid NOT NULL,
	"economic_entity_id" uuid NOT NULL,
	"link_role" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"dimension_label" text,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_entity_links_link_role_check" CHECK ("book_entity_links"."link_role" in ('posting_primary', 'reporting_only')),
	CONSTRAINT "book_entity_links_effective_range_check" CHECK ("book_entity_links"."effective_to" is null or "book_entity_links"."effective_to" >= "book_entity_links"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accounting_book_id" uuid NOT NULL,
	"period_code" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"sequence" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_periods_book_period_code_uq" UNIQUE("accounting_book_id","period_code"),
	CONSTRAINT "fiscal_periods_book_year_sequence_uq" UNIQUE("accounting_book_id","fiscal_year","sequence"),
	CONSTRAINT "fiscal_periods_book_id_uq" UNIQUE("accounting_book_id","id"),
	CONSTRAINT "fiscal_periods_range_check" CHECK ("fiscal_periods"."ends_on" >= "fiscal_periods"."starts_on"),
	CONSTRAINT "fiscal_periods_status_check" CHECK ("fiscal_periods"."status" in ('open', 'soft_closed', 'closed', 'locked'))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accounting_book_id" uuid NOT NULL,
	"entry_number" bigint,
	"fiscal_period_id" uuid,
	"entry_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"entry_source" text NOT NULL,
	"posting_key" text,
	"source_fact_type" text,
	"source_fact_id" uuid,
	"source_fact_fingerprint" text,
	"reverses_entry_id" uuid,
	"is_backdated" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"memo" text,
	"posted_at" timestamp with time zone,
	"posted_by_user_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_book_id_uq" UNIQUE("accounting_book_id","id"),
	CONSTRAINT "journal_entries_status_check" CHECK ("journal_entries"."status" in ('draft', 'posted', 'reversed', 'void')),
	CONSTRAINT "journal_entries_entry_source_check" CHECK ("journal_entries"."entry_source" in ('posting_rule', 'manual', 'import', 'opening_balance')),
	CONSTRAINT "journal_entries_posted_completeness_check" CHECK ("journal_entries"."status" not in ('posted', 'reversed')
          or ("journal_entries"."entry_number" is not null
              and "journal_entries"."fiscal_period_id" is not null
              and "journal_entries"."posted_at" is not null)),
	CONSTRAINT "journal_entries_reverses_self_check" CHECK ("journal_entries"."reverses_entry_id" is distinct from "journal_entries"."id"),
	CONSTRAINT "journal_entries_source_fact_check" CHECK (num_nonnulls("journal_entries"."source_fact_type", "journal_entries"."source_fact_id") <> 1)
);
--> statement-breakpoint
CREATE TABLE "journal_line_dimensions" (
	"journal_line_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"dimension_value_id" uuid NOT NULL,
	CONSTRAINT "journal_line_dimensions_pk" PRIMARY KEY("journal_line_id","dimension_id")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"accounting_book_id" uuid NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"economic_entity_id" uuid,
	"line_number" integer NOT NULL,
	"description" text,
	"currency" char(3) NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"functional_currency" char(3) NOT NULL,
	"functional_amount" numeric(20, 6) NOT NULL,
	"fx_rate" numeric(24, 12) DEFAULT '1' NOT NULL,
	"fx_rate_source" text DEFAULT 'unity' NOT NULL,
	"fx_rate_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_entry_line_number_uq" UNIQUE("journal_entry_id","line_number"),
	CONSTRAINT "journal_lines_amount_check" CHECK ("journal_lines"."amount" <> 0),
	CONSTRAINT "journal_lines_line_number_check" CHECK ("journal_lines"."line_number" > 0),
	CONSTRAINT "journal_lines_fx_rate_check" CHECK ("journal_lines"."fx_rate" > 0),
	CONSTRAINT "journal_lines_unity_check" CHECK (("journal_lines"."currency" = "journal_lines"."functional_currency") = ("journal_lines"."fx_rate_source" = 'unity')),
	CONSTRAINT "journal_lines_fx_rate_source_check" CHECK ("journal_lines"."fx_rate_source" in ('unity', 'provider_reported', 'manual', 'imported'))
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accounting_book_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"account_type" text NOT NULL,
	"account_subtype" text,
	"parent_account_id" uuid,
	"is_postable" boolean DEFAULT true NOT NULL,
	"is_contra" boolean DEFAULT false NOT NULL,
	"system_key" text,
	"currency" char(3),
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_book_code_uq" UNIQUE("accounting_book_id","code"),
	CONSTRAINT "ledger_accounts_book_id_uq" UNIQUE("accounting_book_id","id"),
	CONSTRAINT "ledger_accounts_account_type_check" CHECK ("ledger_accounts"."account_type" in ('asset', 'liability', 'equity', 'revenue', 'expense')),
	CONSTRAINT "ledger_accounts_status_check" CHECK ("ledger_accounts"."status" in ('active', 'archived')),
	CONSTRAINT "ledger_accounts_parent_self_check" CHECK ("ledger_accounts"."parent_account_id" is distinct from "ledger_accounts"."id")
);
--> statement-breakpoint
ALTER TABLE "accounting_books" ADD CONSTRAINT "accounting_books_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_dimension_values" ADD CONSTRAINT "accounting_dimension_values_dimension_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."accounting_dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_dimension_values" ADD CONSTRAINT "accounting_dimension_values_parent_fk" FOREIGN KEY ("parent_value_id") REFERENCES "public"."accounting_dimension_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_dimensions" ADD CONSTRAINT "accounting_dimensions_book_fk" FOREIGN KEY ("accounting_book_id") REFERENCES "public"."accounting_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_entity_links" ADD CONSTRAINT "book_entity_links_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_entity_links" ADD CONSTRAINT "book_entity_links_book_fk" FOREIGN KEY ("accounting_book_id") REFERENCES "public"."accounting_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_entity_links" ADD CONSTRAINT "book_entity_links_entity_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_book_fk" FOREIGN KEY ("accounting_book_id") REFERENCES "public"."accounting_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_user_id_user_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_book_fk" FOREIGN KEY ("accounting_book_id") REFERENCES "public"."accounting_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_fk" FOREIGN KEY ("accounting_book_id","fiscal_period_id") REFERENCES "public"."fiscal_periods"("accounting_book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_line_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_dimension_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."accounting_dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_value_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."accounting_dimension_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_book_entry_fk" FOREIGN KEY ("accounting_book_id","journal_entry_id") REFERENCES "public"."journal_entries"("accounting_book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_book_account_fk" FOREIGN KEY ("accounting_book_id","ledger_account_id") REFERENCES "public"."ledger_accounts"("accounting_book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entity_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_book_fk" FOREIGN KEY ("accounting_book_id") REFERENCES "public"."accounting_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_fk" FOREIGN KEY ("accounting_book_id","parent_account_id") REFERENCES "public"."ledger_accounts"("accounting_book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_entity_links_entity_effective_idx" ON "book_entity_links" USING btree ("economic_entity_id","effective_from");--> statement-breakpoint
CREATE INDEX "book_entity_links_book_idx" ON "book_entity_links" USING btree ("accounting_book_id");--> statement-breakpoint
CREATE INDEX "fiscal_periods_book_starts_on_idx" ON "fiscal_periods" USING btree ("accounting_book_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_book_entry_number_uq" ON "journal_entries" USING btree ("accounting_book_id","entry_number") WHERE entry_number is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_posting_key_uq" ON "journal_entries" USING btree ("posting_key") WHERE posting_key is not null;--> statement-breakpoint
CREATE INDEX "journal_entries_book_entry_date_idx" ON "journal_entries" USING btree ("accounting_book_id","entry_date");--> statement-breakpoint
CREATE INDEX "journal_entries_source_fact_idx" ON "journal_entries" USING btree ("source_fact_type","source_fact_id");--> statement-breakpoint
CREATE INDEX "journal_entries_reverses_entry_id_idx" ON "journal_entries" USING btree ("reverses_entry_id") WHERE reverses_entry_id is not null;--> statement-breakpoint
CREATE INDEX "journal_line_dimensions_value_idx" ON "journal_line_dimensions" USING btree ("dimension_value_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_book_account_idx" ON "journal_lines" USING btree ("accounting_book_id","ledger_account_id","id");--> statement-breakpoint
CREATE INDEX "journal_lines_book_entity_idx" ON "journal_lines" USING btree ("accounting_book_id","economic_entity_id") WHERE economic_entity_id is not null;--> statement-breakpoint
CREATE INDEX "journal_lines_foreign_currency_idx" ON "journal_lines" USING btree ("ledger_account_id","currency") WHERE currency <> functional_currency;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_book_system_key_uq" ON "ledger_accounts" USING btree ("accounting_book_id","system_key") WHERE system_key is not null;--> statement-breakpoint
CREATE INDEX "ledger_accounts_book_type_idx" ON "ledger_accounts" USING btree ("accounting_book_id","account_type");--> statement-breakpoint
CREATE INDEX "ledger_accounts_book_parent_idx" ON "ledger_accounts" USING btree ("accounting_book_id","parent_account_id") WHERE parent_account_id is not null;--> statement-breakpoint
-- ===========================================================================
-- HAND-WRITTEN: the constraints drizzle-kit cannot express.
-- ===========================================================================

-- The routing invariant: NO ENTITY HAS TWO PRIMARY BOOKS ON THE SAME DAY.
--
-- This is what makes "given a fact attributed to entity E on date D, which book
-- does it post to?" single-valued, and therefore what makes routing a lookup
-- rather than a judgement. reporting_only rows are excluded by the predicate
-- because they never route: an entity may be reported in any number of books.
--
-- The range is inclusive on both ends and open-ended when effective_to is null,
-- so a link that is still in force conflicts with every later one.
ALTER TABLE "book_entity_links" ADD CONSTRAINT "book_entity_links_primary_no_overlap"
	EXCLUDE USING gist (
		"economic_entity_id" WITH =,
		daterange("effective_from", COALESCE("effective_to", 'infinity'::date), '[]') WITH &&
	) WHERE ("link_role" = 'posting_primary');
--> statement-breakpoint

-- No two periods of one book overlap. This is the invariant that lets "the
-- period containing this date" be a lookup, which the posting guard below
-- depends on.
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_no_overlap"
	EXCLUDE USING gist (
		"accounting_book_id" WITH =,
		daterange("starts_on", "ends_on", '[]') WITH &&
	);
--> statement-breakpoint

-- PROVISIONAL (design open question 4): per-currency balance enforcement.
--
-- A posted entry's lines sum to zero PER TRANSACTION CURRENCY, and separately
-- its functional amounts sum to zero. The options were analyzed in the design:
-- a service-layer rule is only as strong as code review; a deferred CHECK does
-- not exist in PostgreSQL; a materialized balance row is a second thing to
-- drift. What remains is a CONSTRAINT TRIGGER that fires at COMMIT, so lines
-- may be inserted one statement at a time and the entry only has to balance
-- when the transaction ends.
--
-- DRAFTS ARE EXEMPT: an entry being assembled is legitimately unbalanced, and
-- blocking that would make a manual-entry UI impossible. Combined with the
-- immutability triggers below, this check therefore only ever runs on the
-- draft -> posted transition and on inserts into a draft, so its cost is
-- bounded by the size of ONE entry.
--
-- A posted entry with no lines is refused too. It is not a degenerate case of
-- "balanced"; it is a header nobody finished.
CREATE FUNCTION "loxep_journal_entry_balanced"() RETURNS trigger
LANGUAGE plpgsql AS $loxep_journal_balanced$
DECLARE
	target uuid;
	entry_status text;
	entry_number bigint;
	line_count integer;
	offending record;
BEGIN
	IF TG_TABLE_NAME = 'journal_entries' THEN
		target := NEW.id;
	ELSIF TG_OP = 'DELETE' THEN
		target := OLD.journal_entry_id;
	ELSE
		target := NEW.journal_entry_id;
	END IF;

	SELECT e.status, e.entry_number INTO entry_status, entry_number
	  FROM journal_entries e WHERE e.id = target;
	-- The entry itself was deleted in this transaction (draft cleanup): there is
	-- nothing left to balance.
	IF NOT FOUND THEN RETURN NULL; END IF;
	IF entry_status NOT IN ('posted', 'reversed') THEN RETURN NULL; END IF;

	SELECT count(*) INTO line_count FROM journal_lines l WHERE l.journal_entry_id = target;
	IF line_count = 0 THEN
		RAISE EXCEPTION
			'journal entry % (number %) is posted with no lines',
			target, entry_number
			USING ERRCODE = 'P0001';
	END IF;

	SELECT l.currency AS currency, sum(l.amount) AS total INTO offending
	  FROM journal_lines l WHERE l.journal_entry_id = target
	 GROUP BY l.currency HAVING sum(l.amount) <> 0 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION
			'journal entry % (number %) does not balance in %: its lines sum to % instead of 0',
			target, entry_number, offending.currency, offending.total
			USING ERRCODE = 'P0001',
			      HINT = 'Positive is a debit and negative is a credit; every posted entry sums to zero per currency.';
	END IF;

	SELECT l.functional_currency AS currency, sum(l.functional_amount) AS total INTO offending
	  FROM journal_lines l WHERE l.journal_entry_id = target
	 GROUP BY l.functional_currency HAVING sum(l.functional_amount) <> 0 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION
			'journal entry % (number %) does not balance in its functional currency %: functional amounts sum to % instead of 0',
			target, entry_number, offending.currency, offending.total
			USING ERRCODE = 'P0001',
			      HINT = 'When lines use different rates the posting engine adds a balancing fx_gain_loss line; it is never left to the author.';
	END IF;

	RETURN NULL;
END;
$loxep_journal_balanced$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "journal_lines_balanced"
AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "loxep_journal_entry_balanced"();
--> statement-breakpoint
-- The other half: an entry may flip draft -> posted without any line changing
-- in the same transaction, and that transition must be checked too.
CREATE CONSTRAINT TRIGGER "journal_entries_balanced"
AFTER INSERT OR UPDATE ON "journal_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "loxep_journal_entry_balanced"();
--> statement-breakpoint

-- PROVISIONAL (design open question 2, answered by the owner): posted entries
-- are IMMUTABLE. Corrections are reversal entries, never edits.
--
-- This is 0005's append-only rule applied to the ledger, where it is even less
-- negotiable: a ledger whose posted rows can be updated is a spreadsheet.
--
-- Exactly one UPDATE is whitelisted, and it is the one the design's own status
-- vocabulary requires: posted -> reversed, changing NOTHING else. Without it
-- the `reversed` member of journal_entries_status_check would be unreachable —
-- and the marker is worth having, because "this entry has been reversed" is the
-- first question anyone asks of a corrected book. The reversed entry's LINES
-- are untouched and still count in every balance; the reversing entry's own
-- lines are what net them out.
--
-- A migration that genuinely must repair ledger data drops these triggers,
-- repairs, and recreates them in the same migration. That is a feature: it puts
-- the exception in the diff where a reviewer sees it.
CREATE FUNCTION "loxep_journal_entries_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $loxep_journal_entries_immutable$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.status = 'draft' THEN RETURN OLD; END IF;
		RAISE EXCEPTION
			'journal_entries is immutable once posted: DELETE of a % entry is not permitted',
			OLD.status
			USING ERRCODE = 'P0001',
			      HINT = 'Correct a posted entry by posting a reversing entry, never by deleting it.';
	END IF;

	IF OLD.status = 'draft' THEN RETURN NEW; END IF;

	IF OLD.status = 'posted' AND NEW.status = 'reversed'
	   AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at') THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION
		'journal_entries is immutable once posted: UPDATE of a % entry is not permitted',
		OLD.status
		USING ERRCODE = 'P0001',
		      HINT = 'The only permitted change to a posted entry is the posted -> reversed stamp written when its reversal posts.';
END;
$loxep_journal_entries_immutable$;
--> statement-breakpoint
CREATE TRIGGER "journal_entries_immutable"
BEFORE UPDATE OR DELETE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION "loxep_journal_entries_immutable"();
--> statement-breakpoint

-- The same rule one level down, and it guards INSERT as well as UPDATE and
-- DELETE: adding a BALANCED PAIR of lines to a posted entry would slip past the
-- deferred balance check while silently restating a month somebody has already
-- read. Lines are written while the entry is a draft, and the entry is posted
-- afterwards.
CREATE FUNCTION "loxep_journal_lines_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $loxep_journal_lines_immutable$
DECLARE
	target uuid;
	parent_status text;
BEGIN
	IF TG_OP = 'DELETE' THEN target := OLD.journal_entry_id; ELSE target := NEW.journal_entry_id; END IF;

	SELECT e.status INTO parent_status FROM journal_entries e WHERE e.id = target;
	-- No parent: the entry is being cascaded away, which only a draft can be.
	IF NOT FOUND OR parent_status = 'draft' THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;

	RAISE EXCEPTION
		'journal_lines is immutable once its entry is posted: % on a line of a % entry is not permitted',
		TG_OP, parent_status
		USING ERRCODE = 'P0001',
		      HINT = 'Post a reversing entry and a corrected entry; the ledger records what changed rather than hiding it.';
END;
$loxep_journal_lines_immutable$;
--> statement-breakpoint
CREATE TRIGGER "journal_lines_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
FOR EACH ROW EXECUTE FUNCTION "loxep_journal_lines_immutable"();
--> statement-breakpoint

-- PROVISIONAL (design open question 5): the fiscal-period posting guard.
--
--   open          ordinary posting
--   soft_closed   ordinary posting BLOCKED; an explicitly authorized backdated
--                 posting is permitted and MUST carry is_backdated = true, so
--                 the delta between the statement printed on the 1st and the
--                 statement today is answerable by query
--   closed        blocked; reopening is an explicit audited action
--   locked        blocked; no application path reopens it
--
-- Soft close is the default post-period state because provider facts genuinely
-- arrive late — a final-value-fee adjustment three days after month end, a
-- payout covering the 28th-31st landing on the 4th, a carrier reweigh a week
-- later — and the alternative, posting a March fee into April, silently
-- misstates two periods with nothing on either statement saying so.
--
-- The guard also enforces the STAMP: a posted entry's fiscal_period_id must be
-- the period of its own book whose range contains its entry_date. The composite
-- foreign key already guarantees the book matches; this guarantees the date
-- does, which is what stops an entry from being filed in the wrong month while
-- looking perfectly well-formed.
--
-- WHO may backdate is deliberately not decided here. The trigger enforces the
-- flag; the design leaves admin-versus-member to the owner, and the service
-- requires an explicit opt-in parameter rather than inventing a role rule.
CREATE FUNCTION "loxep_journal_entries_period_guard"() RETURNS trigger
LANGUAGE plpgsql AS $loxep_journal_entries_period_guard$
DECLARE
	period record;
BEGIN
	IF NEW.status NOT IN ('posted', 'reversed') THEN RETURN NEW; END IF;

	-- The reversal stamp changes neither the date nor the period; re-guarding it
	-- would make a legitimate reversal impossible once its original's period
	-- closed, which is precisely the case reversal exists to serve.
	IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'reversed')
	   AND OLD.entry_date IS NOT DISTINCT FROM NEW.entry_date
	   AND OLD.fiscal_period_id IS NOT DISTINCT FROM NEW.fiscal_period_id THEN
		RETURN NEW;
	END IF;

	SELECT p.id, p.period_code, p.status, p.starts_on, p.ends_on INTO period
	  FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION
			'journal entry % cannot post: no fiscal period is stamped on it',
			NEW.id
			USING ERRCODE = 'P0001',
			      HINT = 'Periods are generated, never auto-created on demand; a date with no period is an unpostable-backlog item.';
	END IF;

	IF NEW.entry_date < period.starts_on OR NEW.entry_date > period.ends_on THEN
		RAISE EXCEPTION
			'journal entry % has entry_date % outside its stamped period % (% .. %)',
			NEW.id, NEW.entry_date, period.period_code, period.starts_on, period.ends_on
			USING ERRCODE = 'P0001';
	END IF;

	IF period.status IN ('closed', 'locked') THEN
		RAISE EXCEPTION
			'fiscal period % is %: posting into it is blocked',
			period.period_code, period.status
			USING ERRCODE = 'P0001',
			      HINT = 'Post the correction into an open period instead; reversal-and-repost degrades gracefully to the current period.';
	END IF;

	IF period.status = 'soft_closed' AND NOT NEW.is_backdated THEN
		RAISE EXCEPTION
			'fiscal period % is soft_closed: ordinary posting is blocked',
			period.period_code
			USING ERRCODE = 'P0001',
			      HINT = 'An authorized backdated posting is permitted and must be flagged is_backdated = true so the restatement is visible.';
	END IF;

	RETURN NEW;
END;
$loxep_journal_entries_period_guard$;
--> statement-breakpoint
CREATE TRIGGER "journal_entries_period_guard"
BEFORE INSERT OR UPDATE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION "loxep_journal_entries_period_guard"();
