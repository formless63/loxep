/**
 * Test helpers: scratch-database lifecycle against the real dev database
 * (docker/compose.dev.yml, host port 5433) following the packages/db
 * pattern, plus S3 test-endpoint configuration for the conformance suite's
 * generic S3 leg (a disposable RustFS container by default — but the tests
 * only ever see endpoint configuration, never the implementation).
 *
 * `pg` and `@loxep/config` are not dependencies of this package (bun
 * isolated installs), so DB access goes through @loxep/db and the test
 * keyring is built structurally.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { closeDb, createDb } from "@loxep/db";
import type { LoxepDb } from "@loxep/db";
import { user } from "@loxep/db/schema";
import type { createSecretsService } from "@loxep/domain";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:loxep-dev@localhost:5433/loxep_test";

export const baseDatabaseUrl =
  process.env["LOXEP_TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;

function maintenanceUrl(): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function databaseUrlFor(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function scratchDbName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

async function withMaintenanceDb(sql: string): Promise<void> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(sql);
  } finally {
    await closeDb(handle);
  }
}

export async function createScratchDb(databaseName: string): Promise<string> {
  await withMaintenanceDb(
    `create database "${databaseName}" template template0`,
  );
  return databaseUrlFor(databaseName);
}

export async function dropScratchDb(databaseName: string): Promise<void> {
  await withMaintenanceDb(
    `drop database if exists "${databaseName}" with (force)`,
  );
}

/** Silent logger so migration/worker chatter stays out of test output. */
export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface SilentJobsLogger {
  debug: (obj: object | string, msg?: string) => void;
  info: (obj: object | string, msg?: string) => void;
  warn: (obj: object | string, msg?: string) => void;
  error: (obj: object | string, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => SilentJobsLogger;
}

/** Structural JobsLogger that drops everything. */
export const silentJobsLogger: SilentJobsLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentJobsLogger,
};

type Keyring = Parameters<typeof createSecretsService>[0]["keyring"];

/**
 * Deterministic structural test keyring (ADR-0019 shape): key bytes for
 * version N are 32 copies of N.
 */
export function testKeyring(
  activeVersion = 1,
  versions: number[] = [1],
): Keyring {
  const keys = new Map<number, Uint8Array>();
  for (const version of versions) {
    keys.set(version, Buffer.alloc(32, version));
  }
  return { activeVersion, keys };
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

/** Poll until `condition` returns a truthy value or `timeoutMs` elapses. */
export async function waitFor<T>(
  condition: () => Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 50, label = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Collect a Readable into a single Buffer. */
export async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Generic S3 test endpoint (implementation-blind by design)
// ---------------------------------------------------------------------------

export interface S3TestConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Endpoint configuration for the S3 conformance leg. Defaults match the
 * disposable test container documented in the repo
 * (`docker run -d --name loxep-test-rustfs -p 9002:9000 ...`), but ANY
 * generic S3-compatible endpoint works — the tests never know which.
 */
export function s3TestConfig(): S3TestConfig {
  return {
    endpoint: process.env["LOXEP_TEST_S3_ENDPOINT"] ?? "http://127.0.0.1:9002",
    region: process.env["LOXEP_TEST_S3_REGION"] ?? "us-east-1",
    accessKeyId: process.env["LOXEP_TEST_S3_ACCESS_KEY"] ?? "rustfsadmin",
    secretAccessKey: process.env["LOXEP_TEST_S3_SECRET_KEY"] ?? "rustfsadmin",
  };
}

/** True when the configured S3 test endpoint answers HTTP at all. */
export async function s3EndpointAvailable(): Promise<boolean> {
  const { endpoint } = s3TestConfig();
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

export function s3UnavailableMessage(): string {
  const { endpoint } = s3TestConfig();
  return (
    `S3 conformance leg SKIPPED: no S3-compatible endpoint at ${endpoint}. ` +
    "Start the disposable test container (or any generic S3 endpoint) with: " +
    "docker run -d --name loxep-test-rustfs -p 9002:9000 " +
    "rustfs/rustfs:1.0.0-rc.4@sha256:a9fbb5e5bfce09ccd0869ac9a7b0e39191c6868d75ec4c5d08ebbd5475db5d6b " +
    "— or point LOXEP_TEST_S3_ENDPOINT/_REGION/_ACCESS_KEY/_SECRET_KEY elsewhere."
  );
}
