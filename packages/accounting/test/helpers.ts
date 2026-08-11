/**
 * Scratch-database lifecycle and seed helpers for the @loxep/accounting suite.
 *
 * Real PostgreSQL/TimescaleDB (docker/compose.dev.yml, host port 5433), never a
 * SQLite substitute — every `CHECK` in migration 0006, the `media_links`
 * natural key from 0004, `num_nonnulls`, and exact `numeric(20,6)` arithmetic
 * have no meaning anywhere else. Each test file provisions its own scratch
 * database so files run in parallel and never depend on leftover state.
 *
 * `pg` is not a direct dependency of this package, so maintenance queries go
 * through @loxep/db's pooled handle — the @loxep/commerce, @loxep/market, and
 * @loxep/inventory pattern.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  acquisitionCosts,
  acquisitions,
  catalogItems,
  economicEntities,
  user,
} from "@loxep/db/schema";
import type { createSecretsService } from "@loxep/domain";
import { createMediaService, createStorageBackendsService } from "@loxep/storage";
import type { MediaService } from "@loxep/storage";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:loxep-dev@localhost:5433/loxep_test";

export const baseDatabaseUrl =
  process.env["LOXEP_TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;

function maintenanceUrl(): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function scratchDbName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface ScratchDb {
  name: string;
  handle: DbHandle;
  close: () => Promise<void>;
}

async function withMaintenanceDb(sql: string): Promise<void> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(sql);
  } finally {
    await closeDb(handle);
  }
}

/** Create a migrated scratch database and a pooled handle bound to it. */
export async function createMigratedScratchDb(
  prefix: string,
): Promise<ScratchDb> {
  const name = scratchDbName(prefix);
  await withMaintenanceDb(`create database "${name}"`);
  const databaseUrl = databaseUrlFor(name);
  await runMigrations({ databaseUrl, logger: silentLogger });
  const handle = createDb(databaseUrl);
  return {
    name,
    handle,
    close: async () => {
      await closeDb(handle);
      await withMaintenanceDb(`drop database if exists "${name}" with (force)`);
    },
  };
}

export async function seedEntity(
  scratch: ScratchDb,
  name: string,
  kind = "llc",
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(economicEntities)
    .values({ name, kind })
    .returning({ id: economicEntities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("entity insert returned no row");
  return id;
}

/** A Better Auth user row usable as an FK-valid actor (ADR-0020). */
export async function seedUser(
  scratch: ScratchDb,
  id: string,
): Promise<string> {
  await scratch.handle.db.insert(user).values({
    id,
    name: `Test User ${id}`,
    email: `${id}@example.test`,
  });
  return id;
}

/** A Phase 4 lot, so allocation and cost-reference foreign keys are real. */
export async function seedAcquisition(
  scratch: ScratchDb,
  referenceCode: string,
): Promise<{ acquisitionId: string; acquisitionCostId: string }> {
  const rows = await scratch.handle.db
    .insert(acquisitions)
    .values({
      entityAttributionSource: "unattributed",
      sourceKind: "estate_sale",
      status: "open",
      referenceCode,
      title: `Lot ${referenceCode}`,
      currency: "USD",
      costAllocationBasis: "equal",
      costAllocationStatus: "pending",
      acquiredAt: new Date("2026-03-01T12:00:00Z"),
    })
    .returning({ id: acquisitions.id });
  const acquisitionId = rows[0]?.id;
  if (acquisitionId === undefined) {
    throw new Error("acquisition insert returned no row");
  }
  const costRows = await scratch.handle.db
    .insert(acquisitionCosts)
    .values({
      acquisitionId,
      costScope: "lot",
      costType: "fuel_mileage",
      costClass: "ancillary",
      capitalize: false,
      currency: "USD",
      amount: "24.500000",
    })
    .returning({ id: acquisitionCosts.id });
  const acquisitionCostId = costRows[0]?.id;
  if (acquisitionCostId === undefined) {
    throw new Error("acquisition cost insert returned no row");
  }
  return { acquisitionId, acquisitionCostId };
}

export async function seedCatalogItem(
  scratch: ScratchDb,
  sku: string,
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(catalogItems)
    .values({ sku, kind: "simple", name: `Item ${sku}`, status: "active" })
    .returning({ id: catalogItems.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("catalog item insert returned no row");
  return id;
}

type Keyring = Parameters<typeof createSecretsService>[0]["keyring"];

/** Deterministic structural test keyring (ADR-0019 shape). */
function testKeyring(): Keyring {
  return { activeVersion: 1, keys: new Map([[1, Buffer.alloc(32, 1)]]) };
}

/**
 * A real {@link MediaService} bound to the scratch database, plus a
 * `media_objects` row to attach.
 *
 * The bytes are never written: receipt attachment exercises `addLink` /
 * `listLinksForResource` / `removeLink`, none of which resolve a storage
 * driver. Seeding the rows directly keeps the receipt tests about the
 * `media_links` contract — which is what Phase 5 actually relies on — rather
 * than about local-filesystem I/O that `@loxep/storage`'s own conformance
 * suite already covers.
 */
export async function seedMedia(
  scratch: ScratchDb,
  sha256: string,
): Promise<{ media: MediaService; mediaObjectId: string }> {
  const backend = await scratch.handle.pool.query<{ id: string }>(
    `insert into storage_backends (name, driver, config)
     values ('local-test', 'local', '{"root":"/tmp/loxep-accounting-test"}'::jsonb)
     on conflict do nothing
     returning id`,
  );
  const backendId =
    backend.rows[0]?.id ??
    (
      await scratch.handle.pool.query<{ id: string }>(
        `select id from storage_backends limit 1`,
      )
    ).rows[0]?.id;
  if (backendId === undefined) throw new Error("no storage backend seeded");

  const media = await scratch.handle.pool.query<{ id: string }>(
    `insert into media_objects (storage_backend_id, storage_key, original_filename,
                                mime_type, size_bytes, sha256)
     values ($1, $2, 'receipt.jpg', 'image/jpeg', 1024, $3)
     returning id`,
    [backendId, `media/${sha256}.jpg`, sha256],
  );
  const mediaObjectId = media.rows[0]?.id;
  if (mediaObjectId === undefined) {
    throw new Error("media object insert returned no row");
  }

  return {
    media: createMediaService({
      db: scratch.handle.db,
      backends: createStorageBackendsService({
        db: scratch.handle.db,
        keyring: testKeyring(),
      }),
    }),
    mediaObjectId,
  };
}

/** Every `audit_events` row for one action, newest first. */
export async function auditEventsFor(
  scratch: ScratchDb,
  action: string,
): Promise<
  { resourceId: string | null; before: unknown; after: unknown; metadata: unknown }[]
> {
  const result = await scratch.handle.pool.query(
    `select resource_id, before, after, metadata
       from audit_events where action = $1
      order by occurred_at desc, id desc`,
    [action],
  );
  return result.rows.map((row) => ({
    resourceId: (row["resource_id"] as string | null) ?? null,
    before: row["before"],
    after: row["after"],
    metadata: row["metadata"],
  }));
}
