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
  marketEventFromNotificationEvent,
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

/**
 * Deliveries are keyed on the NOTIFICATION event (ADR-0023). Market events
 * reach the ledger through the bridge under the key `market_event:<id>`, so
 * tests resolve the market event id to its notification event id.
 */
async function notificationEventIdFor(marketEventId: string): Promise<string> {
  const row = await handle.db.query.notificationEvents.findFirst({
    where: (table, { eq }) =>
      eq(table.deduplicationKey, `market_event:${marketEventId}`),
  });
  if (row === undefined) {
    throw new Error(`no notification event recorded for ${marketEventId}`);
  }
  return row.id;
}

/** Record the market event in the ledger without enqueueing anything. */
async function recordOnly(event: {
  id: string;
  eventType: string;
  monitorTargetId: string | null;
}): Promise<string> {
  const noopAddJob = (async () => ({}) as never) as AddJob;
  const disabled = await handle.db.query.notificationRules.findMany({});
  const previouslyEnabled = disabled.filter((rule) => rule.enabled);
  for (const rule of previouslyEnabled) {
    await service.updateRule(rule.id, { enabled: false });
  }
  await pipeline.enqueueDeliveriesForEvent(noopAddJob, event);
  for (const rule of previouslyEnabled) {
    await service.updateRule(rule.id, { enabled: true });
  }
  return notificationEventIdFor(event.id);
}

async function deliveryRow(notificationEventId: string, endpointId: string) {
  return handle.db.query.notificationDeliveries.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.notificationEventId, notificationEventId),
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
    await service.createRule({
      name: "any",
      endpointId: endpoint.id,
      eventClass: "market",
    });
    await service.createRule({
      name: "drops",
      endpointId: endpoint.id,
      eventClass: "market",
      eventType: "price_dropped",
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
    const notificationEventId = await notificationEventIdFor(event.id);
    expect(enqueued[0]!.payload).toEqual({
      notificationEventId,
      endpointId: endpoint.id,
    });
    // Documented jobKey convention: taskName:<notification_event_id>:<endpoint_id>.
    expect(enqueued[0]!.jobKey).toBe(
      `${DELIVER_TASK_NAME}:${notificationEventId}:${endpoint.id}`,
    );

    // The ledger row carries the class/subject/payload the renderer needs.
    const ledgerRow = await handle.db.query.notificationEvents.findFirst({
      where: (table, { eq }) => eq(table.id, notificationEventId),
    });
    expect(ledgerRow?.eventClass).toBe("market");
    expect(ledgerRow?.subjectType).toBe("market_event");
    expect(ledgerRow?.subjectId).toBe(event.id);
    expect(
      (ledgerRow?.payload as Record<string, unknown>)["marketplaceItemId"],
    ).toBe(event.marketplaceItemId);
  });

  it("re-running the bridge for one market event records exactly one ledger row", async () => {
    const endpoint = await service.createEndpoint({
      provider: "ntfy",
      name: "replay endpoint",
      config: { baseUrl: "https://ntfy.example.test", topic: "replay" },
    });
    await service.createRule({
      name: "replay rule",
      endpointId: endpoint.id,
      eventClass: "market",
    });
    const event = await insertMarketEvent(handle.db, {
      externalItemId: "replay-item",
    });
    const calls: unknown[] = [];
    const captureAddJob = (async (_task: unknown, payload: unknown) => {
      calls.push(payload);
      return {} as never;
    }) as AddJob;

    const first = await pipeline.enqueueDeliveriesForEvent(captureAddJob, {
      id: event.id,
      eventType: event.eventType,
      monitorTargetId: event.monitorTargetId,
    });
    const second = await pipeline.enqueueDeliveriesForEvent(captureAddJob, {
      id: event.id,
      eventType: event.eventType,
      monitorTargetId: event.monitorTargetId,
    });
    expect(first.endpointIds).toContain(endpoint.id);
    // At-least-once: the duplicate emission recorded nothing and routed
    // nothing, so it cannot notify twice.
    expect(second.endpointIds).toEqual([]);
    expect(calls).toHaveLength(first.endpointIds.length);
    const rows = await handle.db.query.notificationEvents.findMany({
      where: (table, { eq }) =>
        eq(table.deduplicationKey, `market_event:${event.id}`),
    });
    expect(rows).toHaveLength(1);
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
    await service.createRule({
      name: "runtime rule",
      endpointId: endpoint.id,
      eventClass: "market",
    });
    const event = await insertMarketEvent(handle.db, {
      externalItemId: "runtime-item",
    });

    fetchCalls.length = 0;
    await pipeline.enqueueDeliveriesForEvent(runtime.addJob, {
      id: event.id,
      eventType: event.eventType,
      monitorTargetId: event.monitorTargetId,
    });

    const notificationEventId = await notificationEventIdFor(event.id);
    const row = await waitFor(
      async () => {
        const delivery = await deliveryRow(notificationEventId, endpoint.id);
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
    const ledgerRow = await handle.db.query.notificationEvents.findFirst({
      where: (table, { eq }) => eq(table.id, notificationEventId),
    });
    expect(request.body).toBe(
      renderMarketEventMessage(marketEventFromNotificationEvent(ledgerRow!))
        .body,
    );

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
    const after = await deliveryRow(notificationEventId, endpoint.id);
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
    const notificationEventId = await recordOnly({
      id: event.id,
      eventType: event.eventType,
      monitorTargetId: event.monitorTargetId,
    });
    const payload = { notificationEventId, endpointId: endpoint.id };

    // Two transport failures: each attempt increments attempt_count,
    // records last_error, marks the row failed, and rethrows (so the job
    // system would retry).
    failNext = 2;
    await expect(
      pipeline.deliverTask.handler(payload, directContext),
    ).rejects.toThrow(/HTTP 500/);
    let row = await deliveryRow(notificationEventId, endpoint.id);
    expect(row?.status).toBe("failed");
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastError).toContain("500");

    await expect(
      pipeline.deliverTask.handler(payload, directContext),
    ).rejects.toThrow(/HTTP 500/);
    row = await deliveryRow(notificationEventId, endpoint.id);
    expect(row?.attemptCount).toBe(2);

    // Third attempt succeeds: failed → delivered, error cleared.
    await pipeline.deliverTask.handler(payload, directContext);
    row = await deliveryRow(notificationEventId, endpoint.id);
    expect(row?.status).toBe("delivered");
    expect(row?.attemptCount).toBe(3);
    expect(row?.deliveredAt).not.toBeNull();
    expect(row?.lastError).toBeNull();

    // Re-running the delivered row is a no-op: no attempt, no transport.
    const callsBefore = fetchCalls.length;
    await pipeline.deliverTask.handler(payload, directContext);
    row = await deliveryRow(notificationEventId, endpoint.id);
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
    const notificationEventId = await recordOnly({
      id: event.id,
      eventType: event.eventType,
      monitorTargetId: event.monitorTargetId,
    });
    await pipeline.deliverTask.handler(
      { notificationEventId, endpointId: endpoint.id },
      directContext,
    );
    const row = await deliveryRow(notificationEventId, endpoint.id);
    expect(row?.status).toBe("pending");
    expect(row?.attemptCount).toBe(0);
    expect(row?.deliveredAt).toBeNull();
  });
});
