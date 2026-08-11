/**
 * Phase 4 database invariants, against real PostgreSQL.
 *
 * The design's own instruction is explicit: "write the append-only test first —
 * an attempted `UPDATE` and an attempted `DELETE` on `inventory_movements` must
 * both fail — because it is the invariant everything else in this design
 * assumes." This file is that test, plus every `CHECK` and uniqueness rule that
 * migration 0005 relies on and every one that migration 0004 added.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createItemsService } from "../src/items.ts";
import { createMigratedScratchDb } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("phase 4 schema invariants", () => {
  let scratch: ScratchDb;
  let itemId = "";

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_schema");
    const items = createItemsService({ db: scratch.handle.db });
    const item = await items.create({
      label: "a brass lamp, no idea what it is yet",
      currency: "USD",
      quantity: "4",
    });
    itemId = item.id;
  });

  afterAll(async () => {
    await scratch.close();
  });

  /* --------------------------------------------------------- append-only */

  describe("inventory_movements is append-only", () => {
    it("rejects an UPDATE", async () => {
      const movement = await scratch.handle.db.execute(
        `select id::text as id from inventory_movements
          where inventory_item_id = '${itemId}' limit 1`,
      );
      const id = movement.rows[0]?.["id"] as string;
      expect(id).toBeTruthy();
      await expect(
        scratch.handle.pool.query(
          `update inventory_movements set note = 'tampered' where id = $1`,
          [id],
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it("rejects a DELETE", async () => {
      const movement = await scratch.handle.db.execute(
        `select id::text as id from inventory_movements
          where inventory_item_id = '${itemId}' limit 1`,
      );
      const id = movement.rows[0]?.["id"] as string;
      await expect(
        scratch.handle.pool.query(
          "delete from inventory_movements where id = $1",
          [id],
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it("names the correct correction path in the error", async () => {
      const movement = await scratch.handle.db.execute(
        `select id::text as id from inventory_movements
          where inventory_item_id = '${itemId}' limit 1`,
      );
      const id = movement.rows[0]?.["id"] as string;
      await expect(
        scratch.handle.pool.query(
          "delete from inventory_movements where id = $1",
          [id],
        ),
      ).rejects.toThrow(/reversal/i);
    });

    it("has no updated_at column — the absence IS the design statement", async () => {
      const columns = await scratch.handle.db.execute(
        `select column_name from information_schema.columns
          where table_name = 'inventory_movements'
            and column_name = 'updated_at'`,
      );
      expect(columns.rows).toHaveLength(0);
    });

    it("still permits INSERT — the ledger only grows", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into inventory_movements
             (inventory_item_id, movement_kind, quantity, deduplication_key,
              occurred_at)
           values ($1, 'found', '1', 'schema-test-insert', now())`,
          [itemId],
        ),
      ).resolves.toBeTruthy();
    });
  });

  /* ------------------------------------------------------ movement CHECKs */

  describe("movement CHECK constraints", () => {
    const insert = (
      kind: string,
      quantity: string,
      extra: Record<string, string | null> = {},
    ): Promise<unknown> => {
      const columns = ["inventory_item_id", "movement_kind", "quantity", "deduplication_key", "occurred_at"];
      const values = [`'${itemId}'`, `'${kind}'`, `'${quantity}'`, `'chk-${Math.random()}'`, "now()"];
      for (const [column, value] of Object.entries(extra)) {
        columns.push(column);
        values.push(value === null ? "null" : `'${value}'`);
      }
      return scratch.handle.pool.query(
        `insert into inventory_movements (${columns.join(", ")})
         values (${values.join(", ")})`,
      );
    };

    it("rejects a zero quantity", async () => {
      await expect(insert("found", "0")).rejects.toThrow(/quantity_check/);
    });

    it("rejects an inward kind with a negative quantity", async () => {
      await expect(insert("receipt", "-1")).rejects.toThrow(/sign_check/);
    });

    it("rejects an outward kind with a positive quantity", async () => {
      await expect(insert("depletion_sale", "1")).rejects.toThrow(/sign_check/);
    });

    it("rejects an unknown movement kind", async () => {
      await expect(insert("teleported", "1")).rejects.toThrow(/kind_check/);
    });

    it("requires a transfer_group_id on exactly the transfer kinds", async () => {
      await expect(insert("transfer_out", "-1")).rejects.toThrow(
        /transfer_group_check/,
      );
      await expect(
        insert("found", "1", { transfer_group_id: crypto.randomUUID() }),
      ).rejects.toThrow(/transfer_group_check/);
    });

    it("requires reverses_movement_id on exactly the reversal kind", async () => {
      await expect(insert("reversal", "1")).rejects.toThrow(/reversal_check/);
    });

    it("rejects a duplicate deduplication_key", async () => {
      await scratch.handle.pool.query(
        `insert into inventory_movements
           (inventory_item_id, movement_kind, quantity, deduplication_key, occurred_at)
         values ($1, 'found', '1', 'dup-probe', now())`,
        [itemId],
      );
      await expect(
        scratch.handle.pool.query(
          `insert into inventory_movements
             (inventory_item_id, movement_kind, quantity, deduplication_key, occurred_at)
           values ($1, 'found', '1', 'dup-probe', now())`,
          [itemId],
        ),
      ).rejects.toThrow(/deduplication_key_uq/);
    });
  });

  /* ----------------------------------------------------- other 0005 rules */

  describe("other Phase 4 constraints", () => {
    it("rejects a location that is its own parent", async () => {
      const rows = await scratch.handle.pool.query<{ id: string }>(
        `insert into inventory_locations (code, name, kind, path)
         values ('SELFREF', 'self', 'site', 'SELFREF') returning id`,
      );
      const id = rows.rows[0]?.id ?? "";
      await expect(
        scratch.handle.pool.query(
          "update inventory_locations set parent_location_id = id where id = $1",
          [id],
        ),
      ).rejects.toThrow(/self_parent_check/);
    });

    it("treats two null-parent locations with one name as a duplicate", async () => {
      await scratch.handle.pool.query(
        `insert into inventory_locations (code, name, kind, path)
         values ('ROOT-A', 'Home', 'site', 'ROOT-A')`,
      );
      // NULLS NOT DISTINCT: without it PostgreSQL would treat each null parent
      // as distinct and allow this.
      await expect(
        scratch.handle.pool.query(
          `insert into inventory_locations (code, name, kind, path)
           values ('ROOT-B', 'Home', 'site', 'ROOT-B')`,
        ),
      ).rejects.toThrow(/parent_name_uq/);
    });

    it("rejects a location deeper than the cap", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into inventory_locations (code, name, kind, path, depth)
           values ('TOODEEP', 'too deep', 'bin', 'TOODEEP', 7)`,
        ),
      ).rejects.toThrow(/depth_check/);
    });

    it("rejects a grade label with no grading authority", async () => {
      await expect(
        scratch.handle.pool.query(
          `update inventory_items set grade_label = 'PSA 9' where id = $1`,
          [itemId],
        ),
      ).rejects.toThrow(/grade_authority_check/);
    });

    it("rejects an unknown condition code", async () => {
      await expect(
        scratch.handle.pool.query(
          `update inventory_items set condition_code = 'mint' where id = $1`,
          [itemId],
        ),
      ).rejects.toThrow(/condition_code_check/);
    });

    it("ties cost_source = 'fee_derived' to order_fee_id", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into shipments (shipment_kind, status, cost_source)
           values ('transfer', 'shipped', 'fee_derived')`,
        ),
      ).rejects.toThrow(/fee_derived_link_check/);
    });

    it("ties shipment_kind = 'outbound_sale' to an order", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into shipments (shipment_kind, status, cost_source)
           values ('outbound_sale', 'shipped', 'manual')`,
        ),
      ).rejects.toThrow(/outbound_sale_order_check/);
    });

    it("requires an allocation kind and its reference to agree", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into inventory_allocations
             (inventory_item_id, allocation_kind, quantity, status)
           values ($1, 'order_line', '1', 'reserved')`,
          [itemId],
        ),
      ).rejects.toThrow(/kind_reference_check/);
    });

    it("requires an opportunity link to name a subject and evidence", async () => {
      // Naming neither trips one of the two `num_nonnulls` CHECKs — which one
      // is PostgreSQL's evaluation order and not a fact worth asserting.
      await expect(
        scratch.handle.pool.query(
          `insert into acquisition_opportunity_links (link_kind)
           values ('sourced_from')`,
        ),
      ).rejects.toThrow(/subject_check|evidence_check/);
      // Naming a subject but no evidence trips the evidence check specifically.
      await expect(
        scratch.handle.pool.query(
          `insert into acquisition_opportunity_links (link_kind, inventory_item_id)
           values ('sourced_from', $1)`,
          [itemId],
        ),
      ).rejects.toThrow(/evidence_check/);
    });

    it("defines no PostgreSQL enum types for the Phase 4 tables", async () => {
      const enums = await scratch.handle.db.execute(
        `select typname from pg_type where typtype = 'e'`,
      );
      expect(enums.rows).toHaveLength(0);
    });

    it("makes none of the Phase 4 tables a hypertable", async () => {
      const hypertables = await scratch.handle.db.execute(
        `select hypertable_name from timescaledb_information.hypertables
          where hypertable_name in
                ('acquisitions', 'acquisition_costs', 'inventory_locations',
                 'inventory_items', 'inventory_allocations',
                 'inventory_movements', 'shipments', 'shipment_items',
                 'acquisition_opportunity_links')`,
      );
      expect(hypertables.rows).toHaveLength(0);
    });
  });

  /* ----------------------------------------- migration 0004 (loxep-dyx) */

  describe("link-table constraints (migration 0004)", () => {
    let mediaObjectId = "";
    let externalResourceId = "";

    beforeAll(async () => {
      const backend = await scratch.handle.pool.query<{ id: string }>(
        `insert into storage_backends (name, driver) values ('local', 'local')
         returning id`,
      );
      const media = await scratch.handle.pool.query<{ id: string }>(
        `insert into media_objects
           (storage_backend_id, storage_key, size_bytes, sha256)
         values ($1, 'lot-photo.jpg', 1024, 'abc123') returning id`,
        [backend.rows[0]?.id],
      );
      mediaObjectId = media.rows[0]?.id ?? "";
      const resource = await scratch.handle.pool.query<{ id: string }>(
        `insert into external_resources (provider, external_type, url)
         values ('vikunja', 'task', 'https://example.invalid/1') returning id`,
      );
      externalResourceId = resource.rows[0]?.id ?? "";
    });

    it("rejects a duplicate media link", async () => {
      await scratch.handle.pool.query(
        `insert into media_links (media_object_id, resource_type, resource_id, purpose)
         values ($1, 'acquisition', $2, 'receipt')`,
        [mediaObjectId, itemId],
      );
      await expect(
        scratch.handle.pool.query(
          `insert into media_links (media_object_id, resource_type, resource_id, purpose)
           values ($1, 'acquisition', $2, 'receipt')`,
          [mediaObjectId, itemId],
        ),
      ).rejects.toThrow(/media_links_object_resource_purpose_uq/);
    });

    it("gives an at-least-once writer an ON CONFLICT target", async () => {
      // This is the whole point of the fix: the second attempt is a no-op
      // rather than a duplicate row.
      const result = await scratch.handle.pool.query(
        `insert into media_links (media_object_id, resource_type, resource_id, purpose)
         values ($1, 'acquisition', $2, 'receipt')
         on conflict (media_object_id, resource_type, resource_id, purpose)
         do nothing`,
        [mediaObjectId, itemId],
      );
      expect(result.rowCount).toBe(0);
    });

    it("still allows the same object under a DIFFERENT purpose", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into media_links (media_object_id, resource_type, resource_id, purpose)
           values ($1, 'acquisition', $2, 'condition_evidence')`,
          [mediaObjectId, itemId],
        ),
      ).resolves.toBeTruthy();
    });

    it("does not let sort_order create a duplicate attachment", async () => {
      await expect(
        scratch.handle.pool.query(
          `insert into media_links
             (media_object_id, resource_type, resource_id, purpose, sort_order)
           values ($1, 'acquisition', $2, 'receipt', 5)`,
          [mediaObjectId, itemId],
        ),
      ).rejects.toThrow(/media_links_object_resource_purpose_uq/);
    });

    it("rejects a duplicate resource link", async () => {
      await scratch.handle.pool.query(
        `insert into resource_links
           (external_resource_id, resource_type, resource_id, purpose)
         values ($1, 'inventory_item', $2, 'spec')`,
        [externalResourceId, itemId],
      );
      await expect(
        scratch.handle.pool.query(
          `insert into resource_links
             (external_resource_id, resource_type, resource_id, purpose)
           values ($1, 'inventory_item', $2, 'spec')`,
          [externalResourceId, itemId],
        ),
      ).rejects.toThrow(/resource_links_resource_purpose_uq/);
    });

    it("indexes both directions", async () => {
      const indexes = await scratch.handle.db.execute(
        `select indexname from pg_indexes
          where tablename in ('media_links', 'resource_links')
          order by indexname`,
      );
      const names = indexes.rows.map((row) => row["indexname"] as string);
      // Resource -> object, and (via the unique's leading column) object ->
      // resource.
      expect(names).toContain("media_links_resource_idx");
      expect(names).toContain("media_links_object_resource_purpose_uq");
      expect(names).toContain("resource_links_resource_idx");
      expect(names).toContain("resource_links_resource_purpose_uq");
    });
  });
});
