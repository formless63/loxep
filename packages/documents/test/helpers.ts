/**
 * Scratch-database lifecycle and seed helpers for the @loxep/documents suite.
 *
 * Real PostgreSQL (docker/compose.dev.yml, host port 5433), never a SQLite
 * substitute — migration 0017's `CHECK`s (`documents_source_kind_media_object_check`,
 * `document_line_candidates_target_pair_check`, the confidence range) have no
 * meaning anywhere else. Each test file provisions its own scratch database
 * so files run in parallel and never depend on leftover state.
 */
import { randomBytes } from "node:crypto";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { economicEntities, mediaObjects, storageBackends, user } from "@loxep/db/schema";

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
export async function createMigratedScratchDb(prefix: string): Promise<ScratchDb> {
  const name = scratchDbName(prefix);
  await withMaintenanceDb(`create database "${name}" template template0`);
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

/** A Better Auth user row usable as an FK-valid actor (ADR-0020). */
export async function seedUser(scratch: ScratchDb, id: string): Promise<string> {
  await scratch.handle.db.insert(user).values({
    id,
    name: `Test User ${id}`,
    email: `${id}@example.test`,
  });
  return id;
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

/**
 * A real `media_objects` row (no bytes written — this suite never resolves a
 * storage driver, only the `documents.media_object_id` FK).
 */
export async function seedMediaObject(
  scratch: ScratchDb,
  filename = "receipt.jpg",
): Promise<string> {
  const backendRows = await scratch.handle.db
    .insert(storageBackends)
    .values({ name: "local-test", driver: "local", config: { root: "/tmp/loxep-documents-test" } })
    .returning({ id: storageBackends.id });
  const backendId = backendRows[0]?.id;
  if (backendId === undefined) throw new Error("storage backend insert returned no row");

  const mediaRows = await scratch.handle.db
    .insert(mediaObjects)
    .values({
      storageBackendId: backendId,
      storageKey: `media/${randomBytes(8).toString("hex")}.jpg`,
      originalFilename: filename,
      mimeType: "image/jpeg",
      sizeBytes: 2048,
      sha256: randomBytes(32).toString("hex"),
    })
    .returning({ id: mediaObjects.id });
  const mediaObjectId = mediaRows[0]?.id;
  if (mediaObjectId === undefined) throw new Error("media object insert returned no row");
  return mediaObjectId;
}

/** Every `audit_events` row for one action, newest first. */
export async function auditEventsFor(
  scratch: ScratchDb,
  action: string,
): Promise<{ resourceId: string | null; before: unknown; after: unknown; metadata: unknown }[]> {
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

/** Row counts across the three tables a parse result must never reach — the never-auto-commit proof's raw check. */
export async function domainFactCounts(
  scratch: ScratchDb,
): Promise<{ expenses: number; acquisitions: number; inventoryItems: number }> {
  const [expenses, acquisitions, inventoryItems] = await Promise.all([
    scratch.handle.pool.query<{ count: string }>(`select count(*)::text as count from expenses`),
    scratch.handle.pool.query<{ count: string }>(`select count(*)::text as count from acquisitions`),
    scratch.handle.pool.query<{ count: string }>(
      `select count(*)::text as count from inventory_items`,
    ),
  ]);
  return {
    expenses: Number(expenses.rows[0]?.count ?? "0"),
    acquisitions: Number(acquisitions.rows[0]?.count ?? "0"),
    inventoryItems: Number(inventoryItems.rows[0]?.count ?? "0"),
  };
}
