/**
 * Migration 0006's counterparty DDL against real PostgreSQL.
 *
 * Every `CHECK`, both `NULLS NOT DISTINCT` uniques, the two partial primary
 * uniques, the `num_nonnulls` discriminator, and — most importantly — the
 * ABSENCE of the columns that would collapse the counterparty/entity boundary.
 *
 * These write through the pool rather than through the services, because a
 * service that validates first would hide whether the database validates at
 * all. The design's own pre-implementation checklist asks for exactly this:
 * *"write the counterparty-boundary tests: a `tax_identifier` on a `person`
 * row must fail."*
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedScratchDb, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("counterparty schema (migration 0006)", () => {
  let scratch: ScratchDb;
  let entityId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_cp_schema");
    entityId = await seedEntity(scratch, "Loxep LLC");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  let sequence = 0;
  async function insertCounterparty(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    sequence += 1;
    const columns: Record<string, string> = {
      reference_code: `'CP-TEST-${sequence}'`,
      kind: `'organization'`,
      display_name: `'Acme ${sequence}'`,
      normalized_name: `'acme ${sequence}'`,
      ...overrides,
    };
    const result = await scratch.handle.pool.query<{ id: string }>(
      `insert into counterparties (${Object.keys(columns).join(", ")})
       values (${Object.values(columns).join(", ")}) returning id`,
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error("counterparty insert returned no row");
    return id;
  }

  describe("the boundary, made physical", () => {
    it("has NO economic_entity_id on counterparties", async () => {
      const result = await scratch.handle.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'counterparties'`,
      );
      const columns = result.rows.map((row) => row.column_name);
      expect(columns).not.toContain("economic_entity_id");
      // The mirror is the ONE crossing, and it is named after what it is.
      expect(columns).toContain("mirrors_economic_entity_id");
    });

    it("has NO counterparty_id on economic_entities — not now, not ever", async () => {
      const result = await scratch.handle.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'economic_entities'`,
      );
      expect(result.rows.map((row) => row.column_name)).not.toContain(
        "counterparty_id",
      );
    });

    it("creates no `parties` supertype and no union view", async () => {
      const result = await scratch.handle.pool.query<{ count: string }>(
        `select count(*)::text as count from information_schema.tables
          where table_name in ('parties', 'party', 'counterparty_entities')`,
      );
      expect(result.rows[0]?.count).toBe("0");
    });

    it("REFUSES a tax identifier on a person", async () => {
      await expect(
        insertCounterparty({
          kind: `'person'`,
          tax_identifier: `'123-45-6789'`,
          tax_identifier_kind: `'other'`,
        }),
      ).rejects.toThrow(/counterparties_tax_identifier_org_check/);
    });

    it("accepts a tax identifier on an organization", async () => {
      await expect(
        insertCounterparty({
          tax_identifier: `'GB123456789'`,
          tax_identifier_kind: `'vat'`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("requires the identifier and its kind together, in both directions", async () => {
      await expect(
        insertCounterparty({ tax_identifier: `'GB999'` }),
      ).rejects.toThrow(/counterparties_tax_identifier_pair_check/);
      await expect(
        insertCounterparty({ tax_identifier_kind: `'vat'` }),
      ).rejects.toThrow(/counterparties_tax_identifier_pair_check/);
    });

    it("rejects an unknown tax_identifier_kind", async () => {
      await expect(
        insertCounterparty({
          tax_identifier: `'X'`,
          tax_identifier_kind: `'ssn'`,
        }),
      ).rejects.toThrow(/counterparties_tax_identifier_kind_check/);
    });
  });

  describe("counterparties CHECK constraints", () => {
    it("rejects an unknown kind — there is no `customer` kind", async () => {
      await expect(insertCounterparty({ kind: `'customer'` })).rejects.toThrow(
        /counterparties_kind_check/,
      );
    });

    it("rejects an unknown status", async () => {
      await expect(insertCounterparty({ status: `'deleted'` })).rejects.toThrow(
        /counterparties_status_check/,
      );
    });

    it("rejects a self merge", async () => {
      const id = await insertCounterparty();
      await expect(
        scratch.handle.pool.query(
          `update counterparties
              set merged_into_counterparty_id = id, merged_at = now()
            where id = $1`,
          [id],
        ),
      ).rejects.toThrow(/counterparties_self_merge_check/);
    });

    it("requires merged_into and merged_at together", async () => {
      const survivor = await insertCounterparty();
      const loser = await insertCounterparty();
      await expect(
        scratch.handle.pool.query(
          `update counterparties set merged_into_counterparty_id = $2 where id = $1`,
          [loser, survivor],
        ),
      ).rejects.toThrow(/counterparties_merge_pair_check/);
      await expect(
        scratch.handle.pool.query(
          `update counterparties set merged_at = now() where id = $1`,
          [loser],
        ),
      ).rejects.toThrow(/counterparties_merge_pair_check/);
    });

    it("enforces reference_code uniqueness", async () => {
      await insertCounterparty({ reference_code: `'CP-2026-0001'` });
      await expect(
        insertCounterparty({ reference_code: `'CP-2026-0001'` }),
      ).rejects.toThrow(/counterparties_reference_code_uq/);
    });

    it("does NOT make normalized_name unique — two Smith Plumbings are real", async () => {
      await insertCounterparty({ normalized_name: `'smith plumbing'` });
      await expect(
        insertCounterparty({ normalized_name: `'smith plumbing'` }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe("counterparty_contacts", () => {
    it("permits at most one primary contact per party", async () => {
      const partyId = await insertCounterparty();
      await scratch.handle.pool.query(
        `insert into counterparty_contacts (counterparty_id, display_name, is_primary)
         values ($1, 'Jane', true)`,
        [partyId],
      );
      await expect(
        scratch.handle.pool.query(
          `insert into counterparty_contacts (counterparty_id, display_name, is_primary)
           values ($1, 'Bob', true)`,
          [partyId],
        ),
      ).rejects.toThrow(/counterparty_contacts_primary_uq/);
      // Non-primary contacts are unconstrained.
      await expect(
        scratch.handle.pool.query(
          `insert into counterparty_contacts (counterparty_id, display_name)
           values ($1, 'Bob')`,
          [partyId],
        ),
      ).resolves.toBeDefined();
    });

    it("rejects an unknown contact status", async () => {
      const partyId = await insertCounterparty();
      await expect(
        scratch.handle.pool.query(
          `insert into counterparty_contacts (counterparty_id, display_name, status)
           values ($1, 'Jane', 'archived')`,
          [partyId],
        ),
      ).rejects.toThrow(/counterparty_contacts_status_check/);
    });

    it("cascades contacts when the counterparty is deleted", async () => {
      const partyId = await insertCounterparty();
      await scratch.handle.pool.query(
        `insert into counterparty_contacts (counterparty_id, display_name)
         values ($1, 'Jane')`,
        [partyId],
      );
      await scratch.handle.pool.query(
        `delete from counterparties where id = $1`,
        [partyId],
      );
      const remaining = await scratch.handle.pool.query(
        `select 1 from counterparty_contacts where counterparty_id = $1`,
        [partyId],
      );
      expect(remaining.rowCount).toBe(0);
    });
  });

  describe("contact_channels", () => {
    async function seedContact(partyId: string): Promise<string> {
      const result = await scratch.handle.pool.query<{ id: string }>(
        `insert into counterparty_contacts (counterparty_id, display_name)
         values ($1, 'Jane') returning id`,
        [partyId],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error("contact insert returned no row");
      return id;
    }

    it("requires exactly one owner — never both, never neither", async () => {
      const partyId = await insertCounterparty();
      const contactId = await seedContact(partyId);
      await expect(
        scratch.handle.pool.query(
          `insert into contact_channels
             (counterparty_id, counterparty_contact_id, channel_kind, value, normalized_value)
           values ($1, $2, 'email', 'a@b.test', 'a@b.test')`,
          [partyId, contactId],
        ),
      ).rejects.toThrow(/contact_channels_owner_check/);
      await expect(
        scratch.handle.pool.query(
          `insert into contact_channels (channel_kind, value, normalized_value)
           values ('email', 'a@b.test', 'a@b.test')`,
        ),
      ).rejects.toThrow(/contact_channels_owner_check/);
    });

    it("rejects an unknown channel kind", async () => {
      const partyId = await insertCounterparty();
      await expect(
        scratch.handle.pool.query(
          `insert into contact_channels
             (counterparty_id, channel_kind, value, normalized_value)
           values ($1, 'carrier_pigeon', 'x', 'x')`,
          [partyId],
        ),
      ).rejects.toThrow(/contact_channels_kind_check/);
    });

    it("rejects a duplicate value under NULLS NOT DISTINCT", async () => {
      // This is the case a plain UNIQUE would silently permit: the OTHER owner
      // column is null on both rows, so default null handling treats them as
      // distinct.
      const partyId = await insertCounterparty();
      await scratch.handle.pool.query(
        `insert into contact_channels
           (counterparty_id, channel_kind, value, normalized_value)
         values ($1, 'email', 'Billing@Acme.test', 'billing@acme.test')`,
        [partyId],
      );
      await expect(
        scratch.handle.pool.query(
          `insert into contact_channels
             (counterparty_id, channel_kind, value, normalized_value)
           values ($1, 'email', 'billing@acme.test', 'billing@acme.test')`,
          [partyId],
        ),
      ).rejects.toThrow(/contact_channels_owner_kind_value_uq/);
    });

    it("applies the same rule to a contact-owned channel", async () => {
      const partyId = await insertCounterparty();
      const contactId = await seedContact(partyId);
      await scratch.handle.pool.query(
        `insert into contact_channels
           (counterparty_contact_id, channel_kind, value, normalized_value)
         values ($1, 'mobile', '555', '555')`,
        [contactId],
      );
      await expect(
        scratch.handle.pool.query(
          `insert into contact_channels
             (counterparty_contact_id, channel_kind, value, normalized_value)
           values ($1, 'mobile', '555', '555')`,
          [contactId],
        ),
      ).rejects.toThrow(/contact_channels_owner_kind_value_uq/);
    });

    it("lets two different parties hold the same address", async () => {
      const first = await insertCounterparty();
      const second = await insertCounterparty();
      for (const partyId of [first, second]) {
        await scratch.handle.pool.query(
          `insert into contact_channels
             (counterparty_id, channel_kind, value, normalized_value)
           values ($1, 'email', 'shared@family.test', 'shared@family.test')`,
          [partyId],
        );
      }
      const rows = await scratch.handle.pool.query(
        `select 1 from contact_channels where normalized_value = 'shared@family.test'`,
      );
      expect(rows.rowCount).toBe(2);
    });

    it("permits at most one primary channel per owner per kind", async () => {
      const partyId = await insertCounterparty();
      await scratch.handle.pool.query(
        `insert into contact_channels
           (counterparty_id, channel_kind, value, normalized_value, is_primary)
         values ($1, 'email', 'a@acme.test', 'a@acme.test', true)`,
        [partyId],
      );
      await expect(
        scratch.handle.pool.query(
          `insert into contact_channels
             (counterparty_id, channel_kind, value, normalized_value, is_primary)
           values ($1, 'email', 'b@acme.test', 'b@acme.test', true)`,
          [partyId],
        ),
      ).rejects.toThrow(/contact_channels_owner_kind_primary_uq/);
      // A primary of a DIFFERENT kind is fine.
      await expect(
        scratch.handle.pool.query(
          `insert into contact_channels
             (counterparty_id, channel_kind, value, normalized_value, is_primary)
           values ($1, 'phone', '555', '555', true)`,
          [partyId],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("counterparty_entity_roles", () => {
    async function insertRole(
      partyId: string,
      overrides: Record<string, string> = {},
    ) {
      const columns: Record<string, string> = {
        counterparty_id: `'${partyId}'`,
        role: `'customer'`,
        ...overrides,
      };
      return scratch.handle.pool.query(
        `insert into counterparty_entity_roles (${Object.keys(columns).join(", ")})
         values (${Object.values(columns).join(", ")})`,
      );
    }

    it("rejects an unknown role — no typo may create an uninvoiceable party", async () => {
      const partyId = await insertCounterparty();
      await expect(insertRole(partyId, { role: `'Customer'` })).rejects.toThrow(
        /counterparty_entity_roles_role_check/,
      );
    });

    it("rejects an unknown status", async () => {
      const partyId = await insertCounterparty();
      await expect(
        insertRole(partyId, { status: `'archived'` }),
      ).rejects.toThrow(/counterparty_entity_roles_status_check/);
    });

    it("rejects until_on before since_on", async () => {
      const partyId = await insertCounterparty();
      await expect(
        insertRole(partyId, {
          since_on: `'2026-06-01'`,
          until_on: `'2026-05-01'`,
        }),
      ).rejects.toThrow(/counterparty_entity_roles_dates_check/);
    });

    it("rejects negative payment terms", async () => {
      const partyId = await insertCounterparty();
      await expect(
        insertRole(partyId, { payment_terms_days: `-1` }),
      ).rejects.toThrow(/counterparty_entity_roles_terms_check/);
      await expect(
        insertRole(partyId, { payment_terms_days: `0` }),
      ).resolves.toBeDefined();
    });

    it("enforces (party, entity, role) uniqueness", async () => {
      const partyId = await insertCounterparty();
      await insertRole(partyId, { economic_entity_id: `'${entityId}'` });
      await expect(
        insertRole(partyId, { economic_entity_id: `'${entityId}'` }),
      ).rejects.toThrow(/counterparty_entity_roles_party_entity_role_uq/);
    });

    it("enforces it for a NULL entity too — this is what NULLS NOT DISTINCT buys", async () => {
      // Without NULLS NOT DISTINCT this constraint would be silently inert for
      // exactly the rows the early, unattributed installation creates.
      const partyId = await insertCounterparty();
      await insertRole(partyId);
      await expect(insertRole(partyId)).rejects.toThrow(
        /counterparty_entity_roles_party_entity_role_uq/,
      );
    });

    it("still allows the same role against a different entity", async () => {
      const partyId = await insertCounterparty();
      const otherEntity = await seedEntity(scratch, "Second LLC");
      await insertRole(partyId, { economic_entity_id: `'${entityId}'` });
      await expect(
        insertRole(partyId, { economic_entity_id: `'${otherEntity}'` }),
      ).resolves.toBeDefined();
    });

    it("allows one party to be both customer and vendor", async () => {
      const partyId = await insertCounterparty();
      await insertRole(partyId, { role: `'customer'` });
      await expect(
        insertRole(partyId, { role: `'vendor'` }),
      ).resolves.toBeDefined();
    });

    it("stores since_on/until_on as `date`, not timestamptz", async () => {
      const result = await scratch.handle.pool.query<{
        column_name: string;
        data_type: string;
      }>(
        `select column_name, data_type from information_schema.columns
          where table_name = 'counterparty_entity_roles'
            and column_name in ('since_on', 'until_on', 'created_at')`,
      );
      const byName = new Map(
        result.rows.map((row) => [row.column_name, row.data_type]),
      );
      expect(byName.get("since_on")).toBe("date");
      expect(byName.get("until_on")).toBe("date");
      expect(byName.get("created_at")).toBe("timestamp with time zone");
    });
  });

  it("keeps every constraint and index name inside PostgreSQL's 63-byte limit", async () => {
    // A derived name over 63 bytes is silently TRUNCATED, which is how two
    // constraints collide months later. Five foreign keys here are named
    // explicitly for that reason; this asserts none slipped through.
    const result = await scratch.handle.pool.query<{ name: string }>(
      `select conname as name from pg_constraint
        where conrelid in (
          'counterparties'::regclass, 'counterparty_contacts'::regclass,
          'contact_channels'::regclass, 'counterparty_entity_roles'::regclass,
          'expenses'::regclass, 'expense_allocations'::regclass)
       union all
       select indexname as name from pg_indexes
        where tablename in ('counterparties', 'counterparty_contacts',
                            'contact_channels', 'counterparty_entity_roles',
                            'expenses', 'expense_allocations')`,
    );
    const tooLong = result.rows
      .map((row) => row.name)
      .filter((name) => Buffer.byteLength(name, "utf8") > 63);
    expect(tooLong).toEqual([]);
  });
});
