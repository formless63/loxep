/**
 * Phase 6 projects and work: jobs/engagements, time entries, the billing-rate
 * card, and materials consumed on a job (Projects and Work domain).
 *
 * Physical realization of the "Projects, jobs, and sites", "Time entries and
 * billable work", "Rate resolution", and "Materials consumed on jobs" sections
 * of
 * `apps/docs/src/content/docs/architecture/services-billing-schema-design.md`
 * — four of that document's nineteen tables (`projects`, `billing_rates`,
 * `time_entries`, `project_material_uses`), the design's own "Migration B".
 *
 * `counterparty_sites` — the fifth table this slice ships — lives in
 * `./counterparties.ts` instead, because it belongs to the Customers and
 * counterparties domain: the design puts sites there and has projects
 * reference them (see that file's header and the design's contradiction 7).
 *
 * ## What does NOT ship here, and why
 *
 * Open question 14 proposes a general domain-to-package rule and applies it to
 * Phase 6: `@loxep/counterparties` (exists), `@loxep/work` for projects, time,
 * rates, materials, services, subscriptions, and periods (does **not** exist),
 * and `@loxep/billing` for invoices/AR (does **not** exist). New package
 * scaffolding is orchestrator-only. This file ships the Drizzle schema and
 * `packages/db` schema-level tests for the four Work-domain tables — the
 * physical facts — but **no `@loxep/work` service package is created**, and
 * therefore no project CRUD, time-entry recording, rate-resolution, or
 * material-use-linking SERVICE ships in this slice, and neither does the
 * unbilled-work read model (which needs `invoice_line_sources`, a Billing-
 * milestone table this slice also does not create). That gap is recorded in
 * this design document's "Provisional implementation decisions" and in
 * `bd show loxep-nw0`.
 *
 * `service_plans`, `subscriptions`, `subscription_items`, `service_periods`,
 * `service_period_charges`, `invoices`, `invoice_lines`, `invoice_line_sources`,
 * and `invoice_payments` are design-only; none of the four Phase-5-table
 * ALTERs this design plans (`expenses.project_id` etc.) are made here either —
 * `bd show loxep-nw0`'s own design note defers them explicitly.
 *
 * Conventions inherited unchanged: uuid PKs with `defaultRandom()`, `date` for
 * business dates (`worked_on`, `consumed_on`, `effective_from`/`effective_to`,
 * `starts_on`/`target_end_on`/`completed_on`) and `timestamptz` for genuine
 * instants, `numeric(20,6)` money and quantities, `text` state columns with
 * TypeScript unions, ADR-0020 nullable-FK user references, and no free-form
 * `jsonb`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { catalogItems } from "./commerce.ts";
import { counterparties, counterpartySites } from "./counterparties.ts";
import { economicEntities } from "./entities.ts";
import {
  inventoryAllocations,
  inventoryItems,
  inventoryMovements,
} from "./inventory.ts";

/* ------------------------------------------------------------------ unions */

/**
 * `projects.entity_attribution_source` — closed, `CHECK`ed. The Phase 3/4/5
 * ladder applied to work rather than goods, with one extra rung: the
 * customer relationship's own entity, from `counterparty_entity_roles`.
 */
export const PROJECT_ENTITY_ATTRIBUTION_SOURCES = [
  "manual",
  "counterparty_role_default",
  "installation_default",
  "unattributed",
] as const;
export type ProjectEntityAttributionSource =
  (typeof PROJECT_ENTITY_ATTRIBUTION_SOURCES)[number];

/**
 * `projects.status` — an OPEN TypeScript union with **no** `CHECK`. A workflow
 * label that grows with real practice; nothing branches on an unknown member,
 * the identical treatment `acquisitions.status` gets. Initial members per the
 * design.
 */
export const PROJECT_STATUSES = [
  "lead",
  "quoted",
  "approved",
  "active",
  "on_hold",
  "completed",
  "cancelled",
  "closed",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * `projects.project_kind` — an OPEN TypeScript union with **no** `CHECK`,
 * matching the design's own sketch (no `CHECK` is listed for this column,
 * unlike `billing_method`) and the same treatment `service_plans.plan_kind`
 * gets a few sections later in the same document: a classification that grows
 * with the operator's real practice, not a set the billing engine branches on.
 */
export const PROJECT_KINDS = [
  "job",
  "engagement",
  "retainer",
  "internal",
  "other",
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/**
 * `projects.billing_method` — CLOSED, `CHECK`ed, because the billing engine
 * branches on it: an unknown member here is a project whose money nobody can
 * compute, the same rule `acquisitions.cost_allocation_status` gets.
 */
export const PROJECT_BILLING_METHODS = [
  "time_and_materials",
  "fixed_price",
  "milestone",
  "subscription",
  "non_billable",
  "internal",
] as const;
export type ProjectBillingMethod = (typeof PROJECT_BILLING_METHODS)[number];

/**
 * `time_entries.bill_rate_source` / `cost_rate_source` — the frozen rung of
 * the six-scope-plus-manual-plus-unresolved rate-resolution ladder. Closed,
 * `CHECK`ed: `unresolved` is a real state and a visible backlog, never a
 * silent default to zero.
 */
export const RATE_SOURCES = [
  "manual",
  "project_person",
  "project",
  "counterparty",
  "person",
  "activity",
  "installation",
  "unresolved",
] as const;
export type RateSource = (typeof RATE_SOURCES)[number];

/** `billing_rates.scope_kind` — closed, `CHECK`ed; the same six scopes minus `manual`. */
export const BILLING_RATE_SCOPE_KINDS = [
  "project_person",
  "project",
  "counterparty",
  "person",
  "activity",
  "installation",
] as const;
export type BillingRateScopeKind = (typeof BILLING_RATE_SCOPE_KINDS)[number];

/** `billing_rates.rate_kind` — closed, `CHECK`ed. Bill and cost share one table and one ladder. */
export const RATE_KINDS = ["bill", "cost"] as const;
export type RateKind = (typeof RATE_KINDS)[number];

/** `billing_rates.unit` — closed, `CHECK`ed. */
export const RATE_UNITS = ["hour", "day", "fixed"] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

/**
 * `project_material_uses.cost_basis_source` — closed, `CHECK`ed. Snapshotted
 * at consumption, never a read-time join, per Phase 4's cost-basis-freezes
 * rule applied to a project's margin.
 */
export const COST_BASIS_SOURCES = [
  "inventory_basis",
  "manual",
  "purchased_for_job",
  "none",
] as const;
export type CostBasisSource = (typeof COST_BASIS_SOURCES)[number];

/** `media_links.resource_type` value for media attached to a project. */
export const PROJECT_RESOURCE_TYPE = "project";
/** `media_links.resource_type` value for media attached to a time entry. */
export const TIME_ENTRY_RESOURCE_TYPE = "time_entry";

/* ----------------------------------------------------------------- tables */

/**
 * A project, job, or engagement. Hierarchy-lite: `depth between 0 and 1`, so
 * "everything under this project" is `where parent_project_id = $1 or id =
 * $1` and no `path` cache is needed — see the design's "Hierarchy-lite means
 * two levels and no path cache".
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** `PRJ-2026-0042`. People label things and a UUID is not a label. */
    referenceCode: text("reference_code").notNull(),

    parentProjectId: uuid("parent_project_id"),

    counterpartyId: uuid("counterparty_id").references(
      () => counterparties.id,
    ),
    counterpartySiteId: uuid("counterparty_site_id"),

    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),
    entityAttributionSource: text("entity_attribution_source").notNull(),
    entityAttributedAt: timestamp("entity_attributed_at", {
      withTimezone: true,
    }),
    entityAttributedByUserId: text("entity_attributed_by_user_id").references(
      () => user.id,
      { onDelete: "set null" },
    ),

    name: text("name").notNull(),
    description: text("description"),

    /** Open set: TS union, no `CHECK`. See {@link PROJECT_KINDS}. */
    projectKind: text("project_kind").notNull(),
    /** Open set: TS union, no `CHECK`. See {@link PROJECT_STATUSES}. */
    status: text("status").notNull().default("lead"),
    billingMethod: text("billing_method").notNull(),

    currency: char("currency", { length: 3 }).notNull(),
    estimateAmount: numeric("estimate_amount", { precision: 20, scale: 6 }),
    budgetAmount: numeric("budget_amount", { precision: 20, scale: 6 }),
    fixedPriceAmount: numeric("fixed_price_amount", {
      precision: 20,
      scale: 6,
    }),
    /** Recorded and enforced NOWHERE. A commercial conversation, not a constraint. */
    notToExceedAmount: numeric("not_to_exceed_amount", {
      precision: 20,
      scale: 6,
    }),

    /** Maintained on insert and re-parent; `check(depth between 0 and 1)` below. */
    depth: integer("depth").notNull().default(0),

    startsOn: date("starts_on", { mode: "string" }),
    targetEndOn: date("target_end_on", { mode: "string" }),
    completedOn: date("completed_on", { mode: "string" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "projects_parent_project_fk",
      columns: [table.parentProjectId],
      foreignColumns: [table.id],
    }),
    foreignKey({
      name: "projects_counterparty_site_fk",
      columns: [table.counterpartySiteId],
      foreignColumns: [counterpartySites.id],
    }),

    unique("projects_reference_code_uq").on(table.referenceCode),

    check(
      "projects_no_self_parent_check",
      sql`${table.parentProjectId} is distinct from ${table.id}`,
    ),
    check("projects_depth_check", sql`${table.depth} between 0 and 1`),
    check(
      "projects_entity_attribution_source_check",
      sql`${table.entityAttributionSource} in ('manual', 'counterparty_role_default', 'installation_default', 'unattributed')`,
    ),
    check(
      "projects_billing_method_check",
      sql`${table.billingMethod} in ('time_and_materials', 'fixed_price', 'milestone', 'subscription', 'non_billable', 'internal')`,
    ),
    check(
      "projects_fixed_price_amount_check",
      sql`(${table.billingMethod} = 'fixed_price') = (${table.fixedPriceAmount} is not null)`,
    ),
    check(
      "projects_internal_no_counterparty_check",
      sql`${table.billingMethod} <> 'internal' or ${table.counterpartyId} is null`,
    ),
    check(
      "projects_billable_needs_counterparty_check",
      sql`${table.billingMethod} in ('internal', 'non_billable') or ${table.counterpartyId} is not null`,
    ),
    check(
      "projects_target_end_check",
      sql`${table.targetEndOn} is null or ${table.startsOn} is null or ${table.targetEndOn} >= ${table.startsOn}`,
    ),

    index("projects_counterparty_id_idx")
      .on(table.counterpartyId)
      .where(sql`${table.counterpartyId} is not null`),
    index("projects_parent_project_id_idx")
      .on(table.parentProjectId)
      .where(sql`${table.parentProjectId} is not null`),
    // The design's "open work" partial index: excludes the closed statuses.
    // `status` is an open TypeScript union with no CHECK, so this is a
    // reporting convenience over today's known-closed members, not a
    // constraint on the column.
    index("projects_open_status_idx")
      .on(table.status)
      .where(
        sql`${table.status} not in ('completed', 'cancelled', 'closed')`,
      ),
  ],
);

/**
 * The rate card, scoped and effective-dated. Bill and cost rates share this
 * table with `rate_kind`, because every scope, effective-dating, and
 * precedence rule is shared — see the design's "Rate resolution".
 *
 * `scope_kind` plus per-scope consistency checks is the `order_fees.fee_scope`
 * pattern for the fifth time across four phases: an invalid rate row cannot be
 * inserted rather than being caught by a service someone forgets to call.
 *
 * Deliberately NO overlap-prevention constraint across effective-dated rows at
 * the same scope — the design's own call: an exclusion constraint over a
 * six-shape nullable tuple is hard to write and easy to get wrong for a
 * problem a report solves. Resolution order (six scopes, first-match-wins by
 * declared precedence, later `effective_from` wins a same-level tie) is a
 * SERVICE concern; this table only stores what the ladder needs.
 */
export const billingRates = pgTable(
  "billing_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeKind: text("scope_kind").notNull(),
    projectId: uuid("project_id").references(() => projects.id),
    counterpartyId: uuid("counterparty_id").references(
      () => counterparties.id,
    ),
    subjectUserId: text("subject_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    subjectCounterpartyId: uuid("subject_counterparty_id").references(
      () => counterparties.id,
    ),
    /** Open set: TS union, no `CHECK`. Same treatment as `time_entries.activity_code`. */
    activityCode: text("activity_code"),
    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),
    rateKind: text("rate_kind").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    unit: text("unit").notNull().default("hour"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    note: text("note"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_rates_rate_kind_check",
      sql`${table.rateKind} in ('bill', 'cost')`,
    ),
    check("billing_rates_unit_check", sql`${table.unit} in ('hour', 'day', 'fixed')`),
    check("billing_rates_amount_check", sql`${table.amount} >= 0`),
    check(
      "billing_rates_scope_kind_check",
      sql`${table.scopeKind} in ('project_person', 'project', 'counterparty', 'person', 'activity', 'installation')`,
    ),
    check(
      "billing_rates_project_scope_check",
      sql`(${table.scopeKind} in ('project_person', 'project')) = (${table.projectId} is not null)`,
    ),
    check(
      "billing_rates_counterparty_scope_check",
      sql`(${table.scopeKind} = 'counterparty') = (${table.counterpartyId} is not null)`,
    ),
    check(
      "billing_rates_subject_scope_check",
      sql`(${table.scopeKind} in ('project_person', 'person')) = (num_nonnulls(${table.subjectUserId}, ${table.subjectCounterpartyId}) = 1)`,
    ),
    check(
      "billing_rates_activity_scope_check",
      sql`(${table.scopeKind} = 'activity') = (${table.activityCode} is not null)`,
    ),
    check(
      "billing_rates_effective_range_check",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),

    // The resolution probe: which rows are candidates for a given scope,
    // newest-effective first.
    index("billing_rates_scope_effective_from_idx").on(
      table.scopeKind,
      table.effectiveFrom.desc(),
    ),
  ],
);

/**
 * Who worked, how long, and whether it is billable. `minutes` is the
 * authority; `started_at`/`ended_at` are optional evidence for timer-driven
 * entry — see the design's "Duration: minutes are the authority, instants are
 * optional evidence".
 *
 * `worked_by_user_id` (ADR-0020 form 1, nullable FK, `ON DELETE SET NULL`) and
 * `worked_by_label` (ADR-0020 form 2, a snapshot that never nulls) are BOTH
 * carried, because who did the work is part of the billable fact, not mere
 * provenance — see the design's "Who worked, and why a nullable FK is not
 * enough". `worked_by_counterparty_id` covers a subcontractor, who is not a
 * user.
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id),
    counterpartyId: uuid("counterparty_id").references(
      () => counterparties.id,
    ),
    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),
    workedByUserId: text("worked_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    workedByCounterpartyId: uuid("worked_by_counterparty_id").references(
      () => counterparties.id,
    ),
    /** Snapshot of the worker's display name at entry time. Never changes, never nulls. */
    workedByLabel: text("worked_by_label").notNull(),
    /** Open set: TS union, no `CHECK` — named as a design exception. */
    activityCode: text("activity_code"),
    description: text("description"),

    /** The authority for the duration; a business date, not an instant. */
    workedOn: date("worked_on", { mode: "string" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    minutes: integer("minutes").notNull(),

    billable: boolean("billable").notNull().default(true),
    /**
     * Separate from `minutes` on purpose: actual time worked and time charged
     * routinely differ (rounding, a courtesy write-down, zero-billed costing
     * hours). Collapsing them loses the gap between what was done and what was
     * charged. See the design's "billable_minutes is separate from minutes,
     * and this is not redundancy".
     */
    billableMinutes: integer("billable_minutes").notNull().default(0),

    currency: char("currency", { length: 3 }),
    billRateAmount: numeric("bill_rate_amount", { precision: 20, scale: 6 }),
    billRateSource: text("bill_rate_source").notNull().default("unresolved"),
    costRateAmount: numeric("cost_rate_amount", { precision: 20, scale: 6 }),
    costRateSource: text("cost_rate_source").notNull().default("unresolved"),
    billingRateId: uuid("billing_rate_id").references(() => billingRates.id),

    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /**
     * Set the moment the entry is attached to an issued invoice line; a locked
     * entry is immutable at the service layer (Phase 4's cost-basis-freeze
     * rule applied to labour). No billing milestone ships in this slice, so
     * nothing sets this column yet — it exists so the column need not be added
     * later.
     */
    lockedAt: timestamp("locked_at", { withTimezone: true }),

    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("time_entries_minutes_check", sql`${table.minutes} > 0`),
    check(
      "time_entries_billable_minutes_check",
      sql`${table.billableMinutes} >= 0`,
    ),
    check(
      "time_entries_billable_zero_check",
      sql`${table.billable} or ${table.billableMinutes} = 0`,
    ),
    check(
      "time_entries_billable_target_check",
      sql`${table.billable} = false or num_nonnulls(${table.projectId}, ${table.counterpartyId}) >= 1`,
    ),
    check(
      "time_entries_worked_by_exclusive_check",
      sql`num_nonnulls(${table.workedByUserId}, ${table.workedByCounterpartyId}) <= 1`,
    ),
    check(
      "time_entries_instant_order_check",
      sql`${table.endedAt} is null or ${table.startedAt} is null or ${table.endedAt} >= ${table.startedAt}`,
    ),
    check(
      "time_entries_instant_pair_check",
      sql`(${table.startedAt} is null) = (${table.endedAt} is null)`,
    ),
    check(
      "time_entries_bill_rate_source_check",
      sql`${table.billRateSource} in ('manual', 'project_person', 'project', 'counterparty', 'person', 'activity', 'installation', 'unresolved')`,
    ),
    check(
      "time_entries_cost_rate_source_check",
      sql`${table.costRateSource} in ('manual', 'project_person', 'project', 'counterparty', 'person', 'activity', 'installation', 'unresolved')`,
    ),
    check(
      "time_entries_bill_rate_pair_check",
      sql`(${table.billRateAmount} is null) = (${table.billRateSource} = 'unresolved')`,
    ),
    check(
      "time_entries_cost_rate_pair_check",
      sql`(${table.costRateAmount} is null) = (${table.costRateSource} = 'unresolved')`,
    ),
    check(
      "time_entries_currency_pair_check",
      sql`(${table.currency} is null) = (${table.billRateAmount} is null and ${table.costRateAmount} is null)`,
    ),

    // The project timesheet.
    index("time_entries_project_id_worked_on_idx").on(
      table.projectId,
      table.workedOn,
    ),
    // "My week".
    index("time_entries_worked_by_user_id_worked_on_idx").on(
      table.workedByUserId,
      table.workedOn.desc(),
    ),
    // The unbilled queue, partial: billable, unlocked entries. This slice
    // ships no invoicing, so every row currently matches; the index is here so
    // the billing milestone's anti-join against invoice_line_sources has
    // something to scan instead of a sequential scan from day one.
    index("time_entries_unbilled_idx")
      .on(table.workedOn)
      .where(sql`${table.billable} and ${table.lockedAt} is null`),
  ],
);

/**
 * Stock consumed on a job, bridging Phase 4. The link points INWARD from here
 * — `inventory_movements` and `inventory_allocations` gain no `project_id` —
 * because movements are append-only/immutable while a material use has
 * attributes legitimately edited right up until billed. See the design's "The
 * link points inward, and Phase 4 gains no columns".
 *
 * `unit_cost_amount` is snapshotted from `inventory_items.landed_cost_amount`
 * at the moment of use (`cost_basis_source = 'inventory_basis'`), never a
 * read-time join — the third instance of Phase 4's cost-basis-freeze rule.
 *
 * This slice creates no service that writes this table (no `@loxep/work`
 * package yet); the schema exists so the migration is complete against the
 * design and so `packages/db` can test its constraints directly.
 */
export const projectMaterialUses = pgTable(
  "project_material_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    inventoryItemId: uuid("inventory_item_id"),
    catalogItemId: uuid("catalog_item_id").references(() => catalogItems.id),
    inventoryAllocationId: uuid("inventory_allocation_id"),
    inventoryMovementId: uuid("inventory_movement_id"),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    consumedOn: date("consumed_on", { mode: "string" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    unitCostAmount: numeric("unit_cost_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    costBasisSource: text("cost_basis_source").notNull(),
    billable: boolean("billable").notNull().default(true),
    markupPercent: numeric("markup_percent", { precision: 10, scale: 4 }),
    unitChargeAmount: numeric("unit_charge_amount", {
      precision: 20,
      scale: 6,
    }),
    /** Set once billed; no billing milestone ships in this slice, so unused today. */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Named explicitly: the derived names for these three run 61-73 bytes and
    // PostgreSQL silently truncates at 63.
    foreignKey({
      name: "project_material_uses_item_fk",
      columns: [table.inventoryItemId],
      foreignColumns: [inventoryItems.id],
    }),
    foreignKey({
      name: "project_material_uses_allocation_fk",
      columns: [table.inventoryAllocationId],
      foreignColumns: [inventoryAllocations.id],
    }),
    foreignKey({
      name: "project_material_uses_movement_fk",
      columns: [table.inventoryMovementId],
      foreignColumns: [inventoryMovements.id],
    }),

    check("project_material_uses_quantity_check", sql`${table.quantity} > 0`),
    check(
      "project_material_uses_cost_basis_source_check",
      sql`${table.costBasisSource} in ('inventory_basis', 'manual', 'purchased_for_job', 'none')`,
    ),
    check(
      "project_material_uses_cost_basis_item_check",
      sql`(${table.costBasisSource} = 'inventory_basis') = (${table.inventoryItemId} is not null)`,
    ),
    check(
      "project_material_uses_billable_charge_check",
      sql`${table.billable} or ${table.unitChargeAmount} is null`,
    ),
    check(
      "project_material_uses_markup_check",
      sql`${table.markupPercent} is null or ${table.markupPercent} >= -100`,
    ),

    // The idempotency probe: a consumption movement backs at most one
    // material use, so a retried job cannot double-charge a physical item.
    // Partial (design: `unique(inventory_movement_id) where ... is not
    // null`), NOT nulls-not-distinct — most material uses have no movement at
    // all (manual/purchased-for-job/none cost basis), and those nulls must
    // stay distinct from one another.
    uniqueIndex("project_material_uses_movement_uq")
      .on(table.inventoryMovementId)
      .where(sql`${table.inventoryMovementId} is not null`),

    index("project_material_uses_project_id_idx").on(table.projectId),
  ],
);
