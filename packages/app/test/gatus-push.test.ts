/**
 * `infrastructure.gatus-push` (Phase 8 milestone 2, loxep-ovj.2): the push
 * shape/URL/auth-header, its five-kind outcome, and the task/cron wiring —
 * against a real scratch database (settings/secrets both need one) with an
 * injected fetch so no real network I/O ever happens.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createHealthService, gatusPushSetting } from "@loxep/domain";
import { jobKeyFor } from "@loxep/jobs";
import type { TaskContext } from "@loxep/jobs";
import {
  GATUS_PUSH_SECRET_KEY,
  GATUS_PUSH_TASK_NAME,
  buildAppServices,
  createGatusPushTasks,
  pushGatusHealth,
  pushGatusHealthFacts,
  worstHealthStatus,
} from "../src/index.ts";
import type { AppServices } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
} from "./helpers.ts";

function noopHelpers(): TaskContext["helpers"] {
  return { addJob: async () => ({}) as never } as unknown as TaskContext["helpers"];
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function fakeFetch(
  responder: (request: CapturedRequest) => {
    ok: boolean;
    status: number;
    body?: string;
  },
): {
  fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      const request = { url, method: init.method, headers: init.headers };
      requests.push(request);
      const result = responder(request);
      return {
        ok: result.ok,
        status: result.status,
        text: async () => result.body ?? "",
      };
    },
  };
}

describe("worstHealthStatus", () => {
  it("is 'ok' with no rows and otherwise the worst of failing/degraded/unknown/ok", () => {
    expect(worstHealthStatus([])).toBe("ok");
    expect(worstHealthStatus([{ status: "ok" }, { status: "unknown" }])).toBe(
      "unknown",
    );
    expect(
      worstHealthStatus([
        { status: "ok" },
        { status: "degraded" },
        { status: "unknown" },
      ]),
    ).toBe("degraded");
    expect(
      worstHealthStatus([
        { status: "ok" },
        { status: "failing" },
        { status: "degraded" },
      ]),
    ).toBe("failing");
  });
});

describe("pushGatusHealth", () => {
  const dbName = scratchDbName("loxep_test_app_gatus_push");
  let databaseUrl = "";
  let handle: DbHandle;
  let services: AppServices;

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    services = buildAppServices({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });
  }, 120_000);

  afterAll(async () => {
    await services?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("reports 'disabled' when the setting has never been configured", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
    const outcome = await pushGatusHealth({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      fetchImpl,
    });
    expect(outcome).toEqual({ kind: "disabled" });
    expect(requests).toHaveLength(0);
  });

  it("reports 'unconfigured' when enabled but the base URL/key are unset", async () => {
    await services.settings.set(
      gatusPushSetting,
      { enabled: true, baseUrl: null, endpointKey: null, mode: "single" },
      {},
    );
    const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
    const outcome = await pushGatusHealth({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      fetchImpl,
    });
    expect(outcome.kind).toBe("unconfigured");
    expect(requests).toHaveLength(0);
  });

  it("reports 'unconfigured' when the base URL/key are set but no token is stored", async () => {
    await services.settings.set(
      gatusPushSetting,
      {
        enabled: true,
        baseUrl: "https://gatus.example.test",
        endpointKey: "core_loxep",
        mode: "single",
      },
      {},
    );
    const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
    const outcome = await pushGatusHealth({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      fetchImpl,
    });
    expect(outcome.kind).toBe("unconfigured");
    expect(requests).toHaveLength(0);
  });

  it(
    "POSTs the exact Gatus external-endpoint shape with the bearer token, " +
      "reporting success when nothing is failing",
    async () => {
      await services.secrets.setSecret({
        secretKey: GATUS_PUSH_SECRET_KEY,
        purpose: "token",
        payload: { token: "gatus-push-secret-token" },
      });

      const health = createHealthService({ db: services.db });
      await health.upsertHealth({
        subjectType: "storage_backend",
        subjectId: "11111111-1111-1111-1111-111111111111",
        status: "ok",
        source: "probe",
      });

      const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
      const outcome = await pushGatusHealth({
        db: services.db,
        settings: services.settings,
        secrets: services.secrets,
        fetchImpl,
      });

      expect(outcome.kind).toBe("ok");
      expect(outcome.reported?.success).toBe(true);
      expect(outcome.reported?.error).toBe("");
      expect(outcome.reported?.durationNs).toBeGreaterThanOrEqual(0);

      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.headers["Authorization"]).toBe(
        "Bearer gatus-push-secret-token",
      );
      const url = new URL(request.url);
      expect(url.origin).toBe("https://gatus.example.test");
      expect(url.pathname).toBe("/api/v1/endpoints/core_loxep/external");
      expect(url.searchParams.get("success")).toBe("true");
      expect(url.searchParams.get("error")).toBe("");
      expect(url.searchParams.get("duration")).toMatch(/^\d+$/);
    },
  );

  it("reports success:false with a count when a subject is failing", async () => {
    const health = createHealthService({ db: services.db });
    await health.upsertHealth({
      subjectType: "storage_backend",
      subjectId: "22222222-2222-2222-2222-222222222222",
      status: "failing",
      source: "probe",
      detail: { kind: "fs_error" },
    });

    const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
    const outcome = await pushGatusHealth({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      fetchImpl,
    });

    expect(outcome.kind).toBe("ok");
    expect(outcome.reported?.success).toBe(false);
    expect(outcome.reported?.error).toMatch(/subject\(s\) failing/);
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get("success")).toBe("false");
    // Never a provider-shaped detail leaking into the query string.
    expect(url.searchParams.get("error")).not.toMatch(/fs_error/);
  });

  it("reports 'network_error' and never throws when the POST itself fails", async () => {
    const outcome = await pushGatusHealth({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND gatus.example.test");
      },
    });
    expect(outcome.kind).toBe("network_error");
    expect(outcome.message).toMatch(/ENOTFOUND/);
  });

  it("reports 'http_error' and never throws on a non-2xx Gatus response", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      ok: false,
      status: 401,
      body: "unauthorized",
    }));
    const outcome = await pushGatusHealth({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      fetchImpl,
    });
    expect(outcome.kind).toBe("http_error");
    expect(outcome.statusCode).toBe(401);
    expect(outcome.message).toBe("unauthorized");
  });

  it("normalizes a trailing slash on the configured base URL", async () => {
    await services.settings.set(
      gatusPushSetting,
      {
        enabled: true,
        baseUrl: "https://gatus.example.test/",
        endpointKey: "core_loxep",
        mode: "single",
      },
      {},
    );
    const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
    await pushGatusHealth({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      fetchImpl,
    });
    expect(requests[0]?.url.startsWith("https://gatus.example.test/api/v1/")).toBe(
      true,
    );
    expect(requests[0]?.url).not.toContain("//api");
  });
});

// =============================================================================
// pushGatusHealthFacts (loxep-4ah, owner ruling 6b) — the OQ9 five-fact
// expansion. `pushGatusHealth`'s own suite above is UNCHANGED by any of this,
// proving `mode: 'single'` (the shipped default) keeps today's behavior.
// =============================================================================

describe("pushGatusHealthFacts", () => {
  const dbName = scratchDbName("loxep_test_app_gatus_push_facts");
  let databaseUrl = "";
  let handle: DbHandle;
  let services: AppServices;
  let testUserId = "gatus-push-facts-test-user";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    services = buildAppServices({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });
    const { user } = await import("@loxep/db/schema");
    await services.db.insert(user).values({
      id: testUserId,
      name: "Gatus Push Facts Test User",
      email: "gatus-push-facts@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    await services?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("fans out 'disabled' to all five fact slugs, in GATUS_PUSH_FACT_SLUGS order, no requests made", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
    const outcomes = await pushGatusHealthFacts({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      connections: services.connections,
      fetchImpl,
    });
    expect(outcomes.map((o) => o.slug)).toEqual([
      "worker-backlog",
      "sync-freshness",
      "notifications",
      "drift",
      "readiness",
    ]);
    expect(outcomes.every((o) => o.kind === "disabled")).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("fans out 'unconfigured' to all five when enabled but the base URL/key are unset", async () => {
    await services.settings.set(
      gatusPushSetting,
      { enabled: true, baseUrl: null, endpointKey: null, mode: "facts" },
      {},
    );
    const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
    const outcomes = await pushGatusHealthFacts({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      connections: services.connections,
      fetchImpl,
    });
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o.kind === "unconfigured")).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it(
    "POSTs one push per computable fact to its own derived key, skipping a fact whose " +
      "computation throws (no graphile_worker schema in a fresh scratch database)",
    async () => {
      await services.settings.set(
        gatusPushSetting,
        {
          enabled: true,
          baseUrl: "https://gatus.example.test",
          endpointKey: "core_loxep",
          mode: "facts",
        },
        {},
      );
      await services.secrets.setSecret({
        secretKey: GATUS_PUSH_SECRET_KEY,
        purpose: "token",
        payload: { token: "facts-push-secret-token" },
      });

      const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
      const outcomes = await pushGatusHealthFacts({
        db: services.db,
        settings: services.settings,
        secrets: services.secrets,
        connections: services.connections,
        fetchImpl,
      });

      // worker-backlog's computation throws (no graphile_worker schema has
      // been created in this scratch database — nothing ever started a
      // worker runtime here) — SKIPPED, never a fabricated failure.
      const slugs = outcomes.map((o) => o.slug);
      expect(slugs).not.toContain("worker-backlog");
      expect(slugs).toEqual(["sync-freshness", "notifications", "drift", "readiness"]);
      expect(outcomes.every((o) => o.kind === "ok")).toBe(true);
      // Nothing in this fresh database is failing/drifting, so every
      // computable fact reports success.
      expect(outcomes.every((o) => o.reported?.success === true)).toBe(true);

      expect(requests).toHaveLength(4);
      const requestedKeys = requests
        .map((request) => new URL(request.url).pathname)
        .sort();
      expect(requestedKeys).toEqual(
        [
          "/api/v1/endpoints/core_loxep-drift/external",
          "/api/v1/endpoints/core_loxep-notifications/external",
          "/api/v1/endpoints/core_loxep-readiness/external",
          "/api/v1/endpoints/core_loxep-sync-freshness/external",
        ].sort(),
      );
      // The single-key mode's own key is never pushed to in 'facts' mode.
      expect(requests.some((request) => request.url.includes("/endpoints/core_loxep/"))).toBe(
        false,
      );
      for (const request of requests) {
        expect(request.headers["Authorization"]).toBe("Bearer facts-push-secret-token");
      }
    },
  );

  it("sync-freshness reports failure and a count when an order-sync connection is failing", async () => {
    const connection = await services.connections.createConnection({
      provider: "ebay",
      kind: "marketplace",
      name: "ebay sync-freshness fixture",
      createdByUserId: testUserId,
    });
    const health = createHealthService({ db: services.db });
    await health.upsertHealth({
      subjectType: "connection",
      subjectId: connection.id,
      status: "failing",
      source: "probe",
      detail: { kind: "auth" },
    });

    const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
    const outcomes = await pushGatusHealthFacts({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      connections: services.connections,
      fetchImpl,
    });
    const syncFreshness = outcomes.find((o) => o.slug === "sync-freshness");
    expect(syncFreshness?.reported?.success).toBe(false);
    expect(syncFreshness?.reported?.error).toMatch(/order-sync connection\(s\) failing/);
    const request = requests.find((r) => r.url.includes("sync-freshness"));
    expect(request).toBeDefined();
    const url = new URL(request!.url);
    expect(url.searchParams.get("success")).toBe("false");
  });

  it("drift reports failure and a count from a connection's persisted driftingTargetCount", async () => {
    const connection = await services.connections.createConnection({
      provider: "dockhand",
      kind: "fleet_observability",
      name: "dockhand drift fixture",
      createdByUserId: testUserId,
    });
    const health = createHealthService({ db: services.db });
    await health.upsertHealth({
      subjectType: "connection",
      subjectId: connection.id,
      status: "ok",
      source: "adapter",
      // The exact shape probeDockhandConnection (fleet-health.ts) writes.
      detail: { authMode: "session", hostCount: 3, driftingTargetCount: 2, unmatchedObservedCount: 0 },
    });

    const { fetchImpl, requests } = fakeFetch(() => ({ ok: true, status: 200 }));
    const outcomes = await pushGatusHealthFacts({
      db: services.db,
      settings: services.settings,
      secrets: services.secrets,
      connections: services.connections,
      fetchImpl,
    });
    const drift = outcomes.find((o) => o.slug === "drift");
    expect(drift?.reported?.success).toBe(false);
    expect(drift?.reported?.error).toMatch(/2 drifting target\(s\)/);
    const request = requests.find((r) => r.url.includes("core_loxep-drift"));
    expect(request).toBeDefined();
    expect(new URL(request!.url).searchParams.get("success")).toBe("false");
  });
});

describe("infrastructure.gatus-push task/cron wiring", () => {
  const dbName = scratchDbName("loxep_test_app_gatus_push_task");
  let databaseUrl = "";
  let handle: DbHandle;
  let services: AppServices;

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    services = buildAppServices({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });
  }, 120_000);

  afterAll(async () => {
    await services?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("has the expected task name and a 5-minute cron match", () => {
    const tasks = createGatusPushTasks({ services });
    expect(tasks.gatusPushTask.name).toBe(GATUS_PUSH_TASK_NAME);
    expect(tasks.gatusPushCronItem.match).toBe("*/5 * * * *");
    expect(tasks.gatusPushCronItem.options.jobKey).toBe(
      jobKeyFor(GATUS_PUSH_TASK_NAME, "cron"),
    );
    expect(tasks.gatusPushCronItem.options.jobKeyMode).toBe("replace");
  });

  it("the handler never throws when disabled (the shipped default)", async () => {
    const tasks = createGatusPushTasks({ services });
    await expect(
      tasks.gatusPushTask.handler(
        {},
        { logger: silentJobsLogger, helpers: noopHelpers() },
      ),
    ).resolves.toEqual({ kind: "disabled" });
  });

  it("the handler resolves (never throws) and forwards an injected fetch", async () => {
    await services.settings.set(
      gatusPushSetting,
      {
        enabled: true,
        baseUrl: "https://gatus.example.test",
        endpointKey: "core_loxep",
        mode: "single",
      },
      {},
    );
    await services.secrets.setSecret({
      secretKey: GATUS_PUSH_SECRET_KEY,
      purpose: "token",
      payload: { token: "task-wiring-token" },
    });
    let requestCount = 0;
    const tasks = createGatusPushTasks({
      services,
      fetchImpl: async () => {
        requestCount += 1;
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    const outcome = await tasks.gatusPushTask.handler(
      {},
      { logger: silentJobsLogger, helpers: noopHelpers() },
    );
    expect((outcome as { kind: string }).kind).toBe("ok");
    expect(requestCount).toBe(1);
  });

  it("the handler branches to the five-fact push when mode is 'facts', and never throws", async () => {
    await services.settings.set(
      gatusPushSetting,
      {
        enabled: true,
        baseUrl: "https://gatus.example.test",
        endpointKey: "core_loxep",
        mode: "facts",
      },
      {},
    );
    await services.secrets.setSecret({
      secretKey: GATUS_PUSH_SECRET_KEY,
      purpose: "token",
      payload: { token: "task-wiring-facts-token" },
    });
    let requestCount = 0;
    const tasks = createGatusPushTasks({
      services,
      fetchImpl: async () => {
        requestCount += 1;
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    const outcome = await tasks.gatusPushTask.handler(
      {},
      { logger: silentJobsLogger, helpers: noopHelpers() },
    );
    expect(Array.isArray(outcome)).toBe(true);
    const outcomes = outcome as { slug: string; kind: string }[];
    // worker-backlog is skipped in this scratch database (see the
    // pushGatusHealthFacts suite above) — the other four still push.
    expect(outcomes.length).toBeGreaterThanOrEqual(4);
    expect(outcomes.every((entry) => entry.kind === "ok")).toBe(true);
    expect(requestCount).toBe(outcomes.length);
  });
});
