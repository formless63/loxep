/**
 * Delivery pipeline integration tests (loxep-ubx.4): the explicit
 * detection→delivery bridge, happy-path delivery through the REAL Graphile
 * Worker runtime, transport-failure retry accounting, and idempotent re-run
 * of a delivered row. Transports use a captured fetch — no real network.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createTaskRegistry, startWorkerRuntime } from "@loxep/jobs";
import type { AddJob, TaskContext, WorkerRuntime } from "@loxep/jobs";
import {
  DELIVER_TASK_NAME,
  createDeliveryPipeline,
  createNotificationService,
  createNtfyTransport,
  renderMarketEventMessage,
} from "../src/index.ts";
import type {
  DeliveryPipeline,
  FetchLike,
  NotificationService,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  insertMarketEvent,
  insertMonitorTarget,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testSecretsService,
  waitFor,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_deliver");
let databaseUrl = "";
let handle: DbHandle;
let service: NotificationService;
let pipeline: DeliveryPipeline;
let runtime: WorkerRuntime;

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}
const fetchCalls: CapturedRequest[] = [];
/** >0 → that many upcoming transport attempts fail with HTTP 500. */
let failNext = 0;

const capturedFetch: FetchLike = async (url, init) => {
  if (failNext > 0) {
    failNext -= 1;
    return { ok: false, status: 500, text: async () => "boom" };
  }
  fetchCalls.push({ url, headers: init.headers, body: init.body });
  return {
    ok: true,
    status: 200,
    text: async () => `{"id":"ntfy-${fetchCalls.length}"}`,
  };
};

/** Direct handler invocation context (DB-backed logic; helpers unused). */
const directContext = {
  logger: silentJobsLogger,
  helpers: {},
} as unknown as TaskContext;

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const secrets = testSecretsService(handle.db);
  service = createNotificationService({ db: handle.db, secrets });
  pipeline = createDeliveryPipeline({
    db: handle.db,
    secrets,
    transport: createNtfyTransport(capturedFetch),
  });
  runtime = await startWorkerRuntime({
    databaseUrl,
    logger: silentJobsLogger,
    concurrency: 2,
    pollInterval: 200,
    registry: createTaskRegistry([pipeline.deliverTask]),
    cronItems: [],
  });
});

afterAll(async () => {
  await runtime.stop();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

async function deliveryRow(marketEventId: string, endpointId: string) {
  return handle.db.query.notificationDeliveries.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.marketEventId, marketEventId),
        eq(table.endpointId, endpointId),
      ),
  });
}

describe("enqueueDeliveriesForEvent (the explicit bridge)", () => {
  it("enqueues one deliver job per matched endpoint, deduplicating rules", async () => {
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "bridge endpoint",
      config: { baseUrl: "https://ntfy.example.test", topic: "bridge" },
    });
    // Two rules to the SAME endpoint must yield one delivery job.
    await service.createRule({ name: "any", endpointId: endpoint.id });
    await service.createRule({
      name: "drops",
      endpointId: endpoint.id,
      marketEventType: "price_dropped",
    });
    const event = await insertMarketEvent(handle.db, {
      externalItemId: "bridge-item",
    });

    const enqueued: Array<{ payload: unknown; jobKey: string | undefined }> =
      [];
    const captureAddJob = (async (
      _task: unknown,
      payload: unknown,
      opts?: { jobKey?: string },
    ) => {
      enqueued.push({ payload, jobKey: opts?.jobKey });
      return {} as never;
    }) as AddJob;

    const result = await pipeline.enqueueDeliveriesForEvent(captureAddJob, {
      id: event.id,
      eventType: event.eventType,
      monitorTargetId: event.monitorTargetId,
    });
    expect(result.endpointIds).toEqual([endpoint.id]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload).toEqual({
      marketEventId: event.id,
      endpointId: endpoint.id,
    });
    // Documented jobKey convention: taskName:<market_event_id>:<endpoint_id>.
    expect(enqueued[0]!.jobKey).toBe(
      `${DELIVER_TASK_NAME}:${event.id}:${endpoint.id}`,
    );
  });

  it("enqueues nothing when no rule matches", async () => {
    const event = await insertMarketEvent(handle.db, {
      externalItemId: "no-rule-item",
      eventType: "listing_ended",
      monitorTargetId: await insertMonitorTarget(handle.db, "unruly monitor"),
    });
    // Only monitor-agnostic + wildcard rules exist from the previous test;
    // they DO match; so disable them first to isolate.
    for (const rule of await service.listRules()) {
      await service.updateRule(rule.id, { enabled: false });
    }
    const calls: unknown[] = [];
    const captureAddJob = (async () => {
      calls.push(1);
      return {} as never;
    }) as AddJob;
    const result = await pipeline.enqueueDeliveriesForEvent(captureAddJob, {
      id: event.id,
      eventType: event.eventType,
      monitorTargetId: event.monitorTargetId,
    });
    expect(result.endpointIds).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("delivery through the real worker runtime", () => {
  it("delivers happy-path: pending row → transport → delivered with provider id", async () => {
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "runtime endpoint",
      config: { baseUrl: "https://ntfy.example.test", topic: "runtime" },
      token: "tk_runtime_token",
    });
    await service.createRule({ name: "runtime rule", endpointId: endpoint.id });
    const event = await insertMarketEvent(handle.db, {
      externalItemId: "runtime-item",
    });

    fetchCalls.length = 0;
    await pipeline.enqueueDeliveriesForEvent(runtime.addJob, {
      id: event.id,
      eventType: event.eventType,
      monitorTargetId: event.monitorTargetId,
    });

    const row = await waitFor(
      async () => {
        const delivery = await deliveryRow(event.id, endpoint.id);
        return delivery?.deliveredAt != null ? delivery : undefined;
      },
      { label: "delivered row" },
    );
    expect(row.status).toBe("delivered");
    expect(row.attemptCount).toBe(1);
    expect(row.providerMessageId).toMatch(/^ntfy-/);
    expect(row.lastError).toBeNull();
    expect(row.lastAttemptAt).not.toBeNull();

    // The transport saw the endpoint config + decrypted token + rendered
    // message exactly once.
    expect(fetchCalls).toHaveLength(1);
    const request = fetchCalls[0]!;
    expect(request.url).toBe("https://ntfy.example.test/runtime");
    expect(request.headers["Authorization"]).toBe("Bearer tk_runtime_token");
    expect(request.body).toBe(renderMarketEventMessage(event).body);

    // Idempotent re-run of the delivered row: enqueue the same delivery
    // again; once the queue drains, no second transport call happened.
    await pipeline.enqueueDeliveriesForEvent(runtime.addJob, {
      id: event.id,
      eventType: event.eventType,
      monitorTargetId: event.monitorTargetId,
    });
    await waitFor(
      async () => {
        const stats = await runtime.getStats();
        return stats.pending === 0 && stats.running === 0 ? true : undefined;
      },
      { label: "queue drained after re-enqueue" },
    );
    const after = await deliveryRow(event.id, endpoint.id);
    expect(after?.attemptCount).toBe(1);
    expect(after?.deliveredAt?.getTime()).toBe(row.deliveredAt?.getTime());
    expect(fetchCalls).toHaveLength(1);
  });
});

describe("delivery retry accounting (direct handler invocation)", () => {
  it("counts failed attempts, keeps last_error, then delivers on a later attempt", async () => {
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "flaky endpoint",
      config: { baseUrl: "https://ntfy.example.test", topic: "flaky" },
    });
    const event = await insertMarketEvent(handle.db, {
      externalItemId: "flaky-item",
    });
    const payload = { marketEventId: event.id, endpointId: endpoint.id };

    // Two transport failures: each attempt increments attempt_count,
    // records last_error, marks the row failed, and rethrows (so the job
    // system would retry).
    failNext = 2;
    await expect(
      pipeline.deliverTask.handler(payload, directContext),
    ).rejects.toThrow(/HTTP 500/);
    let row = await deliveryRow(event.id, endpoint.id);
    expect(row?.status).toBe("failed");
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastError).toContain("500");

    await expect(
      pipeline.deliverTask.handler(payload, directContext),
    ).rejects.toThrow(/HTTP 500/);
    row = await deliveryRow(event.id, endpoint.id);
    expect(row?.attemptCount).toBe(2);

    // Third attempt succeeds: failed → delivered, error cleared.
    await pipeline.deliverTask.handler(payload, directContext);
    row = await deliveryRow(event.id, endpoint.id);
    expect(row?.status).toBe("delivered");
    expect(row?.attemptCount).toBe(3);
    expect(row?.deliveredAt).not.toBeNull();
    expect(row?.lastError).toBeNull();

    // Re-running the delivered row is a no-op: no attempt, no transport.
    const callsBefore = fetchCalls.length;
    await pipeline.deliverTask.handler(payload, directContext);
    row = await deliveryRow(event.id, endpoint.id);
    expect(row?.attemptCount).toBe(3);
    expect(fetchCalls.length).toBe(callsBefore);
  });

  it("leaves the row pending without an attempt when the endpoint is disabled", async () => {
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "disabled endpoint",
      config: { baseUrl: "https://ntfy.example.test", topic: "disabled" },
      enabled: false,
    });
    const event = await insertMarketEvent(handle.db, {
      externalItemId: "disabled-item",
    });
    await pipeline.deliverTask.handler(
      { marketEventId: event.id, endpointId: endpoint.id },
      directContext,
    );
    const row = await deliveryRow(event.id, endpoint.id);
    expect(row?.status).toBe("pending");
    expect(row?.attemptCount).toBe(0);
    expect(row?.deliveredAt).toBeNull();
  });
});
