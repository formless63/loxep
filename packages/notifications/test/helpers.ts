/**
 * Test helpers: scratch-database lifecycle against the dev database
 * (docker/compose.dev.yml, host port 5433), following the packages/db
 * harness pattern. Each test file creates its own scratch database so files
 * can run in parallel and never depend on leftover state.
 *
 * `pg` is not a direct dependency of this package, so maintenance queries go
 * through @loxep/db's pooled handle.
 */
import { randomBytes } from "node:crypto";
import { closeDb, createDb } from "@loxep/db";
import type { LoxepDb } from "@loxep/db";
import { marketEvents, marketplaceItems, monitorTargets } from "@loxep/db/schema";
import { createSecretsService } from "@loxep/domain";
import type { SecretsService } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";

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

/** Silent logger so migration chatter does not pollute test output. */
export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Silent structural JobsLogger for worker runtimes under test. */
export const silentJobsLogger: JobsLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentJobsLogger,
};

/**
 * Deterministic structural keyring (ADR-0019 shape: activeVersion + key
 * bytes); this package does not depend on @loxep/config, so it constructs
 * the structure directly — 32 bytes of 0x01 for version 1.
 */
export function testSecretsService(db: LoxepDb): SecretsService {
  return createSecretsService({
    db,
    keyring: {
      activeVersion: 1,
      keys: new Map([[1, new Uint8Array(32).fill(1)]]),
    },
  });
}

/** Inserts a minimal monitor target row (FK anchor for rules/events). */
export async function insertMonitorTarget(
  db: LoxepDb,
  name: string,
): Promise<string> {
  const rows = await db
    .insert(monitorTargets)
    .values({ targetType: "ebay_watchlist", name, intervalSeconds: 300 })
    .returning({ id: monitorTargets.id });
  return rows[0]!.id;
}

/** Inserts a marketplace item + derived market event; returns the event row. */
export async function insertMarketEvent(
  db: LoxepDb,
  options: {
    externalItemId: string;
    eventType?: string;
    monitorTargetId?: string | null;
  },
) {
  const now = new Date();
  const items = await db
    .insert(marketplaceItems)
    .values({
      provider: "ebay",
      marketplace: "EBAY_US",
      externalItemId: options.externalItemId,
      firstSeenAt: now,
      lastSeenAt: now,
      currentState: "active",
    })
    .returning({ id: marketplaceItems.id });
  const itemId = items[0]!.id;
  const eventType = options.eventType ?? "price_dropped";
  const events = await db
    .insert(marketEvents)
    .values({
      marketplaceItemId: itemId,
      monitorTargetId: options.monitorTargetId ?? null,
      eventType,
      detectedAt: now,
      fromObservedAt: new Date(now.getTime() - 60_000),
      toObservedAt: now,
      payload: { from: "20.00", to: "15.00", currency: "USD" },
      deduplicationKey: `${itemId}:${eventType}:${now.toISOString()}`,
    })
    .returning();
  return events[0]!;
}

/** Poll until `condition` returns a truthy value or `timeoutMs` elapses. */
export async function waitFor<T>(
  condition: () => Promise<T | undefined | false>,
  { timeoutMs = 10_000, intervalMs = 50, label = "condition" } = {},
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
