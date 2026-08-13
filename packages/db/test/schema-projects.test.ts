/**
 * Migration 0011's Phase 6 "Migration B" DDL against real PostgreSQL:
 * `counterparty_sites`, `projects`, `billing_rates`, `time_entries`,
 * `project_material_uses`, and `counterparty_entity_roles.billing_site_id`.
 *
 * These write through the pool rather than through a service — there is
 * deliberately no `@loxep/work` service package in this slice (see the
 * migration's own header and `bd show loxep-nw0`) — so this file is the ONLY
 * place these constraints are exercised. It follows the design's own
 * pre-implementation checklist item for this milestone: write the
 * rate-resolution and billing-method consistency tests against the schema
 * directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "../src/migrate.ts";
import type { DbHandle } from "../src/migrate.ts";
import { economicEntities, inventoryItems } from "../src/schema/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

describe("projects/work schema (migration 0011)", () => {
  const dbName = scratchDbName("loxep_test_projects_schema");
  let handle: DbHandle;
  let counterpartyId: string;
  let entityId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);

    const [entity] = await handle.db
      .insert(economicEntities)
      .values({ name: "Test LLC", kind: "llc" })
      .returning();
    if (entity === undefined) throw new Error("entity insert returned no row");
    entityId = entity.id;

    const cp = await handle.pool.query<{ id: string }>(
      `insert into counterparties (reference_code, kind, display_name, normalized_name)
       values ('CP-PRJ-TEST', 'organization', 'Acme', 'acme') returning id`,
    );
    const cpId = cp.rows[0]?.id;
    if (cpId === undefined) throw new Error("counterparty insert returned no row");
    counterpartyId = cpId;
  }, 120_000);

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  async function insertRow(
    table: string,
    columns: Record<string, string>,
  ): Promise<string> {
    const result = await handle.pool.query<{ id: string }>(
      `insert into ${table} (${Object.keys(columns).join(", ")})
       values (${Object.values(columns).join(", ")}) returning id`,
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error(`${table} insert returned no row`);
    return id;
  }

  let seq = 0;
  function nextSeq(): number {
    seq += 1;
    return seq;
  }

  async function insertProject(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    const n = nextSeq();
    return insertRow("projects", {
      reference_code: `'PRJ-TEST-${n}'`,
      entity_attribution_source: `'unattributed'`,
      name: `'Test Project ${n}'`,
      project_kind: `'job'`,
      billing_method: `'internal'`,
      currency: `'USD'`,
      ...overrides,
    });
  }

  async function insertSite(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    const n = nextSeq();
    return insertRow("counterparty_sites", {
      counterparty_id: `'${counterpartyId}'`,
      site_code: `'SITE-TEST-${n}'`,
      name: `'Test Site ${n}'`,
      site_kind: `'service'`,
      ...overrides,
    });
  }

  async function insertBillingRate(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    return insertRow("billing_rates", {
      scope_kind: `'installation'`,
      rate_kind: `'bill'`,
      currency: `'USD'`,
      amount: `100`,
      effective_from: `'2026-01-01'`,
      ...overrides,
    });
  }

  async function insertTimeEntry(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    return insertRow("time_entries", {
      worked_by_label: `'Jane Doe'`,
      worked_on: `'2026-06-01'`,
      minutes: `60`,
      ...overrides,
    });
  }

  describe("counterparty_sites", () => {
    it("rejects an unknown site_kind", async () => {
      await expect(
        insertSite({ site_kind: `'warehouse'` }),
      ).rejects.toThrow(/counterparty_sites_kind_check/);
    });

    it("requires latitude and longitude together", async () => {
      await expect(
        insertSite({ latitude: `'40.0'` }),
      ).rejects.toThrow(/counterparty_sites_latlong_pair_check/);
      await expect(
        insertSite({ longitude: `'-73.0'` }),
      ).rejects.toThrow(/counterparty_sites_latlong_pair_check/);
      await expect(
        insertSite({ latitude: `'40.0'`, longitude: `'-73.0'` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("enforces site_code uniqueness", async () => {
      await insertSite({ site_code: `'SITE-DUP'` });
      await expect(insertSite({ site_code: `'SITE-DUP'` })).rejects.toThrow(
        /counterparty_sites_site_code_uq/,
      );
    });

    it("a project may reference a site", async () => {
      const siteId = await insertSite();
      await expect(
        insertProject({ counterparty_site_id: `'${siteId}'` }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe("counterparty_entity_roles.billing_site_id", () => {
    it("accepts a real site and rejects an unknown one", async () => {
      const siteId = await insertSite();
      await expect(
        insertRow("counterparty_entity_roles", {
          counterparty_id: `'${counterpartyId}'`,
          role: `'vendor'`,
          billing_site_id: `'${siteId}'`,
        }),
      ).resolves.toEqual(expect.any(String));

      await expect(
        insertRow("counterparty_entity_roles", {
          counterparty_id: `'${counterpartyId}'`,
          role: `'payer'`,
          billing_site_id: `'00000000-0000-0000-0000-000000000000'`,
        }),
      ).rejects.toThrow(/counterparty_entity_roles_billing_site_fk/);
    });
  });

  describe("projects", () => {
    it("rejects a project as its own parent", async () => {
      const id = await insertProject();
      await expect(
        handle.pool.query(
          `update projects set parent_project_id = id where id = $1`,
          [id],
        ),
      ).rejects.toThrow(/projects_no_self_parent_check/);
    });

    it("rejects a depth outside 0..1", async () => {
      await expect(insertProject({ depth: `2` })).rejects.toThrow(
        /projects_depth_check/,
      );
      await expect(insertProject({ depth: `-1` })).rejects.toThrow(
        /projects_depth_check/,
      );
    });

    it("allows a child job under a project (depth 1)", async () => {
      const parentId = await insertProject();
      await expect(
        insertProject({ parent_project_id: `'${parentId}'`, depth: `1` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("rejects an unknown entity_attribution_source", async () => {
      await expect(
        insertProject({ entity_attribution_source: `'guessed'` }),
      ).rejects.toThrow(/projects_entity_attribution_source_check/);
    });

    it("rejects an unknown billing_method", async () => {
      // A counterparty is attached so the ONLY violated check is the
      // billing_method enum itself — Postgres does not guarantee it reports
      // constraint violations in declaration order.
      await expect(
        insertProject({
          billing_method: `'net_30'`,
          counterparty_id: `'${counterpartyId}'`,
        }),
      ).rejects.toThrow(/projects_billing_method_check/);
    });

    it("accepts any project_kind — it is an OPEN set with no CHECK", async () => {
      // Design sketch: the "exceptions" prose names status/activity_code/
      // plan_kind but the projects table sketch itself has no CHECK for
      // project_kind. Followed literally; see the migration header note.
      await expect(
        insertProject({ project_kind: `'anything_an_operator_types'` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("requires fixed_price_amount exactly when billing_method is fixed_price", async () => {
      await expect(
        insertProject({
          billing_method: `'fixed_price'`,
          counterparty_id: `'${counterpartyId}'`,
        }),
      ).rejects.toThrow(/projects_fixed_price_amount_check/);
      await expect(
        insertProject({
          billing_method: `'time_and_materials'`,
          counterparty_id: `'${counterpartyId}'`,
          fixed_price_amount: `500`,
        }),
      ).rejects.toThrow(/projects_fixed_price_amount_check/);
      await expect(
        insertProject({
          billing_method: `'fixed_price'`,
          counterparty_id: `'${counterpartyId}'`,
          fixed_price_amount: `500`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("refuses a counterparty on an internal project", async () => {
      await expect(
        insertProject({
          billing_method: `'internal'`,
          counterparty_id: `'${counterpartyId}'`,
        }),
      ).rejects.toThrow(/projects_internal_no_counterparty_check/);
    });

    it("requires a counterparty on a billable project", async () => {
      await expect(
        insertProject({ billing_method: `'time_and_materials'` }),
      ).rejects.toThrow(/projects_billable_needs_counterparty_check/);
      await expect(
        insertProject({ billing_method: `'non_billable'` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("rejects a target_end_on before starts_on", async () => {
      await expect(
        insertProject({
          starts_on: `'2026-06-01'`,
          target_end_on: `'2026-05-01'`,
        }),
      ).rejects.toThrow(/projects_target_end_check/);
    });

    it("enforces reference_code uniqueness", async () => {
      await insertProject({ reference_code: `'PRJ-DUP'` });
      await expect(
        insertProject({ reference_code: `'PRJ-DUP'` }),
      ).rejects.toThrow(/projects_reference_code_uq/);
    });
  });

  describe("billing_rates: the scope_kind discriminator", () => {
    it("rejects an unknown scope_kind", async () => {
      await expect(
        insertBillingRate({ scope_kind: `'team'` }),
      ).rejects.toThrow(/billing_rates_scope_kind_check/);
    });

    it("rejects an unknown rate_kind or unit", async () => {
      await expect(
        insertBillingRate({ rate_kind: `'wage'` }),
      ).rejects.toThrow(/billing_rates_rate_kind_check/);
      await expect(insertBillingRate({ unit: `'week'` })).rejects.toThrow(
        /billing_rates_unit_check/,
      );
    });

    it("rejects a negative amount", async () => {
      await expect(insertBillingRate({ amount: `-1` })).rejects.toThrow(
        /billing_rates_amount_check/,
      );
    });

    it("project/project_person scopes require project_id, and only those do", async () => {
      const projectId = await insertProject();
      await expect(
        insertBillingRate({ scope_kind: `'project'` }),
      ).rejects.toThrow(/billing_rates_project_scope_check/);
      await expect(
        insertBillingRate({
          scope_kind: `'installation'`,
          project_id: `'${projectId}'`,
        }),
      ).rejects.toThrow(/billing_rates_project_scope_check/);
      await expect(
        insertBillingRate({
          scope_kind: `'project'`,
          project_id: `'${projectId}'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("the counterparty scope requires counterparty_id, and only it does", async () => {
      await expect(
        insertBillingRate({ scope_kind: `'counterparty'` }),
      ).rejects.toThrow(/billing_rates_counterparty_scope_check/);
      await expect(
        insertBillingRate({
          scope_kind: `'installation'`,
          counterparty_id: `'${counterpartyId}'`,
        }),
      ).rejects.toThrow(/billing_rates_counterparty_scope_check/);
      await expect(
        insertBillingRate({
          scope_kind: `'counterparty'`,
          counterparty_id: `'${counterpartyId}'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("project_person/person scopes require EXACTLY one subject, and only those scopes take one", async () => {
      const projectId = await insertProject();
      await expect(
        insertBillingRate({
          scope_kind: `'project_person'`,
          project_id: `'${projectId}'`,
        }),
      ).rejects.toThrow(/billing_rates_subject_scope_check/);
      await expect(
        insertBillingRate({
          scope_kind: `'person'`,
          subject_user_id: `'user_billing_rate_test'`,
          subject_counterparty_id: `'${counterpartyId}'`,
        }),
      ).rejects.toThrow(/billing_rates_subject_scope_check/);
      await expect(
        insertBillingRate({
          scope_kind: `'installation'`,
          subject_counterparty_id: `'${counterpartyId}'`,
        }),
      ).rejects.toThrow(/billing_rates_subject_scope_check/);
      await expect(
        insertBillingRate({
          scope_kind: `'person'`,
          subject_counterparty_id: `'${counterpartyId}'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("the activity scope requires an activity_code, and only it does", async () => {
      await expect(
        insertBillingRate({ scope_kind: `'activity'` }),
      ).rejects.toThrow(/billing_rates_activity_scope_check/);
      await expect(
        insertBillingRate({
          scope_kind: `'installation'`,
          activity_code: `'consulting'`,
        }),
      ).rejects.toThrow(/billing_rates_activity_scope_check/);
      await expect(
        insertBillingRate({
          scope_kind: `'activity'`,
          activity_code: `'consulting'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("the installation scope needs nothing else", async () => {
      await expect(
        insertBillingRate({ scope_kind: `'installation'` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("rejects effective_to before effective_from", async () => {
      await expect(
        insertBillingRate({
          effective_from: `'2026-06-01'`,
          effective_to: `'2026-05-01'`,
        }),
      ).rejects.toThrow(/billing_rates_effective_range_check/);
    });
  });

  describe("time_entries", () => {
    it("rejects non-positive minutes", async () => {
      // billable defaults to true, so a target is required too — supply one
      // so the ONLY violated check is minutes itself.
      await expect(
        insertTimeEntry({
          minutes: `0`,
          counterparty_id: `'${counterpartyId}'`,
        }),
      ).rejects.toThrow(/time_entries_minutes_check/);
    });

    it("rejects negative billable_minutes", async () => {
      await expect(
        insertTimeEntry({ billable_minutes: `-1` }),
      ).rejects.toThrow(/time_entries_billable_minutes_check/);
    });

    it("a non-billable entry must carry zero billable_minutes", async () => {
      await expect(
        insertTimeEntry({ billable: `false`, billable_minutes: `30` }),
      ).rejects.toThrow(/time_entries_billable_zero_check/);
      await expect(
        insertTimeEntry({ billable: `false`, billable_minutes: `0` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("a billable entry needs a project or a counterparty target", async () => {
      await expect(
        insertTimeEntry({ billable: `true` }),
      ).rejects.toThrow(/time_entries_billable_target_check/);
      await expect(
        insertTimeEntry({ billable: `true`, counterparty_id: `'${counterpartyId}'` }),
      ).resolves.toEqual(expect.any(String));
      // Non-billable entries need neither.
      await expect(
        insertTimeEntry({ billable: `false`, billable_minutes: `0` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("worked_by is a user OR a subcontractor counterparty, never both", async () => {
      await expect(
        insertTimeEntry({
          billable: `false`,
          billable_minutes: `0`,
          worked_by_user_id: `'user_time_entry_test'`,
          worked_by_counterparty_id: `'${counterpartyId}'`,
        }),
      ).rejects.toThrow(/time_entries_worked_by_exclusive_check/);
      // A label-only entry (both null) is fine.
      await expect(
        insertTimeEntry({ billable: `false`, billable_minutes: `0` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("requires started_at and ended_at together, and in order", async () => {
      await expect(
        insertTimeEntry({
          billable: `false`,
          billable_minutes: `0`,
          started_at: `'2026-06-01 09:00:00+00'`,
        }),
      ).rejects.toThrow(/time_entries_instant_pair_check/);
      await expect(
        insertTimeEntry({
          billable: `false`,
          billable_minutes: `0`,
          started_at: `'2026-06-01 11:00:00+00'`,
          ended_at: `'2026-06-01 09:00:00+00'`,
        }),
      ).rejects.toThrow(/time_entries_instant_order_check/);
      // No CHECK ties minutes to the instant span — a correction is legitimate.
      await expect(
        insertTimeEntry({
          billable: `false`,
          billable_minutes: `0`,
          minutes: `500`,
          started_at: `'2026-06-01 09:00:00+00'`,
          ended_at: `'2026-06-01 11:15:00+00'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("rejects an unknown bill_rate_source / cost_rate_source", async () => {
      // An amount + currency accompany the bogus source so the pair-checks
      // are satisfied and only the enum check is exercised.
      await expect(
        insertTimeEntry({
          billable: `false`,
          billable_minutes: `0`,
          bill_rate_amount: `95`,
          currency: `'USD'`,
          bill_rate_source: `'guessed'`,
        }),
      ).rejects.toThrow(/time_entries_bill_rate_source_check/);
      await expect(
        insertTimeEntry({
          billable: `false`,
          billable_minutes: `0`,
          cost_rate_amount: `40`,
          currency: `'USD'`,
          cost_rate_source: `'guessed'`,
        }),
      ).rejects.toThrow(/time_entries_cost_rate_source_check/);
    });

    it("unresolved is a real backlog state — an amount may never accompany it", async () => {
      await expect(
        insertTimeEntry({
          billable: `false`,
          billable_minutes: `0`,
          bill_rate_amount: `95`,
          currency: `'USD'`,
        }),
      ).rejects.toThrow(/time_entries_bill_rate_pair_check/);
      // A resolved rate needs a non-unresolved source and a currency.
      await expect(
        insertTimeEntry({
          billable: `false`,
          billable_minutes: `0`,
          bill_rate_amount: `95`,
          bill_rate_source: `'installation'`,
          currency: `'USD'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("currency is required exactly when either rate amount is set", async () => {
      await expect(
        insertTimeEntry({
          billable: `false`,
          billable_minutes: `0`,
          cost_rate_amount: `40`,
          cost_rate_source: `'installation'`,
        }),
      ).rejects.toThrow(/time_entries_currency_pair_check/);
    });
  });

  describe("project_material_uses", () => {
    async function seedInventoryItem(): Promise<string> {
      const [item] = await handle.db
        .insert(inventoryItems)
        .values({
          itemCode: `ITM-TEST-${nextSeq()}`,
          entityAttributionSource: "unattributed",
          label: "Test part",
          status: "in_stock",
          conditionCode: "good",
          currency: "USD",
          acquiredAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning();
      if (item === undefined) throw new Error("inventory item insert returned no row");
      return item.id;
    }

    async function insertMaterialUse(
      overrides: Record<string, string> = {},
    ): Promise<string> {
      const projectId = overrides["project_id"] ?? `'${await insertProject()}'`;
      return insertRow("project_material_uses", {
        description: `'A part'`,
        quantity: `1`,
        consumed_on: `'2026-06-01'`,
        currency: `'USD'`,
        cost_basis_source: `'none'`,
        ...overrides,
        project_id: projectId,
      });
    }

    it("rejects non-positive quantity", async () => {
      await expect(insertMaterialUse({ quantity: `0` })).rejects.toThrow(
        /project_material_uses_quantity_check/,
      );
    });

    it("rejects an unknown cost_basis_source", async () => {
      await expect(
        insertMaterialUse({ cost_basis_source: `'guessed'` }),
      ).rejects.toThrow(/project_material_uses_cost_basis_source_check/);
    });

    it("inventory_basis requires a real inventory_item_id, and only that source may set one", async () => {
      await expect(
        insertMaterialUse({ cost_basis_source: `'inventory_basis'` }),
      ).rejects.toThrow(/project_material_uses_cost_basis_item_check/);

      const itemId = await seedInventoryItem();
      await expect(
        insertMaterialUse({
          cost_basis_source: `'manual'`,
          inventory_item_id: `'${itemId}'`,
        }),
      ).rejects.toThrow(/project_material_uses_cost_basis_item_check/);

      await expect(
        insertMaterialUse({
          cost_basis_source: `'inventory_basis'`,
          inventory_item_id: `'${itemId}'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("a non-billable use may not carry a unit charge", async () => {
      await expect(
        insertMaterialUse({ billable: `false`, unit_charge_amount: `10` }),
      ).rejects.toThrow(/project_material_uses_billable_charge_check/);
      await expect(
        insertMaterialUse({ billable: `true`, unit_charge_amount: `10` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("rejects a markup below -100 percent", async () => {
      await expect(
        insertMaterialUse({ markup_percent: `-101` }),
      ).rejects.toThrow(/project_material_uses_markup_check/);
      await expect(
        insertMaterialUse({ markup_percent: `-100` }),
      ).resolves.toEqual(expect.any(String));
    });

    it("the idempotency probe: a movement backs at most one material use", async () => {
      const itemId = await seedInventoryItem();
      const movementId = await insertRow("inventory_movements", {
        inventory_item_id: `'${itemId}'`,
        movement_kind: `'consumption'`,
        quantity: `-1`,
        deduplication_key: `'movement-dedup-${nextSeq()}'`,
        occurred_at: `now()`,
      });

      await expect(
        insertMaterialUse({
          cost_basis_source: `'inventory_basis'`,
          inventory_item_id: `'${itemId}'`,
          inventory_movement_id: `'${movementId}'`,
        }),
      ).resolves.toEqual(expect.any(String));

      await expect(
        insertMaterialUse({
          cost_basis_source: `'inventory_basis'`,
          inventory_item_id: `'${itemId}'`,
          inventory_movement_id: `'${movementId}'`,
        }),
      ).rejects.toThrow(/project_material_uses_movement_uq/);

      // Many material uses with NO movement at all remain unconstrained —
      // this is a PARTIAL unique, not nulls-not-distinct.
      await expect(insertMaterialUse()).resolves.toEqual(expect.any(String));
      await expect(insertMaterialUse()).resolves.toEqual(expect.any(String));
    });
  });

  it("keeps every new constraint and index name inside PostgreSQL's 63-byte limit", async () => {
    const result = await handle.pool.query<{ name: string }>(
      `select conname as name from pg_constraint
        where conrelid in (
          'projects'::regclass, 'billing_rates'::regclass,
          'time_entries'::regclass, 'project_material_uses'::regclass,
          'counterparty_sites'::regclass)
       union all
       select indexname as name from pg_indexes
        where tablename in ('projects', 'billing_rates', 'time_entries',
                            'project_material_uses', 'counterparty_sites')
       union all
       select conname as name from pg_constraint
        where conrelid = 'counterparty_entity_roles'::regclass
          and conname like '%billing_site%'`,
    );
    const tooLong = result.rows
      .map((row) => row.name)
      .filter((name) => Buffer.byteLength(name, "utf8") > 63);
    expect(tooLong).toEqual([]);
  });
});
