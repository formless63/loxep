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
      { enabled: true, baseUrl: null, endpointKey: null },
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
});
