/**
 * Scratch-database lifecycle and seed helpers for the @loxep/work suite.
 *
 * Real PostgreSQL/TimescaleDB (docker/compose.dev.yml, host port 5433), never
 * a SQLite substitute — `numeric(20,6)` exactness, `num_nonnulls`, the
 * partial unique constraints, and the CHECKs this package's correctness rests
 * on have no meaning anywhere else. Each test file provisions its own scratch
 * database so files run in parallel and never depend on leftover state.
 */
import { randomBytes } from "node:crypto";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { counterparties, economicEntities, user } from "@loxep/db/schema";

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
export async function seedUser(scratch: ScratchDb, id: string): Promise<string> {
  await scratch.handle.db.insert(user).values({
    id,
    name: `Test User ${id}`,
    email: `${id}@example.test`,
  });
  return id;
}

export async function seedCounterparty(
  scratch: ScratchDb,
  displayName: string,
  referenceCode?: string,
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(counterparties)
    .values({
      referenceCode: referenceCode ?? `CP-${randomBytes(4).toString("hex")}`,
      kind: "organization",
      displayName,
      normalizedName: displayName.toLowerCase(),
    })
    .returning({ id: counterparties.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("counterparty insert returned no row");
  return id;
}

/** Grants `role` (default `'customer'`) for `counterpartyId` with `economicEntityId`. */
export async function seedCounterpartyRole(
  scratch: ScratchDb,
  input: { counterpartyId: string; economicEntityId: string; role?: string },
): Promise<void> {
  await scratch.handle.pool.query(
    `insert into counterparty_entity_roles (counterparty_id, economic_entity_id, role)
     values ($1, $2, $3)`,
    [input.counterpartyId, input.economicEntityId, input.role ?? "customer"],
  );
}

/** A minimal, valid `inventory_items` row for `project_material_uses`'s `inventory_basis` path. */
export async function seedInventoryItem(
  scratch: ScratchDb,
  input: { landedCostAmount: string; currency?: string; itemCode?: string },
): Promise<string> {
  const itemCode = input.itemCode ?? `ITM-${randomBytes(4).toString("hex")}`;
  const currency = input.currency ?? "USD";
  const result = await scratch.handle.pool.query<{ id: string }>(
    `insert into inventory_items
       (item_code, label, status, condition_code, currency,
        entity_attribution_source, landed_cost_amount, acquisition_cost_amount,
        acquired_at)
     values ($1, $2, 'available', 'good', $3, 'unattributed', $4, $4, now())
     returning id`,
    [itemCode, `Test item ${itemCode}`, currency, input.landedCostAmount],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("inventory_items insert returned no row");
  return id;
}
