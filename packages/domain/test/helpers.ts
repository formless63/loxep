/**
 * Test helpers: scratch-database lifecycle against the dev database
 * (docker/compose.dev.yml, host port 5433), following the packages/db
 * harness pattern. Each test file creates its own scratch database so files
 * can run in parallel and never depend on leftover state.
 *
 * Maintenance queries go through @loxep/db's pooled handle so this package
 * needs no direct `pg` dependency.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { closeDb, createDb } from "@loxep/db";
import { parseKeyring } from "@loxep/config";
import type { Keyring } from "@loxep/config";
import { user } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:loxep-dev@localhost:5433/loxep_test";

export const baseDatabaseUrl =
  process.env.LOXEP_TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

/** URL pointing at the server's maintenance database. */
function maintenanceUrl(): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

/** URL for a named database on the same server. */
export function databaseUrlFor(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function scratchDbName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export async function createScratchDb(databaseName: string): Promise<string> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(`create database "${databaseName}"`);
  } finally {
    await closeDb(handle);
  }
  return databaseUrlFor(databaseName);
}

export async function dropScratchDb(databaseName: string): Promise<void> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(
      `drop database if exists "${databaseName}" with (force)`,
    );
  } finally {
    await closeDb(handle);
  }
}

/** Silent logger so migration chatter does not pollute test output. */
export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Deterministic test keyring: key bytes for version N are 32 copies of N.
 * Built through `parseKeyring` so tests exercise the real ADR-0019 document
 * format.
 */
export function testKeyring(
  activeVersion = 1,
  versions: number[] = [1],
): Keyring {
  const keys: Record<string, string> = {};
  for (const version of versions) {
    keys[String(version)] = Buffer.alloc(32, version).toString("base64");
  }
  return parseKeyring(
    JSON.stringify({ active_version: activeVersion, keys }),
  );
}

/** Inserts a Better Auth user row usable as an FK-valid actor. */
export async function insertTestUser(
  db: LoxepDb,
  id: string,
): Promise<string> {
  await db.insert(user).values({
    id,
    name: `Test User ${id}`,
    email: `${id}@example.test`,
  });
  return id;
}
