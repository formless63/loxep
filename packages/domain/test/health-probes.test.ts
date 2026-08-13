/**
 * Health sweep tests (loxep-ovj.1): the due-ness formula in isolation, and
 * `runHealthSweep` against a real scratch database with a stub registry so
 * batch bounds, clearing, and failure handling are exercised without any
 * network I/O. A separate `describe` block proves the design's load-bearing
 * rule with real `connections`/`monitor_targets` rows: the sweep NEVER
 * writes to an owning table's own success/error/backoff columns.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import { connections, monitorTargets } from "@loxep/db/schema";
import type { DbHandle } from "@loxep/db";
import {
  createHealthService,
  isHealthCheckDue,
  nextHealthCheckDueAt,
  runHealthSweep,
} from "../src/index.ts";
import type { HealthService, HealthSubjectRegistry } from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentLogger } from "./helpers.ts";

describe("nextHealthCheckDueAt / isHealthCheckDue", () => {
  it("is always due when there is no existing row", () => {
    expect(isHealthCheckDue(null, new Date("2026-01-01T00:00:00Z"))).toBe(true);
  });

  it("is not due before checked_at + the base interval with zero failures", () => {
    const checkedAt = new Date("2026-01-01T00:00:00Z");
    const due = nextHealthCheckDueAt(checkedAt, 0);
    expect(due.getTime()).toBe(checkedAt.getTime() + 300 * 1000);
    expect(isHealthCheckDue({ checkedAt, consecutiveFailures: 0 }, new Date(due.getTime() - 1))).toBe(
      false,
    );
    expect(isHealthCheckDue({ checkedAt, consecutiveFailures: 0 }, due)).toBe(true);
  });

  it("backs off exponentially with the failure streak and caps at one hour", () => {
    const checkedAt = new Date("2026-01-01T00:00:00Z");
    const twoFailures = nextHealthCheckDueAt(checkedAt, 2);
    expect(twoFailures.getTime()).toBe(checkedAt.getTime() + 300 * 4 * 1000);
    const manyFailures = nextHealthCheckDueAt(checkedAt, 50);
    expect(manyFailures.getTime()).toBe(checkedAt.getTime() + 3600 * 1000);
  });
});

describe("runHealthSweep", () => {
  const dbName = scratchDbName("loxep_test_domain_health_sweep");
  let handle: DbHandle;
  let health: HealthService;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    health = createHealthService({ db: handle.db });
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  function stubRegistry(ids: string[], opts?: {
    throwFor?: Set<string>;
    goneFor?: Set<string>;
  }): HealthSubjectRegistry {
    return {
      connection: {
        source: "probe",
        listCandidates: async () => ids.map((subjectId) => ({ subjectId })),
        probe: async (_db, subjectId) => {
          if (opts?.throwFor?.has(subjectId)) throw new Error("boom");
          if (opts?.goneFor?.has(subjectId)) return null;
          return { status: "ok", detail: {} };
        },
      },
    };
  }

  it("probes every due subject and upserts one row each (source='probe')", async () => {
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const result = await runHealthSweep({
      db: handle.db,
      health,
      registry: stubRegistry(ids),
      now: new Date("2026-02-01T00:00:00Z"),
    });
    expect(result.scanned).toBe(2);
    expect(result.due).toBe(2);
    expect(result.probed).toBe(2);
    expect(result.more).toBe(false);
    for (const subjectId of ids) {
      const row = await health.getHealth("connection", subjectId);
      expect(row?.status).toBe("ok");
      expect(row?.source).toBe("probe");
    }
  });

  it("skips a subject that is not yet due", async () => {
    const id = "00000000-0000-4000-8000-000000000003";
    const first = await runHealthSweep({
      db: handle.db,
      health,
      registry: stubRegistry([id]),
      now: new Date("2026-02-01T00:00:00Z"),
    });
    expect(first.probed).toBe(1);

    const second = await runHealthSweep({
      db: handle.db,
      health,
      registry: stubRegistry([id]),
      // Well inside the 300s base interval.
      now: new Date("2026-02-01T00:01:00Z"),
    });
    expect(second.scanned).toBe(1);
    expect(second.due).toBe(0);
    expect(second.probed).toBe(0);
  });

  it("bounds work per run and reports more when the cap is hit", async () => {
    const ids = Array.from(
      { length: 5 },
      (_unused, index) => `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    );
    const result = await runHealthSweep({
      db: handle.db,
      health,
      registry: stubRegistry(ids),
      now: new Date("2026-03-01T00:00:00Z"),
      maxSubjectsPerType: 2,
    });
    expect(result.due).toBe(5);
    expect(result.probed).toBe(2);
    expect(result.more).toBe(true);
    expect(result.batches["connection"]).toBe(2);
  });

  it("clears the health row for a subject the probe reports gone", async () => {
    const id = "00000000-0000-4000-8000-000000000020";
    await health.upsertHealth({
      subjectType: "connection",
      subjectId: id,
      status: "ok",
      source: "probe",
      checkedAt: new Date("2026-04-01T00:00:00Z"),
    });
    const result = await runHealthSweep({
      db: handle.db,
      health,
      registry: stubRegistry([id], { goneFor: new Set([id]) }),
      now: new Date("2026-04-02T00:00:00Z"),
    });
    expect(result.cleared).toBe(1);
    expect(result.probed).toBe(0);
    expect(await health.getHealth("connection", id)).toBeNull();
  });

  it("counts a throwing probe as failed and writes nothing for it", async () => {
    const id = "00000000-0000-4000-8000-000000000030";
    const result = await runHealthSweep({
      db: handle.db,
      health,
      registry: stubRegistry([id], { throwFor: new Set([id]) }),
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(result.failed).toBe(1);
    expect(result.probed).toBe(0);
    expect(await health.getHealth("connection", id)).toBeNull();
  });

  it("writes the registry entry's own source when an outcome carries none (default registry path)", async () => {
    const id = "00000000-0000-4000-8000-000000000040";
    const registry: HealthSubjectRegistry = {
      connection: {
        source: "probe",
        listCandidates: async () => [{ subjectId: id }],
        // No `source` on the outcome — every entry in
        // createDefaultHealthSubjectRegistry() is shaped exactly like this.
        probe: async () => ({ status: "ok", detail: {} }),
      },
    };
    await runHealthSweep({
      db: handle.db,
      health,
      registry,
      now: new Date("2026-05-02T00:00:00Z"),
    });
    const row = await health.getHealth("connection", id);
    expect(row?.source).toBe("probe");
  });

  it("lets one outcome override the registry entry's source (a mixed per-row `connection` dispatcher)", async () => {
    // The shape loxep-rf4/loxep-hb7's @loxep/app composition uses: one
    // `connection` entry whose `source` default is 'probe' (the derived
    // last_success_at read most rows get), but a fleet-tool row's outcome
    // reports 'adapter' because that probe read the provider's own API.
    const probedRow = "00000000-0000-4000-8000-000000000041";
    const adapterRow = "00000000-0000-4000-8000-000000000042";
    const registry: HealthSubjectRegistry = {
      connection: {
        source: "probe",
        listCandidates: async () => [
          { subjectId: probedRow },
          { subjectId: adapterRow },
        ],
        probe: async (_db, subjectId) => {
          if (subjectId === adapterRow) {
            return { status: "ok", detail: {}, source: "adapter" };
          }
          return { status: "ok", detail: {} };
        },
      },
    };
    await runHealthSweep({
      db: handle.db,
      health,
      registry,
      now: new Date("2026-05-03T00:00:00Z"),
    });
    expect((await health.getHealth("connection", probedRow))?.source).toBe(
      "probe",
    );
    expect((await health.getHealth("connection", adapterRow))?.source).toBe(
      "adapter",
    );
  });
});

describe("runHealthSweep never drives retry/backoff on the owning tables", () => {
  const dbName = scratchDbName("loxep_test_domain_health_sweep_isolation");
  let handle: DbHandle;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("reads connections.last_success_at/last_error_at but never writes them", async () => {
    const errorAt = new Date("2026-01-01T00:00:00Z");
    const [connection] = await handle.db
      .insert(connections)
      .values({
        provider: "woocommerce",
        kind: "store",
        name: "Health sweep isolation fixture",
        status: "error",
        lastErrorAt: errorAt,
        lastErrorCode: "http_500",
      })
      .returning();
    if (connection === undefined) throw new Error("fixture insert failed");

    const health = createHealthService({ db: handle.db });
    const result = await runHealthSweep({
      db: handle.db,
      health,
      now: new Date("2026-01-01T00:10:00Z"),
    });
    expect(result.probed).toBeGreaterThanOrEqual(1);

    const healthRow = await health.getHealth("connection", connection.id);
    expect(healthRow?.status).toBe("failing");

    const reloaded = await handle.db.query.connections.findFirst({
      where: (table, { eq }) => eq(table.id, connection.id),
    });
    // The owning row is byte-for-byte unchanged — the sweep is a reader here.
    expect(reloaded?.status).toBe("error");
    expect(reloaded?.lastErrorAt?.toISOString()).toBe(errorAt.toISOString());
    expect(reloaded?.lastErrorCode).toBe("http_500");
    expect(reloaded?.lastSuccessAt).toBeNull();
    expect(reloaded?.updatedAt.getTime()).toBe(connection.updatedAt.getTime());
  });

  it("never touches monitor_targets — not a health subject in this milestone", async () => {
    const backoffUntil = new Date("2026-06-01T00:00:00Z");
    const [target] = await handle.db
      .insert(monitorTargets)
      .values({
        targetType: "ebay_item",
        name: "Health sweep isolation fixture target",
        intervalSeconds: 300,
        backoffUntil,
        consecutiveErrors: 4,
      })
      .returning();
    if (target === undefined) throw new Error("fixture insert failed");

    const health = createHealthService({ db: handle.db });
    await runHealthSweep({ db: handle.db, health, now: new Date("2026-06-01T00:05:00Z") });

    const reloaded = await handle.db.query.monitorTargets.findFirst({
      where: (table, { eq }) => eq(table.id, target.id),
    });
    expect(reloaded?.backoffUntil?.toISOString()).toBe(backoffUntil.toISOString());
    expect(reloaded?.consecutiveErrors).toBe(4);
    // No row was ever created for it — monitor_targets is not in the registry.
    expect(await health.getHealth("connection", target.id)).toBeNull();
  });
});
