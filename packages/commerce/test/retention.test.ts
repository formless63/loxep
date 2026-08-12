/**
 * ADR-0021 order-payload retention sweep, against a real PostgreSQL +
 * TimescaleDB scratch database.
 *
 * Provenance is created by the REAL ingestion service rather than by hand, so
 * the `order_source_links` rows the ADR promises to leave alone are the ones
 * ingestion actually writes, and eligibility is then produced by BACKDATING
 * `fetched_at` — the one thing a test can honestly do that waiting 180 days
 * cannot.
 *
 * The redactor is a stub here on purpose: `@loxep/commerce` never learns a
 * provider's redacted shape (that seam is injected by `@loxep/app`, and
 * `packages/app/test/commerce-retention.test.ts` proves the real Woo and eBay
 * redactors strip personal data). What this file proves is the SWEEP: which
 * rows it selects, which it refuses to touch, and that running it twice
 * changes nothing the first run did not.
 *
 * **No fixture carries real personal data**, and no assertion prints a
 * payload's contents.
 */
import { createSettingsService, orderPayloadRetentionSetting } from "@loxep/domain";
import type { SettingsService } from "@loxep/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOrderIngestionService } from "../src/orders.ts";
import type { OrderIngestionService } from "../src/orders.ts";
import {
  ORDER_PROVIDER_OBJECT_TYPES,
  runOrderPayloadRedactionSweep,
} from "../src/retention.ts";
import type { OrderPayloadRedactors } from "../src/retention.ts";
import { commerceOrderFact } from "./fixtures.ts";
import { createMigratedScratchDb, seedConnection, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

/** Synthetic "personal data" — the thing the sweep must remove. */
function payloadWithPii(externalOrderId: string): Record<string, unknown> {
  return {
    id: externalOrderId,
    total: "42.00",
    billing: {
      first_name: "Fixture",
      last_name: "Person",
      address_1: "1 Nowhere Lane",
      email: "fixture.person@example.invalid",
      phone: "+1-555-0100",
    },
    customer_ip_address: "203.0.113.7",
  };
}

/**
 * The stub seam. Mirrors the real contract: drops everything but a couple of
 * non-personal facts, is total on its own output, and is synchronous.
 */
const stubRedactors: OrderPayloadRedactors = {
  "woocommerce.order": (payload) => {
    if (payload["raw"] === "[redacted]") return payload;
    return { id: payload["id"], total: payload["total"], raw: "[redacted]" };
  },
};

interface ProviderObjectRow {
  id: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  redacted_at: Date | null;
  fetched_at: Date;
}

describe("order payload retention sweep", () => {
  let scratch: ScratchDb;
  let ingestion: OrderIngestionService;
  let settings: SettingsService;
  let connectionId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_retention");
    ingestion = createOrderIngestionService({ db: scratch.handle.db });
    settings = createSettingsService({ db: scratch.handle.db });
    await seedEntity(scratch, "Retention Fixtures LLC");
    connectionId = await seedConnection(scratch, { name: "retention store" });
  });

  afterAll(async () => {
    await scratch.close();
  });

  beforeEach(async () => {
    // Every test starts from an explicit redact policy (the shipped default is
    // 'keep' after owner review), so a test that changes the policy cannot
    // leak into the next one and the sweep paths stay exercised.
    await settings.set(
      orderPayloadRetentionSetting,
      { mode: "redact", afterDays: 180 },
      { actorUserId: null, requestId: null },
    );
  });

  /** Ingest one order and return its provider-object id. */
  async function ingestOrder(externalOrderId: string): Promise<{
    orderId: string;
    providerObjectId: string;
  }> {
    const result = await ingestion.ingestOrderFact({
      connectionId,
      fact: commerceOrderFact({
        externalOrderId,
        rawPayload: payloadWithPii(externalOrderId),
      }),
    });
    if (result.providerObjectId === null) {
      throw new Error("ingestion retained no provider object");
    }
    return { orderId: result.orderId, providerObjectId: result.providerObjectId };
  }

  async function backdate(providerObjectId: string, days: number): Promise<void> {
    await scratch.handle.pool.query(
      `update provider_objects
          set fetched_at = now() - ($2::int * interval '1 day')
        where id = $1`,
      [providerObjectId, days],
    );
  }

  async function readProviderObject(id: string): Promise<ProviderObjectRow> {
    const result = await scratch.handle.pool.query<ProviderObjectRow>(
      `select id, payload, payload_hash, redacted_at, fetched_at
         from provider_objects where id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`provider object ${id} not found`);
    return row;
  }

  async function countSourceLinks(orderId: string): Promise<number> {
    const result = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n from order_source_links where order_id = $1`,
      [orderId],
    );
    return Number(result.rows[0]?.n ?? "0");
  }

  function sweep(overrides: { batchSize?: number; maxBatches?: number } = {}) {
    return runOrderPayloadRedactionSweep({
      db: scratch.handle.db,
      redactors: stubRedactors,
      settings,
      ...overrides,
    });
  }

  it("redacts a payload older than the window and stamps redacted_at", async () => {
    const { providerObjectId } = await ingestOrder("ret-1000");
    const before = await readProviderObject(providerObjectId);
    await backdate(providerObjectId, 200);

    const result = await sweep();

    expect(result.mode).toBe("redact");
    expect(result.afterDays).toBe(180);
    expect(result.redacted).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const after = await readProviderObject(providerObjectId);
    expect(after.redacted_at).not.toBeNull();
    expect(Object.hasOwn(after.payload, "billing")).toBe(false);
    expect(Object.hasOwn(after.payload, "customer_ip_address")).toBe(false);
    expect(after.payload["raw"]).toBe("[redacted]");
    // The load-bearing part of ADR-0021 #6: the hash still identifies the
    // ORIGINAL payload, so an unchanged re-sync keeps matching this row.
    expect(after.payload_hash).toBe(before.payload_hash);
  });

  it("leaves order_source_links and the provenance row itself intact", async () => {
    const { orderId, providerObjectId } = await ingestOrder("ret-1001");
    const linksBefore = await countSourceLinks(orderId);
    expect(linksBefore).toBeGreaterThanOrEqual(1);
    await backdate(providerObjectId, 365);

    await sweep();

    expect(await countSourceLinks(orderId)).toBe(linksBefore);
    // Redaction, never deletion: the row survives with its identity intact.
    const after = await readProviderObject(providerObjectId);
    expect(after.id).toBe(providerObjectId);
    expect(after.redacted_at).not.toBeNull();
  });

  it("skips a payload inside the window", async () => {
    const { providerObjectId } = await ingestOrder("ret-1002");
    await backdate(providerObjectId, 179);

    await sweep();

    const after = await readProviderObject(providerObjectId);
    expect(after.redacted_at).toBeNull();
    expect(Object.hasOwn(after.payload, "billing")).toBe(true);
  });

  it("is a no-op in keep mode, however old the payload is", async () => {
    const { providerObjectId } = await ingestOrder("ret-1003");
    await backdate(providerObjectId, 3650);
    await settings.set(
      orderPayloadRetentionSetting,
      { mode: "keep", afterDays: 180 },
      { actorUserId: null, requestId: null },
    );

    const result = await sweep();

    expect(result.mode).toBe("keep");
    expect(result.cutoff).toBeNull();
    expect(result.scanned).toBe(0);
    expect(result.redacted).toBe(0);
    const after = await readProviderObject(providerObjectId);
    expect(after.redacted_at).toBeNull();
    expect(Object.hasOwn(after.payload, "billing")).toBe(true);
  });

  it("skips an already-redacted row and is idempotent across two runs", async () => {
    const { providerObjectId } = await ingestOrder("ret-1004");
    await backdate(providerObjectId, 400);

    const first = await sweep();
    expect(first.redacted).toBeGreaterThanOrEqual(1);
    const afterFirst = await readProviderObject(providerObjectId);

    const second = await sweep();

    // Nothing was eligible the second time: the guard is `redacted_at is
    // null`, so an already-swept row is not even selected.
    expect(second.redacted).toBe(0);
    expect(second.scanned).toBe(0);
    expect(second.failed).toBe(0);

    const afterSecond = await readProviderObject(providerObjectId);
    expect(afterSecond.payload).toEqual(afterFirst.payload);
    expect(afterSecond.redacted_at?.getTime()).toBe(
      afterFirst.redacted_at?.getTime(),
    );
    expect(afterSecond.payload_hash).toBe(afterFirst.payload_hash);
  });

  it("bounds each run by batchSize × maxBatches and reports the remainder", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { providerObjectId } = await ingestOrder(`ret-11${index}0`);
      await backdate(providerObjectId, 300 + index);
      ids.push(providerObjectId);
    }

    const bounded = await sweep({ batchSize: 2, maxBatches: 1 });
    expect(bounded.batches).toBe(1);
    expect(bounded.scanned).toBe(2);
    expect(bounded.redacted).toBe(2);
    expect(bounded.more).toBe(true);

    // The rest drain on subsequent runs rather than being lost.
    const rest = await sweep({ batchSize: 100, maxBatches: 10 });
    expect(rest.redacted).toBe(3);
    expect(rest.more).toBe(false);

    for (const id of ids) {
      expect((await readProviderObject(id)).redacted_at).not.toBeNull();
    }
  });

  it("counts eligible rows of an order class with no injected redactor", async () => {
    const { providerObjectId } = await ingestOrder("ret-1200");
    await backdate(providerObjectId, 500);

    // No redactors at all: nothing is selected for rewriting, and the row is
    // reported as unhandled instead of silently ignored.
    const result = await runOrderPayloadRedactionSweep({
      db: scratch.handle.db,
      redactors: {},
      settings,
    });

    expect(result.redacted).toBe(0);
    expect(result.scanned).toBe(0);
    expect(result.unhandled["woocommerce.order"]).toBeGreaterThanOrEqual(1);
    expect(
      (await readProviderObject(providerObjectId)).redacted_at,
    ).toBeNull();

    // ...and the sweep with a redactor then clears it, proving the unhandled
    // path never marks anything.
    const swept = await sweep();
    expect(swept.redacted).toBeGreaterThanOrEqual(1);
    expect(swept.unhandled).toEqual({});
  });

  it("leaves a row verbatim when its redactor throws, and reports it", async () => {
    const { providerObjectId } = await ingestOrder("ret-1300");
    await backdate(providerObjectId, 600);

    const result = await runOrderPayloadRedactionSweep({
      db: scratch.handle.db,
      redactors: {
        "woocommerce.order": () => {
          throw new Error("synthetic redactor failure");
        },
      },
      settings,
    });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.redacted).toBe(0);
    const after = await readProviderObject(providerObjectId);
    expect(after.redacted_at).toBeNull();
    expect(Object.hasOwn(after.payload, "billing")).toBe(true);

    // Clean up so later assertions on totals are not skewed by a stuck row.
    await sweep();
  });

  it("declares the order-class object types ADR-0021 applies to", () => {
    expect([...ORDER_PROVIDER_OBJECT_TYPES]).toEqual([
      "woocommerce.order",
      "ebay.order",
    ]);
  });
});
