/**
 * Migration runner integration tests (ADR-0018) against a real
 * PostgreSQL + TimescaleDB (docker/compose.dev.yml).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMigrationState, runMigrations } from "../src/migrate.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

/** 0000 foundation, 0001 observations hypertable, 0002 opportunity rules. */
const MIGRATION_FILE_COUNT = 3;

describe("runMigrations / checkMigrationState", () => {
  const dbName = scratchDbName("loxep_test_migrate");
  let databaseUrl = "";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
  });

  afterAll(async () => {
    await dropScratchDb(dbName);
  });

  it("reports all migrations pending on a fresh database", async () => {
    const state = await checkMigrationState(databaseUrl);
    expect(state.upToDate).toBe(false);
    expect(state.pending).toBe(MIGRATION_FILE_COUNT);
  });

  it("migrates from zero", async () => {
    const result = await runMigrations({ databaseUrl, logger: silentLogger });
    expect(result.applied).toBe(MIGRATION_FILE_COUNT);
  });

  it("reports up to date after migrating", async () => {
    const state = await checkMigrationState(databaseUrl);
    expect(state.upToDate).toBe(true);
    expect(state.pending).toBe(0);
  });

  it("is a no-op on the second run", async () => {
    const result = await runMigrations({ databaseUrl, logger: silentLogger });
    expect(result.applied).toBe(0);
  });
});

describe("concurrent migration invocations", () => {
  const dbName = scratchDbName("loxep_test_concurrent");
  let databaseUrl = "";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
  });

  afterAll(async () => {
    await dropScratchDb(dbName);
  });

  it("advisory lock serializes two concurrent runs on a fresh database", async () => {
    const [first, second] = await Promise.all([
      runMigrations({ databaseUrl, logger: silentLogger }),
      runMigrations({ databaseUrl, logger: silentLogger }),
    ]);
    // Exactly one invocation applies everything; the other waits on the
    // advisory lock and then finds nothing left to do.
    expect(first.applied + second.applied).toBe(MIGRATION_FILE_COUNT);
    expect([first.applied, second.applied]).toContain(0);

    const state = await checkMigrationState(databaseUrl);
    expect(state.upToDate).toBe(true);
  });
});
