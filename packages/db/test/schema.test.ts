/**
 * Foundation schema integration tests against a real
 * PostgreSQL + TimescaleDB (docker/compose.dev.yml).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "../src/migrate.ts";
import type { DbHandle } from "../src/migrate.ts";
import {
  connections,
  economicEntities,
  user,
} from "../src/schema/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

describe("foundation schema", () => {
  const dbName = scratchDbName("loxep_test_schema");
  let handle: DbHandle;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("creates marketplace_item_observations as a hypertable with 7-day chunks", async () => {
    const hypertables = await handle.pool.query(
      `select hypertable_name
         from timescaledb_information.hypertables
        where hypertable_name = 'marketplace_item_observations'`,
    );
    expect(hypertables.rowCount).toBe(1);

    const dimension = await handle.pool.query<{
      column_name: string;
      time_interval: { days?: number };
    }>(
      `select column_name, time_interval
         from timescaledb_information.dimensions
        where hypertable_name = 'marketplace_item_observations'`,
    );
    expect(dimension.rows[0]?.column_name).toBe("observed_at");
    expect(dimension.rows[0]?.time_interval).toMatchObject({ days: 7 });
  });

  it("has a 30-day columnstore policy and no retention policy", async () => {
    const jobs = await handle.pool.query<{
      proc_name: string;
      config: { compress_after?: string };
    }>(
      `select proc_name, config
         from timescaledb_information.jobs
        where hypertable_name = 'marketplace_item_observations'`,
    );
    const procNames = jobs.rows.map((row) => row.proc_name);
    expect(procNames).toContain("policy_compression");
    expect(procNames).not.toContain("policy_retention");
    const compression = jobs.rows.find(
      (row) => row.proc_name === "policy_compression",
    );
    expect(compression?.config.compress_after).toBe("30 days");
  });

  it("rejects duplicate (observation_batch_id, marketplace_item_id, observed_at)", async () => {
    const insert = `
      insert into marketplace_item_observations
        (marketplace_item_id, observed_at, observation_batch_id, source, price, currency)
      values ($1, $2, $3, 'test', '19.990000', 'USD')`;
    const itemId = "1c56b4f4-8f4d-4f7e-9b1a-53b3a1d1a001";
    const batchId = "2d67c5e5-9e5e-4e8f-8c2b-64c4b2e2b002";
    const observedAt = new Date("2026-08-01T12:00:00Z");

    await handle.pool.query(insert, [itemId, observedAt, batchId]);
    // Same batch retried: conflicts instead of duplicating.
    await expect(
      handle.pool.query(insert, [itemId, observedAt, batchId]),
    ).rejects.toMatchObject({ code: "23505" });

    // A different batch observing the same item at the same moment remains a
    // distinct, insertable fact.
    await handle.pool.query(insert, [
      itemId,
      observedAt,
      "3e78d6f6-af6f-4f9a-9d3c-75d5c3f3c003",
    ]);
  });

  it("sets created_by_user_id to null when the auth user is deleted (no cascade into domain rows)", async () => {
    const { db } = handle;
    await db.insert(user).values({
      id: "user_set_null_test",
      name: "Provenance Test",
      email: "provenance@example.test",
    });
    const [entity] = await db
      .insert(economicEntities)
      .values({ name: "Test LLC", kind: "llc" })
      .returning();
    if (entity === undefined) throw new Error("entity insert returned no row");
    const [connection] = await db
      .insert(connections)
      .values({
        provider: "ebay",
        kind: "marketplace_account",
        name: "Test Connection",
        status: "active",
        economicEntityId: entity.id,
        createdByUserId: "user_set_null_test",
      })
      .returning();
    if (connection === undefined) {
      throw new Error("connection insert returned no row");
    }

    await db.delete(user).where(eq(user.id, "user_set_null_test"));

    const [survivor] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connection.id));
    expect(survivor).toBeDefined();
    expect(survivor?.createdByUserId).toBeNull();

    const [entitySurvivor] = await db
      .select()
      .from(economicEntities)
      .where(eq(economicEntities.id, entity.id));
    expect(entitySurvivor).toBeDefined();
  });

  it("gives the link tables a unique key an at-least-once writer can conflict on (loxep-dyx)", async () => {
    // 0000 created media_links and resource_links with no PK, no unique, and no
    // index, so a retried attachment job silently double-linked. 0004 added the
    // natural key; this asserts both halves of the fix.
    const backend = await handle.pool.query<{ id: string }>(
      `insert into storage_backends (name, driver) values ('local', 'local')
       returning id`,
    );
    const media = await handle.pool.query<{ id: string }>(
      `insert into media_objects (storage_backend_id, storage_key, size_bytes, sha256)
       values ($1, 'lot.jpg', 10, 'deadbeef') returning id`,
      [backend.rows[0]?.id],
    );
    const mediaId = media.rows[0]?.id;

    await handle.pool.query(
      `insert into media_links (media_object_id, resource_type, resource_id, purpose)
       values ($1, 'acquisition', 'acq-1', 'receipt')`,
      [mediaId],
    );
    await expect(
      handle.pool.query(
        `insert into media_links (media_object_id, resource_type, resource_id, purpose)
         values ($1, 'acquisition', 'acq-1', 'receipt')`,
        [mediaId],
      ),
    ).rejects.toThrow(/media_links_object_resource_purpose_uq/);

    const retried = await handle.pool.query(
      `insert into media_links (media_object_id, resource_type, resource_id, purpose)
       values ($1, 'acquisition', 'acq-1', 'receipt')
       on conflict (media_object_id, resource_type, resource_id, purpose)
       do nothing`,
      [mediaId],
    );
    expect(retried.rowCount).toBe(0);

    const resource = await handle.pool.query<{ id: string }>(
      `insert into external_resources (provider, external_type, url)
       values ('vikunja', 'task', 'https://example.invalid/1') returning id`,
    );
    await handle.pool.query(
      `insert into resource_links (external_resource_id, resource_type, resource_id, purpose)
       values ($1, 'acquisition', 'acq-1', 'spec')`,
      [resource.rows[0]?.id],
    );
    await expect(
      handle.pool.query(
        `insert into resource_links (external_resource_id, resource_type, resource_id, purpose)
         values ($1, 'acquisition', 'acq-1', 'spec')`,
        [resource.rows[0]?.id],
      ),
    ).rejects.toThrow(/resource_links_resource_purpose_uq/);
  });

  it("installs the inventory_movements append-only trigger", async () => {
    const triggers = await handle.pool.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid = 'inventory_movements'::regclass and not tgisinternal`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toContain(
      "inventory_movements_append_only",
    );
  });

  it("defines no PostgreSQL enum types for loxep tables", async () => {
    const enums = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where t.typtype = 'e'
          and n.nspname not in ('pg_catalog', 'information_schema')`,
    );
    expect(enums.rows[0]?.count).toBe("0");
  });
});
