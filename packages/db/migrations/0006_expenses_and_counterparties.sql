-- Phase 5 expenses and Phase 6 counterparties: two PARTIAL slices, six tables.
--
-- This migration is deliberately not "Phase 5" or "Phase 6". It ships the two
-- pieces of those designs that are usable without answering any of their six
-- OWNER-REVIEW-CRITICAL open questions, and it ships nothing else.
--
--   from financial-schema-design.md   expenses, expense_allocations   (2 of 22)
--   from services-billing-schema-design.md
--                                     counterparties, counterparty_contacts,
--                                     contact_channels,
--                                     counterparty_entity_roles      (4 of 19)
--
-- ## What this migration deliberately does NOT create
--
--   accounting_books / book_entity_links   OQ1 unresolved: book granularity and
--                                          whether the entity link ROUTES or
--                                          merely DESCRIBES. Unrecoverable
--                                          after the first entry posts.
--   ledger_accounts / dimensions / periods no chart of accounts exists yet
--   journal_entries / journal_lines        OQ2 unresolved: reversal-and-repost
--                                          versus mutation
--   posting_rules / rule versions / lines  same
--   financial_accounts / payouts / banking / reconciliation / sales_tax_facts
--   projects / time_entries / billing_rates / project_material_uses
--   service_plans / subscriptions / service_periods
--   invoices / invoice_lines / invoice_payments / invoice_line_sources
--   counterparty_sites                     its only Phase 6 consumers are
--                                          projects and invoices; neither ships
--   counterparty_identifiers               its purpose is backfilling
--                                          orders.counterparty_id, an ALTER on
--                                          a Phase 3 table this does not make
--
-- **No existing table gains a column.** Phase 6's design is the first that
-- would have altered tables it does not own (orders, expenses,
-- expense_allocations, posting_rules, reconciliation_matches, resource_links);
-- none of those alterations is here, because every one of them serves a table
-- that does not exist yet.
--
-- ## The posting seam, since there is no journal to point at
--
-- `expenses` carries no journal_entry_id, no posting_key, and no FK into any
-- ledger table. That absence is the design working, not the design missing.
-- Phase 5 posts through SOURCE-FACT IDENTITY: an entry stamps
-- (source_fact_type, source_fact_id) and derives its idempotency key from them
-- (`'pr:' || rule_code || ':v' || version || ':' || type || ':' || id`), with
-- deliberately NO foreign key, because a posted entry must survive the deletion
-- of its source fact. The only thing this table therefore owes a future ledger
-- is a stable identity, and it has one: ('expense', expenses.id). It is
-- expressed in code as EXPENSE_SOURCE_FACT_TYPE / expenseSourceFact() in
-- @loxep/accounting, and `expenses.status = 'posted'` is the state the posting
-- engine will one day set and nothing in this slice can reach.
--
-- ## PROVISIONAL
--
-- Every decision below implements the owning design's own documented
-- recommendation under an explicit owner directive, pending review. The ones
-- visible in this DDL:
--
--   * expenses.category is an OPEN set (text + TS union, no CHECK) while
--     payment_method, status, and entity_attribution_source are CHECKed —
--     categories are the first thing an operator customizes;
--   * expenses.payee_name stays denormalized text; no counterparty FK is added,
--     even though counterparties now exist in the same migration. Phase 6 owns
--     that column and Phase 6's matching table is not here;
--   * sum(expense_allocations.amount) = expenses.amount is a SERVICE rule and a
--     report, NOT a constraint — a draft expense is legitimately partly
--     allocated. There is deliberately no trigger;
--   * expense_allocations.acquisition_id and expenses.acquisition_cost_id are
--     REAL foreign keys. The design left them as bare uuids because Phase 4 had
--     not shipped; it has (migration 0005), and the design's own instruction
--     was to make them real in that case;
--   * counterparties has NO economic_entity_id, and economic_entities gains no
--     counterparty_id. The only meeting point is counterparty_entity_roles,
--     whose row reads in exactly one direction;
--   * counterparties_tax_identifier_org_check refuses a tax identifier on a
--     person. Payroll is a permanent non-goal and the database says so;
--   * roles are relationship rows with a NULLABLE economic_entity_id and
--     UNIQUE NULLS NOT DISTINCT, so a party cannot hold two installation-wide
--     `customer` rows. There is no is_customer/is_vendor pair anywhere;
--   * merged_into_counterparty_id is a survivor pointer. Nothing is deleted and
--     no history foreign key is ever rewritten; @loxep/counterparties owns the
--     one resolver every read path uses.
--
-- ## Verified at implementation time (drizzle-kit 0.31.10, pg18)
--
-- Everything generated correctly from the Drizzle schema and NOTHING needed
-- hand-written SQL or was weakened: UNIQUE ... NULLS NOT DISTINCT
-- (contact_channels, counterparty_entity_roles), num_nonnulls CHECKs
-- (contact_channels, expense_allocations), partial unique indexes with boolean
-- predicates (counterparty_contacts, contact_channels), partial plain indexes,
-- DESC index ordering, and a unique index over a coalesce() EXPRESSION
-- (contact_channels_owner_kind_primary_uq — drizzle's uniqueIndex has no
-- nullsNotDistinct(), so the design's own named portable fallback is used).
--
-- Five foreign keys are named explicitly because their derived names would run
-- 64-72 bytes and be silently truncated at PostgreSQL's 63-byte identifier
-- limit: the counterparties self-reference and mirror, the contact_channels
-- contact reference, and all three long references on counterparty_entity_roles.
--
-- None of these tables is a Timescale hypertable.
CREATE TABLE "expense_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"economic_entity_id" uuid,
	"acquisition_id" uuid,
	"catalog_item_id" uuid,
	"channel" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_allocations_expense_line_uq" UNIQUE("expense_id","line_number"),
	CONSTRAINT "expense_allocations_amount_check" CHECK ("expense_allocations"."amount" <> 0),
	CONSTRAINT "expense_allocations_line_number_check" CHECK ("expense_allocations"."line_number" > 0),
	CONSTRAINT "expense_allocations_target_check" CHECK (num_nonnulls("expense_allocations"."economic_entity_id", "expense_allocations"."acquisition_id", "expense_allocations"."catalog_item_id", "expense_allocations"."channel") >= 1)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"economic_entity_id" uuid,
	"entity_attribution_source" text NOT NULL,
	"entity_attributed_at" timestamp with time zone,
	"entity_attributed_by_user_id" text,
	"reference_code" text NOT NULL,
	"expense_date" date NOT NULL,
	"payee_name" text,
	"category" text NOT NULL,
	"description" text,
	"currency" char(3) NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"tax_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"payment_method" text NOT NULL,
	"acquisition_cost_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"reimbursable" boolean DEFAULT false NOT NULL,
	"recurring_group_key" text,
	"notes" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_reference_code_uq" UNIQUE("reference_code"),
	CONSTRAINT "expenses_amount_check" CHECK ("expenses"."amount" <> 0),
	CONSTRAINT "expenses_entity_attribution_source_check" CHECK ("expenses"."entity_attribution_source" in ('manual', 'installation_default', 'unattributed')),
	CONSTRAINT "expenses_status_check" CHECK ("expenses"."status" in ('draft', 'recorded', 'posted', 'void')),
	CONSTRAINT "expenses_payment_method_check" CHECK ("expenses"."payment_method" in ('card', 'cash', 'bank_transfer', 'marketplace_balance', 'direct_debit', 'other'))
);
--> statement-breakpoint
CREATE TABLE "contact_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"counterparty_id" uuid,
	"counterparty_contact_id" uuid,
	"channel_kind" text NOT NULL,
	"value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"label" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_channels_owner_kind_value_uq" UNIQUE NULLS NOT DISTINCT("counterparty_id","counterparty_contact_id","channel_kind","normalized_value"),
	CONSTRAINT "contact_channels_owner_check" CHECK (num_nonnulls("contact_channels"."counterparty_id", "contact_channels"."counterparty_contact_id") = 1),
	CONSTRAINT "contact_channels_kind_check" CHECK ("contact_channels"."channel_kind" in ('email', 'phone', 'mobile', 'fax', 'website', 'marketplace_handle', 'messaging', 'other'))
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_code" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"normalized_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"default_currency" char(3),
	"tax_identifier_kind" text,
	"tax_identifier" text,
	"notes" text,
	"mirrors_economic_entity_id" uuid,
	"merged_into_counterparty_id" uuid,
	"merged_at" timestamp with time zone,
	"merged_by_user_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparties_reference_code_uq" UNIQUE("reference_code"),
	CONSTRAINT "counterparties_kind_check" CHECK ("counterparties"."kind" in ('person', 'organization')),
	CONSTRAINT "counterparties_status_check" CHECK ("counterparties"."status" in ('active', 'inactive', 'archived')),
	CONSTRAINT "counterparties_tax_identifier_org_check" CHECK ("counterparties"."tax_identifier" is null or "counterparties"."kind" = 'organization'),
	CONSTRAINT "counterparties_tax_identifier_pair_check" CHECK (("counterparties"."tax_identifier" is null) = ("counterparties"."tax_identifier_kind" is null)),
	CONSTRAINT "counterparties_tax_identifier_kind_check" CHECK ("counterparties"."tax_identifier_kind" is null or "counterparties"."tax_identifier_kind" in ('vat', 'gst', 'abn', 'ein', 'company_number', 'other')),
	CONSTRAINT "counterparties_self_merge_check" CHECK ("counterparties"."merged_into_counterparty_id" is distinct from "counterparties"."id"),
	CONSTRAINT "counterparties_merge_pair_check" CHECK (("counterparties"."merged_into_counterparty_id" is null) = ("counterparties"."merged_at" is null))
);
--> statement-breakpoint
CREATE TABLE "counterparty_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"role_title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparty_contacts_status_check" CHECK ("counterparty_contacts"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "counterparty_entity_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"economic_entity_id" uuid,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"since_on" date,
	"until_on" date,
	"payment_terms_days" integer,
	"default_currency" char(3),
	"tax_treatment" text,
	"billing_contact_id" uuid,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparty_entity_roles_party_entity_role_uq" UNIQUE NULLS NOT DISTINCT("counterparty_id","economic_entity_id","role"),
	CONSTRAINT "counterparty_entity_roles_role_check" CHECK ("counterparty_entity_roles"."role" in ('customer', 'vendor', 'payer', 'payee', 'consignor', 'subcontractor', 'partner', 'other')),
	CONSTRAINT "counterparty_entity_roles_status_check" CHECK ("counterparty_entity_roles"."status" in ('active', 'inactive')),
	CONSTRAINT "counterparty_entity_roles_dates_check" CHECK ("counterparty_entity_roles"."until_on" is null or "counterparty_entity_roles"."since_on" is null or "counterparty_entity_roles"."until_on" >= "counterparty_entity_roles"."since_on"),
	CONSTRAINT "counterparty_entity_roles_terms_check" CHECK ("counterparty_entity_roles"."payment_terms_days" is null or "counterparty_entity_roles"."payment_terms_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_acquisition_id_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_entity_attributed_by_user_id_user_id_fk" FOREIGN KEY ("entity_attributed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_acquisition_cost_id_acquisition_costs_id_fk" FOREIGN KEY ("acquisition_cost_id") REFERENCES "public"."acquisition_costs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_contact_fk" FOREIGN KEY ("counterparty_contact_id") REFERENCES "public"."counterparty_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_merged_by_user_id_user_id_fk" FOREIGN KEY ("merged_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_merged_into_fk" FOREIGN KEY ("merged_into_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_mirrors_entity_fk" FOREIGN KEY ("mirrors_economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_contacts" ADD CONSTRAINT "counterparty_contacts_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_entity_roles" ADD CONSTRAINT "counterparty_entity_roles_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_entity_roles" ADD CONSTRAINT "counterparty_entity_roles_party_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_entity_roles" ADD CONSTRAINT "counterparty_entity_roles_entity_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_entity_roles" ADD CONSTRAINT "counterparty_entity_roles_billing_contact_fk" FOREIGN KEY ("billing_contact_id") REFERENCES "public"."counterparty_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_allocations_expense_id_idx" ON "expense_allocations" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_allocations_acquisition_id_idx" ON "expense_allocations" USING btree ("acquisition_id") WHERE "expense_allocations"."acquisition_id" is not null;--> statement-breakpoint
CREATE INDEX "expenses_entity_date_idx" ON "expenses" USING btree ("economic_entity_id","expense_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "expenses_category_date_idx" ON "expenses" USING btree ("category","expense_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "expenses_posting_backlog_idx" ON "expenses" USING btree ("status") WHERE "expenses"."status" <> 'posted';--> statement-breakpoint
CREATE INDEX "expenses_acquisition_cost_id_idx" ON "expenses" USING btree ("acquisition_cost_id") WHERE "expenses"."acquisition_cost_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_channels_owner_kind_primary_uq" ON "contact_channels" USING btree (coalesce("counterparty_id", "counterparty_contact_id"),"channel_kind") WHERE "contact_channels"."is_primary";--> statement-breakpoint
CREATE INDEX "contact_channels_normalized_value_idx" ON "contact_channels" USING btree ("normalized_value");--> statement-breakpoint
CREATE INDEX "contact_channels_counterparty_id_idx" ON "contact_channels" USING btree ("counterparty_id") WHERE "contact_channels"."counterparty_id" is not null;--> statement-breakpoint
CREATE INDEX "contact_channels_contact_id_idx" ON "contact_channels" USING btree ("counterparty_contact_id") WHERE "contact_channels"."counterparty_contact_id" is not null;--> statement-breakpoint
CREATE INDEX "counterparties_normalized_name_idx" ON "counterparties" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "counterparties_merged_into_idx" ON "counterparties" USING btree ("merged_into_counterparty_id") WHERE "counterparties"."merged_into_counterparty_id" is not null;--> statement-breakpoint
CREATE INDEX "counterparties_mirrors_entity_idx" ON "counterparties" USING btree ("mirrors_economic_entity_id") WHERE "counterparties"."mirrors_economic_entity_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "counterparty_contacts_primary_uq" ON "counterparty_contacts" USING btree ("counterparty_id") WHERE "counterparty_contacts"."is_primary";--> statement-breakpoint
CREATE INDEX "counterparty_contacts_counterparty_id_idx" ON "counterparty_contacts" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "counterparty_entity_roles_counterparty_id_idx" ON "counterparty_entity_roles" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "counterparty_entity_roles_entity_role_idx" ON "counterparty_entity_roles" USING btree ("economic_entity_id","role") WHERE "counterparty_entity_roles"."economic_entity_id" is not null;