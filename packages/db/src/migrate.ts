/**
 * Migration runner and database handles (ADR-0006, ADR-0018).
 *
 * ADR-0018 rules implemented here:
 *   - schema migration is an explicit invocation (`runMigrations`); normal
 *     startup NEVER migrates — it calls `checkMigrationState` and fails
 *     readiness with a diagnostic when the database is behind;
 *   - migration invocations take a PostgreSQL advisory lock so concurrent
 *     invocations cannot interleave: the second waits, then observes an
 *     already-migrated database and applies nothing.
 */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";
import * as schema from "./schema/index.ts";

/**
 * Session-level advisory lock key serializing migration invocations
 * (ADR-0018).
 *
 * Fixed constant: the big-endian int64 reading of the ASCII bytes
 * "LOXEPMIG" (0x4C 0x4F 0x58 0x45 0x50 0x4D 0x49 0x47). The value is part of
 * the operational contract — never change it, or concurrent old/new
 * migrators would stop excluding each other.
 */
export const MIGRATION_LOCK_KEY = "5498710724765894983";

/** Default migrations directory, resolved relative to this source file. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface MigrationLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface RunMigrationsOptions {
  databaseUrl: string;
  logger?: MigrationLogger;
}

const consoleLogger: MigrationLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

async function countAppliedMigrations(client: pg.Client): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count
       from pg_catalog.pg_tables
      where schemaname = $1 and tablename = $2`,
    [MIGRATIONS_SCHEMA, MIGRATIONS_TABLE],
  );
  if (result.rows[0]?.count === "0") {
    return 0;
  }
  const rows = await client.query<{ count: string }>(
    `select count(*)::text as count from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`,
  );
  return Number(rows.rows[0]?.count ?? "0");
}

/**
 * Apply all pending migrations from `packages/db/migrations`.
 *
 * Uses a single session so the advisory lock is held on the same connection
 * that runs the migrator. Resolves with the number of newly applied
 * migration files.
 */
export async function runMigrations(
  opts: RunMigrationsOptions,
): Promise<{ applied: number }> {
  const logger = opts.logger ?? consoleLogger;
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();
  try {
    logger.info(
      `loxep migrate: acquiring advisory lock ${MIGRATION_LOCK_KEY}`,
    );
    await client.query("select pg_advisory_lock($1::bigint)", [
      MIGRATION_LOCK_KEY,
    ]);
    try {
      const before = await countAppliedMigrations(client);
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const after = await countAppliedMigrations(client);
      const applied = after - before;
      if (applied === 0) {
        logger.info(
          "loxep migrate: database already up to date (applied 0 migrations)",
        );
      } else {
        logger.info(
          `loxep migrate: applied ${applied} migration${applied === 1 ? "" : "s"}`,
        );
      }
      return { applied };
    } finally {
      await client.query("select pg_advisory_unlock($1::bigint)", [
        MIGRATION_LOCK_KEY,
      ]);
    }
  } catch (error) {
    logger.error(
      `loxep migrate: failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Report migration state without mutating anything (ADR-0018 startup
 * verification: web/worker/all startup calls this and fails readiness when
 * `upToDate` is false — it never migrates).
 *
 * Pending is computed the same way drizzle's migrator decides what to apply:
 * migration files whose journal timestamp is newer than the newest applied
 * entry in drizzle.__drizzle_migrations.
 */
export async function checkMigrationState(
  databaseUrl: string,
): Promise<{ upToDate: boolean; pending: number }> {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tableExists = await client.query<{ count: string }>(
      `select count(*)::text as count
         from pg_catalog.pg_tables
        where schemaname = $1 and tablename = $2`,
      [MIGRATIONS_SCHEMA, MIGRATIONS_TABLE],
    );
    let lastAppliedMillis = -1;
    if (tableExists.rows[0]?.count !== "0") {
      const last = await client.query<{ created_at: string }>(
        `select created_at from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
          order by created_at desc limit 1`,
      );
      const row = last.rows[0];
      if (row !== undefined) {
        lastAppliedMillis = Number(row.created_at);
      }
    }
    const pending = files.filter(
      (migration) => migration.folderMillis > lastAppliedMillis,
    ).length;
    return { upToDate: pending === 0, pending };
  } finally {
    await client.end();
  }
}

export type LoxepDb = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: LoxepDb;
  pool: pg.Pool;
}

/** Create a pooled Drizzle database handle bound to the full Loxep schema. */
export function createDb(databaseUrl: string): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

/** Dispose a handle created by {@link createDb}. */
export async function closeDb(handle: DbHandle): Promise<void> {
  await handle.pool.end();
}
