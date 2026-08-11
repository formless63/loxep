/**
 * Test helpers: scratch-database lifecycle against the dev database
 * (docker/compose.dev.yml, host port 5433).
 *
 * Each test file creates its own scratch database so files can run in
 * parallel and never depend on leftover state.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";

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
  const client = new pg.Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try {
    await client.query(`create database "${databaseName}"`);
  } finally {
    await client.end();
  }
  return databaseUrlFor(databaseName);
}

export async function dropScratchDb(databaseName: string): Promise<void> {
  const client = new pg.Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try {
    await client.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await client.end();
  }
}

/** Silent logger so migration chatter does not pollute test output. */
export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
