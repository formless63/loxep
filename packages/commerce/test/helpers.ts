/**
 * Scratch-database lifecycle and seed helpers for the @loxep/commerce suite.
 *
 * Real PostgreSQL/TimescaleDB (docker/compose.dev.yml, host port 5433), never
 * a SQLite substitute. Each test file provisions its own scratch database so
 * files run in parallel and never depend on leftover state.
 *
 * `pg` is not a direct dependency of this package, so maintenance queries go
 * through @loxep/db's pooled handle — the same pattern @loxep/market uses.
 */
import { randomBytes } from "node:crypto";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { connections, economicEntities } from "@loxep/db/schema";

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

/** Insert an economic entity and return its id. */
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

/** Insert a provider connection and return its id. */
export async function seedConnection(
  scratch: ScratchDb,
  input: {
    name: string;
    provider?: string;
    kind?: string;
    status?: string;
    economicEntityId?: string | null;
  },
): Promise<string> {
  const rows = await scratch.handle.db
    .insert(connections)
    .values({
      provider: input.provider ?? "woocommerce",
      kind: input.kind ?? "store",
      name: input.name,
      status: input.status ?? "active",
      economicEntityId: input.economicEntityId ?? null,
    })
    .returning({ id: connections.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("connection insert returned no row");
  return id;
}
