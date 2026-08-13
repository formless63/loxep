-- Phase 6 "Migration B" (loxep-nw0): projects, time, rates, materials, and
-- the counterparty_sites table this slice pulls forward from "Migration A".
--
-- From services-billing-schema-design.md: `counterparty_sites`, `projects`,
-- `billing_rates`, `time_entries`, `project_material_uses` (5 of 19).
--
-- ## Why counterparty_sites ships in THIS migration, not Migration A
--
-- Migration 0006 deferred `counterparty_sites` because its only Phase 6
-- consumers are projects and invoices, and neither had shipped. Projects ship
-- here, so the site table ships with them rather than waiting for a sixth
-- migration purely to preserve the design's original A/B split. This is a
-- sequencing choice, not a design change: every column, CHECK, and FK below
-- matches the design's own sketch.
--
-- ## What this migration deliberately does NOT create
--
--   counterparty_identifiers            still deferred; its purpose is
--                                        backfilling orders.counterparty_id,
--                                        an ALTER on a Phase 3 table this does
--                                        not make
--   service_plans / subscriptions / subscription_items / service_periods /
--     service_period_charges            Migration C — services milestone
--   invoices / invoice_lines / invoice_line_sources / invoice_payments
--                                        Migration D — billing milestone
--   expenses.project_id / .payee_counterparty_id / .client_billable
--   expense_allocations.project_id / .counterparty_id / .subscription_id
--                                        promised by the design for Migration
--                                        B, deferred per loxep-nw0's own design
--                                        note pending Phase 5's book/journal
--                                        questions (already answered, but the
--                                        note predates that and this slice
--                                        does not revisit the scoping)
--   posting_rules / reconciliation_matches CHECK widenings, resource_links
--     unique + index                    Billing-milestone and foundation
--                                        concerns, not this slice's
--
-- ## PROVISIONAL, and narrower than the design's own service scope
--
-- Open question 14 (services-billing-schema-design.md) proposes mapping the
-- Projects-and-Work domain to a NEW `@loxep/work` package. New package
-- scaffolding is orchestrator-only, so this migration ships the physical
-- tables and packages/db-level tests for `projects`, `billing_rates`,
-- `time_entries`, and `project_material_uses`, but NO service package reads
-- or writes them yet — no project CRUD, no time-entry recording, no
-- rate-resolution service, no material-use linking, and no unbilled-work read
-- model (which additionally needs `invoice_line_sources`, a Migration-D
-- table). `counterparty_sites` is the one table here with a shipped service,
-- because Customers/Counterparties already has an existing package
-- (`@loxep/counterparties`) under OQ14's own rule. See `bd show loxep-nw0`
-- and the design doc's "Provisional implementation decisions" for the full
-- account.
--
-- Other decisions worth flagging, all implemented per the design's own
-- sketch:
--
--   * projects.project_kind is an OPEN set (text + TS union, no CHECK) even
--     though the design's own "exceptions" list in its conventions section
--     names only projects.status, time_entries.activity_code, and
--     service_plans.plan_kind. The design's own table sketch for `projects`
--     lists no CHECK for project_kind, matching the treatment
--     service_plans.plan_kind gets a few sections later for the identical
--     reason (a classification that grows with practice). Followed literally
--     as sketched; flagged here because the prose and the sketch disagree.
--   * project_material_uses_movement_uq is a PARTIAL unique index (`where ...
--     is not null`), not NULLS NOT DISTINCT: most material uses have no
--     backing movement at all (manual/purchased-for-job/none cost basis), and
--     those nulls must stay distinct from one another. A plain
--     nulls-not-distinct unique would collide them.
--   * counterparty_entity_roles gains billing_site_id, completing the
--     divergence migration 0006 recorded ("carries billing_contact_id and NOT
--     billing_site_id") now that counterparty_sites exists.
--   * billing_rates carries no overlap-prevention constraint across
--     effective-dated rows at the same scope, per the design's own
--     recommendation: an exclusion constraint over a six-shape nullable tuple
--     is hard to write and easy to get wrong for a problem a report solves.
--
CREATE TABLE "counterparty_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"site_code" text NOT NULL,
	"name" text NOT NULL,
	"site_kind" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"locality" text,
	"region" text,
	"postal_code" text,
	"country" char(2),
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"access_notes" text,
	"primary_contact_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparty_sites_site_code_uq" UNIQUE("site_code"),
	CONSTRAINT "counterparty_sites_kind_check" CHECK ("counterparty_sites"."site_kind" in ('billing', 'shipping', 'service', 'remote', 'other')),
	CONSTRAINT "counterparty_sites_latlong_pair_check" CHECK (("counterparty_sites"."latitude" is null) = ("counterparty_sites"."longitude" is null))
);
--> statement-breakpoint
CREATE TABLE "billing_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_kind" text NOT NULL,
	"project_id" uuid,
	"counterparty_id" uuid,
	"subject_user_id" text,
	"subject_counterparty_id" uuid,
	"activity_code" text,
	"economic_entity_id" uuid,
	"rate_kind" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"unit" text DEFAULT 'hour' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_rates_rate_kind_check" CHECK ("billing_rates"."rate_kind" in ('bill', 'cost')),
	CONSTRAINT "billing_rates_unit_check" CHECK ("billing_rates"."unit" in ('hour', 'day', 'fixed')),
	CONSTRAINT "billing_rates_amount_check" CHECK ("billing_rates"."amount" >= 0),
	CONSTRAINT "billing_rates_scope_kind_check" CHECK ("billing_rates"."scope_kind" in ('project_person', 'project', 'counterparty', 'person', 'activity', 'installation')),
	CONSTRAINT "billing_rates_project_scope_check" CHECK (("billing_rates"."scope_kind" in ('project_person', 'project')) = ("billing_rates"."project_id" is not null)),
	CONSTRAINT "billing_rates_counterparty_scope_check" CHECK (("billing_rates"."scope_kind" = 'counterparty') = ("billing_rates"."counterparty_id" is not null)),
	CONSTRAINT "billing_rates_subject_scope_check" CHECK (("billing_rates"."scope_kind" in ('project_person', 'person')) = (num_nonnulls("billing_rates"."subject_user_id", "billing_rates"."subject_counterparty_id") = 1)),
	CONSTRAINT "billing_rates_activity_scope_check" CHECK (("billing_rates"."scope_kind" = 'activity') = ("billing_rates"."activity_code" is not null)),
	CONSTRAINT "billing_rates_effective_range_check" CHECK ("billing_rates"."effective_to" is null or "billing_rates"."effective_to" >= "billing_rates"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "project_material_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"inventory_item_id" uuid,
	"catalog_item_id" uuid,
	"inventory_allocation_id" uuid,
	"inventory_movement_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"consumed_on" date NOT NULL,
	"currency" char(3) NOT NULL,
	"unit_cost_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"cost_basis_source" text NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"markup_percent" numeric(10, 4),
	"unit_charge_amount" numeric(20, 6),
	"locked_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_material_uses_quantity_check" CHECK ("project_material_uses"."quantity" > 0),
	CONSTRAINT "project_material_uses_cost_basis_source_check" CHECK ("project_material_uses"."cost_basis_source" in ('inventory_basis', 'manual', 'purchased_for_job', 'none')),
	CONSTRAINT "project_material_uses_cost_basis_item_check" CHECK (("project_material_uses"."cost_basis_source" = 'inventory_basis') = ("project_material_uses"."inventory_item_id" is not null)),
	CONSTRAINT "project_material_uses_billable_charge_check" CHECK ("project_material_uses"."billable" or "project_material_uses"."unit_charge_amount" is null),
	CONSTRAINT "project_material_uses_markup_check" CHECK ("project_material_uses"."markup_percent" is null or "project_material_uses"."markup_percent" >= -100)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_code" text NOT NULL,
	"parent_project_id" uuid,
	"counterparty_id" uuid,
	"counterparty_site_id" uuid,
	"economic_entity_id" uuid,
	"entity_attribution_source" text NOT NULL,
	"entity_attributed_at" timestamp with time zone,
	"entity_attributed_by_user_id" text,
	"name" text NOT NULL,
	"description" text,
	"project_kind" text NOT NULL,
	"status" text DEFAULT 'lead' NOT NULL,
	"billing_method" text NOT NULL,
	"currency" char(3) NOT NULL,
	"estimate_amount" numeric(20, 6),
	"budget_amount" numeric(20, 6),
	"fixed_price_amount" numeric(20, 6),
	"not_to_exceed_amount" numeric(20, 6),
	"depth" integer DEFAULT 0 NOT NULL,
	"starts_on" date,
	"target_end_on" date,
	"completed_on" date,
	"closed_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_reference_code_uq" UNIQUE("reference_code"),
	CONSTRAINT "projects_no_self_parent_check" CHECK ("projects"."parent_project_id" is distinct from "projects"."id"),
	CONSTRAINT "projects_depth_check" CHECK ("projects"."depth" between 0 and 1),
	CONSTRAINT "projects_entity_attribution_source_check" CHECK ("projects"."entity_attribution_source" in ('manual', 'counterparty_role_default', 'installation_default', 'unattributed')),
	CONSTRAINT "projects_billing_method_check" CHECK ("projects"."billing_method" in ('time_and_materials', 'fixed_price', 'milestone', 'subscription', 'non_billable', 'internal')),
	CONSTRAINT "projects_fixed_price_amount_check" CHECK (("projects"."billing_method" = 'fixed_price') = ("projects"."fixed_price_amount" is not null)),
	CONSTRAINT "projects_internal_no_counterparty_check" CHECK ("projects"."billing_method" <> 'internal' or "projects"."counterparty_id" is null),
	CONSTRAINT "projects_billable_needs_counterparty_check" CHECK ("projects"."billing_method" in ('internal', 'non_billable') or "projects"."counterparty_id" is not null),
	CONSTRAINT "projects_target_end_check" CHECK ("projects"."target_end_on" is null or "projects"."starts_on" is null or "projects"."target_end_on" >= "projects"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"counterparty_id" uuid,
	"economic_entity_id" uuid,
	"worked_by_user_id" text,
	"worked_by_counterparty_id" uuid,
	"worked_by_label" text NOT NULL,
	"activity_code" text,
	"description" text,
	"worked_on" date NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"minutes" integer NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"billable_minutes" integer DEFAULT 0 NOT NULL,
	"currency" char(3),
	"bill_rate_amount" numeric(20, 6),
	"bill_rate_source" text DEFAULT 'unresolved' NOT NULL,
	"cost_rate_amount" numeric(20, 6),
	"cost_rate_source" text DEFAULT 'unresolved' NOT NULL,
	"billing_rate_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"locked_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_minutes_check" CHECK ("time_entries"."minutes" > 0),
	CONSTRAINT "time_entries_billable_minutes_check" CHECK ("time_entries"."billable_minutes" >= 0),
	CONSTRAINT "time_entries_billable_zero_check" CHECK ("time_entries"."billable" or "time_entries"."billable_minutes" = 0),
	CONSTRAINT "time_entries_billable_target_check" CHECK ("time_entries"."billable" = false or num_nonnulls("time_entries"."project_id", "time_entries"."counterparty_id") >= 1),
	CONSTRAINT "time_entries_worked_by_exclusive_check" CHECK (num_nonnulls("time_entries"."worked_by_user_id", "time_entries"."worked_by_counterparty_id") <= 1),
	CONSTRAINT "time_entries_instant_order_check" CHECK ("time_entries"."ended_at" is null or "time_entries"."started_at" is null or "time_entries"."ended_at" >= "time_entries"."started_at"),
	CONSTRAINT "time_entries_instant_pair_check" CHECK (("time_entries"."started_at" is null) = ("time_entries"."ended_at" is null)),
	CONSTRAINT "time_entries_bill_rate_source_check" CHECK ("time_entries"."bill_rate_source" in ('manual', 'project_person', 'project', 'counterparty', 'person', 'activity', 'installation', 'unresolved')),
	CONSTRAINT "time_entries_cost_rate_source_check" CHECK ("time_entries"."cost_rate_source" in ('manual', 'project_person', 'project', 'counterparty', 'person', 'activity', 'installation', 'unresolved')),
	CONSTRAINT "time_entries_bill_rate_pair_check" CHECK (("time_entries"."bill_rate_amount" is null) = ("time_entries"."bill_rate_source" = 'unresolved')),
	CONSTRAINT "time_entries_cost_rate_pair_check" CHECK (("time_entries"."cost_rate_amount" is null) = ("time_entries"."cost_rate_source" = 'unresolved')),
	CONSTRAINT "time_entries_currency_pair_check" CHECK (("time_entries"."currency" is null) = ("time_entries"."bill_rate_amount" is null and "time_entries"."cost_rate_amount" is null))
);
--> statement-breakpoint
ALTER TABLE "counterparty_entity_roles" ADD COLUMN "billing_site_id" uuid;--> statement-breakpoint
ALTER TABLE "counterparty_sites" ADD CONSTRAINT "counterparty_sites_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_sites" ADD CONSTRAINT "counterparty_sites_primary_contact_fk" FOREIGN KEY ("primary_contact_id") REFERENCES "public"."counterparty_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_subject_counterparty_id_counterparties_id_fk" FOREIGN KEY ("subject_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_uses" ADD CONSTRAINT "project_material_uses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_uses" ADD CONSTRAINT "project_material_uses_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_uses" ADD CONSTRAINT "project_material_uses_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_uses" ADD CONSTRAINT "project_material_uses_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_uses" ADD CONSTRAINT "project_material_uses_allocation_fk" FOREIGN KEY ("inventory_allocation_id") REFERENCES "public"."inventory_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_uses" ADD CONSTRAINT "project_material_uses_movement_fk" FOREIGN KEY ("inventory_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_entity_attributed_by_user_id_user_id_fk" FOREIGN KEY ("entity_attributed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_project_fk" FOREIGN KEY ("parent_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_counterparty_site_fk" FOREIGN KEY ("counterparty_site_id") REFERENCES "public"."counterparty_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_worked_by_user_id_user_id_fk" FOREIGN KEY ("worked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_worked_by_counterparty_id_counterparties_id_fk" FOREIGN KEY ("worked_by_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_billing_rate_id_billing_rates_id_fk" FOREIGN KEY ("billing_rate_id") REFERENCES "public"."billing_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "counterparty_sites_counterparty_id_idx" ON "counterparty_sites" USING btree ("counterparty_id") WHERE "counterparty_sites"."active";--> statement-breakpoint
CREATE INDEX "billing_rates_scope_effective_from_idx" ON "billing_rates" USING btree ("scope_kind","effective_from" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "project_material_uses_movement_uq" ON "project_material_uses" USING btree ("inventory_movement_id") WHERE "project_material_uses"."inventory_movement_id" is not null;--> statement-breakpoint
CREATE INDEX "project_material_uses_project_id_idx" ON "project_material_uses" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_counterparty_id_idx" ON "projects" USING btree ("counterparty_id") WHERE "projects"."counterparty_id" is not null;--> statement-breakpoint
CREATE INDEX "projects_parent_project_id_idx" ON "projects" USING btree ("parent_project_id") WHERE "projects"."parent_project_id" is not null;--> statement-breakpoint
CREATE INDEX "projects_open_status_idx" ON "projects" USING btree ("status") WHERE "projects"."status" not in ('completed', 'cancelled', 'closed');--> statement-breakpoint
CREATE INDEX "time_entries_project_id_worked_on_idx" ON "time_entries" USING btree ("project_id","worked_on");--> statement-breakpoint
CREATE INDEX "time_entries_worked_by_user_id_worked_on_idx" ON "time_entries" USING btree ("worked_by_user_id","worked_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "time_entries_unbilled_idx" ON "time_entries" USING btree ("worked_on") WHERE "time_entries"."billable" and "time_entries"."locked_at" is null;--> statement-breakpoint
ALTER TABLE "counterparty_entity_roles" ADD CONSTRAINT "counterparty_entity_roles_billing_site_fk" FOREIGN KEY ("billing_site_id") REFERENCES "public"."counterparty_sites"("id") ON DELETE no action ON UPDATE no action;