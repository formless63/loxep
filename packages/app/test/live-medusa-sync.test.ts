/**
 * LIVE tier for the Medusa commerce wiring (loxep-xxz) — one bounded order
 * sync against a REAL, throwaway Medusa v2 backend (2.18.0), driven end to
 * end through the REAL composed worker registry. The analogue of
 * `live-woo-sync.test.ts`. Skips cleanly when `~/.config/loxep/medusa.env` is
 * absent (CI, a fresh clone) — see
 * `packages/integrations/medusa/test/harness.md` for how that file and the
 * throwaway backend behind it are provisioned.
 *
 * ## What this tier proves that the mocked e2e cannot
 *
 * `commerce-medusa-sync.test.ts` proves the wiring against a fake adapter.
 * This one proves the COMPOSITION against a real backend: the secret API key
 * is stored as a real ADR-0019 `medusa_credentials` connection credential
 * (encrypted with the real keyring cipher), the backend URL is stored as the
 * non-secret `connections.config.medusa.baseUrl`, and `@loxep/app`'s
 * `medusa.ts` adapter factory resolves both — UNCHANGED, no test-only seam —
 * against a backend that actually answers. From there the dispatcher claims
 * the registered `medusa_orders` target, `market.poll-target` runs the routed
 * executor, and the commerce sync service ingests through the REAL
 * `iterateMedusaOrders`, including its fail-open watermark canary.
 *
 * The harness seeds exactly the order the live translator mappings exist to
 * catch: an order captured in full and then PARTIALLY REFUNDED, where
 * Medusa's own `total` drops while `original_total` stays put. This suite's
 * central assertion re-derives that live fact independently (a fresh,
 * read-only Admin API call this file makes for itself, entirely separate from
 * the production adapter factory under test) and checks it against what
 * ingestion actually persisted.
 *
 * ## TLS
 *
 * `config.ts` refuses a non-`https` baseUrl, and that rule is
 * production-correct — it is not relaxed here. The harness fronts the
 * backend with a self-signed TLS terminator, and `@loxep/app`'s adapter
 * factories have no `fetchImpl` seam and must not grow a production one for a
 * test. The fix is external to this file: run it with
 * `NODE_EXTRA_CA_CERTS=<harness cert>` (see harness.md), which makes the
 * process's ordinary global `fetch` trust that one certificate.
 *
 * That trust step is a PRECONDITION, and an unmet precondition skips rather
 * than fails — the same class as an absent credential file, and for the same
 * reason: `bun run test:packages` is a mandatory gate, and a gate that goes
 * red on the one machine that actually has the harness installed teaches
 * everyone to ignore it. So when the env file names a `MEDUSA_CA_CERT_FILE`
 * (i.e. the backend is behind a self-signed terminator) and this process was
 * not started with `NODE_EXTRA_CA_CERTS` covering it, the suite skips and says
 * exactly which variable to set.
 *
 * This hides nothing. A real live run sets the variable, and from then on any
 * TLS failure is loud, because the precondition is met and the skip no longer
 * applies.
 *
 * ## ABSOLUTE RULES honored here, and how
 *
 * - **Read-only against the provider.** Every provider call — through the
 *   production adapter AND through this file's own independent verification
 *   call — is a GET.
 * - **Polite volume.** At most TWO pages of FIVE orders, enforced by the
 *   target's own `config.commerceSync.perPage`/`maxPages`.
 * - **No credential material and no customer PII in any output.** Every
 *   assertion receives booleans, numbers, or regex-checked scalars. Order
 *   payloads are never passed to `expect()`, logged, or snapshotted. The
 *   {@link check} wrapper replaces any thrown assertion output with a message
 *   built solely from a hand-written label, so a vitest diff cannot print a
 *   payload — the same discipline `live-woo-sync.test.ts` uses.
 * - **The scratch database is dropped afterwards.**
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { createMarketTasks, createMonitorService } from "@loxep/market";
import type { MonitorService, MonitorTargetRow } from "@loxep/market";
import {
  COMMERCE_SYNC_CONFIG_KEY,
  MEDUSA_ORDERS_TARGET_TYPE,
  medusaOrdersTargetConfigSchema,
} from "@loxep/commerce";
import {
  createMedusaAdapter,
  createRateBudget,
  defaultMedusaEnvFilePath,
  loadMedusaCredentialsFromEnvFile,
} from "@loxep/integration-medusa";
import {
  MEDUSA_ABSOLUTE_MIN_INTERVAL_SECONDS,
  MEDUSA_CONNECTION_CONFIG_KEY,
  MEDUSA_CREDENTIAL_TYPE,
  buildWorkerRegistry,
} from "../src/index.ts";
import type { WorkerComposition } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const creds = loadMedusaCredentialsFromEnvFile();

/**
 * The harness's self-signed trust anchor, read straight out of the env file —
 * `loadMedusaCredentialsFromEnvFile` deliberately ignores this line, because
 * it is a local-harness concern and not part of the credential contract.
 * Returns `null` when the file is absent or names no cert, which is the
 * ordinary case for a backend with a publicly trusted certificate.
 */
function harnessCaCertFile(): string | null {
  let content: string;
  try {
    content = readFileSync(defaultMedusaEnvFilePath(), "utf8");
  } catch {
    return null;
  }
  const match = /^MEDUSA_CA_CERT_FILE=(.*)$/m.exec(content);
  const value = match?.[1]?.trim().replace(/^["']|["']$/gu, "");
  return value === undefined || value === "" ? null : value;
}

/**
 * True when the backend sits behind a self-signed terminator this process has
 * NOT been told to trust — see the TLS section of this module's doc. Compared
 * by path membership rather than by parsing the certificate, because
 * `NODE_EXTRA_CA_CERTS` is consumed by Node at startup and cannot be inspected
 * any more precisely from inside the process.
 */
function selfSignedTrustMissing(): string | null {
  const caCertFile = harnessCaCertFile();
  if (caCertFile === null) return null;
  const trusted = process.env["NODE_EXTRA_CA_CERTS"] ?? "";
  return trusted.includes(caCertFile) ? null : caCertFile;
}

const untrustedCaCertFile = creds === null ? null : selfSignedTrustMissing();
const optedIn = liveTestsEnabledFor("medusa");

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-medusa-sync] skipped: no credentials at ~/.config/loxep/medusa.env",
  );
} else if (untrustedCaCertFile !== null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-medusa-sync] skipped: the harness backend is behind a self-signed " +
      "TLS terminator and this process does not trust it. Re-run with " +
      `NODE_EXTRA_CA_CERTS=${untrustedCaCertFile} (see ` +
      "packages/integrations/medusa/test/harness.md).",
  );
} else if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-medusa-sync] skipped: credentials present but not opted in — set " +
      "LOXEP_LIVE_TESTS=medusa (or =all) to run against the live instance.",
  );
}

const describeLive =
  creds === null || untrustedCaCertFile !== null || !optedIn
    ? describe.skip
    : describe;

/** A bounded slice: five orders per page, at most two pages per sync. */
const PER_PAGE = 5;
const MAX_PAGES = 2;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const dbName = scratchDbName("loxep_test_app_live_medusa");
let databaseUrl = "";
let handle: DbHandle;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let monitors: MonitorService;
let connectionId = "";
let targetId = "";
let firstPoll: MonitorTargetRow;

/**
 * Run assertions with SCRUBBED failure output — see the module doc.
 */
function check(label: string, assertions: () => void): void {
  try {
    assertions();
  } catch {
    throw new Error(`live-medusa-sync assertion failed: ${label}`);
  }
}

function commerceSyncState(target: MonitorTargetRow): Record<string, unknown> {
  const config = target.config as Record<string, unknown> | null;
  const state = config?.[COMMERCE_SYNC_CONFIG_KEY];
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>)
    : {};
}

async function countOf(table: string): Promise<number> {
  const rows = await handle.pool.query<{ n: string }>(
    `select count(*)::text as n from ${table}`,
  );
  return Number(rows.rows[0]?.n ?? "0");
}

/**
 * A fresh, read-only, independent verification call — deliberately NOT
 * routed through `@loxep/app`'s production adapter factory or cache. This is
 * what lets the central assertion below compare "what ingestion persisted"
 * against "what the backend says right now" without trusting the same code
 * path twice.
 */
async function liveOrderTotals(
  externalOrderId: string,
): Promise<{ total: string; originalTotal: string } | null> {
  if (creds === null) return null;
  const adapter = createMedusaAdapter({
    baseUrl: creds.baseUrl,
    apiToken: creds.apiToken,
    rateBudget: createRateBudget({ capacity: 2, refillPerSecond: 1 }),
  });
  const response = await adapter.get(`/orders/${externalOrderId}`, {
    fields: "id,total,original_total",
  });
  const body = response.data as { order?: Record<string, unknown> };
  const order = body.order;
  if (order === undefined) return null;
  const total = order["total"];
  const originalTotal = order["original_total"];
  if (typeof total !== "number" || typeof originalTotal !== "number") {
    return null;
  }
  return { total: String(total), originalTotal: String(originalTotal) };
}

describeLive("live Medusa order sync through the worker", () => {
  beforeAll(async () => {
    if (creds === null) return;
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    const config = testConfig(databaseUrl);

    composition = buildWorkerRegistry({
      config,
      logger: silentJobsLogger,
      // Deliberately gentle against the harness backend; also exercises the
      // explicit-override-wins branch of the factory.
      medusaRateBudget: { capacity: 4, refillPerSecond: 1 },
    });
    const services = composition.services;

    runtime = await startWorkerRuntime({
      databaseUrl,
      logger: silentJobsLogger,
      concurrency: 1,
      pollInterval: 200,
      registry: composition.registry,
      cronItems: [],
    });

    await handle.db.insert(user).values({
      id: "live-medusa-user",
      name: "Live Medusa User",
      email: "live-medusa@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The NON-secret half on the connection…
    const connection = await services.connections.createConnection({
      provider: "medusa",
      kind: "store_account",
      name: "medusa-verify (live, throwaway)",
      config: { [MEDUSA_CONNECTION_CONFIG_KEY]: { baseUrl: creds.baseUrl } },
      createdByUserId: "live-medusa-user",
    });
    connectionId = connection.id;

    // …and the secret half as a real ADR-0019 encrypted bundle.
    await services.connectionCredentials.setCredential({
      connectionId,
      credentialType: MEDUSA_CREDENTIAL_TYPE,
      payload: { apiToken: creds.apiToken },
      actorUserId: "live-medusa-user",
    });

    monitors = createMonitorService({ db: handle.db });
    const target = await monitors.createTarget({
      targetType: MEDUSA_ORDERS_TARGET_TYPE,
      name: "medusa-verify orders",
      connectionId,
      intervalSeconds: 900,
      config: {
        [COMMERCE_SYNC_CONFIG_KEY]: { perPage: PER_PAGE, maxPages: MAX_PAGES },
      },
      nextPollAt: new Date(Date.now() - 1000),
    });
    targetId = target.id;

    const market = createMarketTasks({ db: handle.db });
    await runtime.addJob(market.dispatchDueMonitorsTask, {});
    firstPoll = await waitFor(
      async () => {
        const row = await monitors.getTarget(targetId);
        return row.lastSuccessAt !== null ? row : undefined;
      },
      { timeoutMs: 120_000, label: "live medusa_orders poll recorded success" },
    );
  }, 240_000);

  afterAll(async () => {
    if (creds === null) return;
    await runtime?.stop();
    await composition?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("ingested a bounded slice of real orders through the poll path", async () => {
    const orders = await countOf("orders");
    const lines = await countOf("order_lines");
    const links = await countOf("order_source_links");
    const objects = await countOf("provider_objects");
    check("slice is bounded, non-empty, and fully provenanced", () => {
      expect(orders).toBeGreaterThan(0);
      expect(orders).toBeLessThanOrEqual(PER_PAGE * MAX_PAGES);
      expect(lines).toBeGreaterThan(0);
      expect(links).toBe(orders);
      expect(objects).toBe(orders);
    });
  });

  it("persists total_amount as original_total, never the refund-reduced total", async () => {
    // The harness seeds exactly one order with a partial refund. Find it by
    // its OWN persisted evidence rather than assuming an id.
    const refunded = await handle.pool.query<{
      external_order_id: string;
      total_amount: string;
      refunded_amount: string;
    }>(
      `select external_order_id, total_amount, refunded_amount
         from orders
        where connection_id = $1 and refunded_amount::numeric > 0
        limit 1`,
      [connectionId],
    );
    const row = refunded.rows[0];
    check("harness seeded at least one refunded order in the bounded slice", () => {
      expect(row).toBeDefined();
    });
    if (row === undefined) return;

    const live = await liveOrderTotals(row.external_order_id);
    check("independent live re-fetch of the same order succeeded", () => {
      expect(live).not.toBeNull();
    });
    if (live === null) return;

    check("total_amount equals the live original_total, not the reduced total", () => {
      expect(Number(row.total_amount)).toBeCloseTo(Number(live.originalTotal), 6);
      // The whole point of the mapping: a refunded order's CURRENT `total` is
      // strictly less than what was persisted, because Medusa itself reduced
      // it and Loxep must not re-derive or re-apply that reduction.
      expect(Number(live.total)).toBeLessThan(Number(live.originalTotal));
      expect(Number(row.total_amount)).not.toBeCloseTo(Number(live.total), 6);
    });
  });

  it("refunded_amount matches the summed refunds, with nothing double-subtracted", async () => {
    const rows = await handle.pool.query<{
      order_id: string;
      refunded_amount: string;
    }>(
      `select id as order_id, refunded_amount
         from orders
        where connection_id = $1 and refunded_amount::numeric > 0`,
      [connectionId],
    );
    check("at least one order carries a refund", () => {
      expect(rows.rows.length).toBeGreaterThan(0);
    });
    for (const row of rows.rows) {
      const sum = await handle.pool.query<{ n: string }>(
        `select coalesce(sum(amount), 0)::text as n
           from order_refunds where order_id = $1`,
        [row.order_id],
      );
      check("stored refunded_amount equals the sum of that order's own refund rows", () => {
        expect(Number(row.refunded_amount)).toBeCloseTo(Number(sum.rows[0]?.n ?? "0"), 6);
      });
    }
  });

  it("subtotal_amount + shipping_amount never exceeds total_amount", async () => {
    const rows = await handle.pool.query<{
      subtotal_amount: string;
      shipping_amount: string;
      total_amount: string;
    }>(
      `select subtotal_amount, shipping_amount, total_amount
         from orders where connection_id = $1`,
      [connectionId],
    );
    check("every order's independent subtotal+shipping facts stay within the total", () => {
      for (const row of rows.rows) {
        expect(
          Number(row.subtotal_amount) + Number(row.shipping_amount),
        ).toBeLessThanOrEqual(Number(row.total_amount) + 1e-6);
      }
    });
  });

  it("reports fee_amount = 0 with zero order_fees rows — Medusa has no fee concept", async () => {
    const rows = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n
         from orders where connection_id = $1 and fee_amount::numeric <> 0`,
      [connectionId],
    );
    const fees = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n
         from order_fees f
         join orders o on o.id = f.order_id
        where o.connection_id = $1`,
      [connectionId],
    );
    check("no Medusa order carries a nonzero fee or a fee row", () => {
      expect(Number(rows.rows[0]?.n)).toBe(0);
      expect(Number(fees.rows[0]?.n)).toBe(0);
    });
  });

  it("never schedules the backend faster than the politeness floor", () => {
    check("next_poll_at respects the Medusa interval floor", () => {
      expect(firstPoll.nextPollAt).not.toBeNull();
      const seconds =
        ((firstPoll.nextPollAt as Date).getTime() -
          (firstPoll.lastSuccessAt as Date).getTime()) /
        1000;
      expect(seconds).toBeGreaterThanOrEqual(MEDUSA_ABSOLUTE_MIN_INTERVAL_SECONDS);
    });
  });

  it("re-polls incrementally: the boundary order re-delivers idempotently (created 0)", async () => {
    const before = await countOf("orders");
    await monitors.updateTarget(targetId, {
      nextPollAt: new Date(Date.now() - 1000),
    });
    const market = createMarketTasks({ db: handle.db });
    await runtime.addJob(market.dispatchDueMonitorsTask, {});
    const second = await waitFor(
      async () => {
        const row = await monitors.getTarget(targetId);
        const advanced =
          row.lastSuccessAt !== null &&
          firstPoll.lastSuccessAt !== null &&
          row.lastSuccessAt.getTime() > firstPoll.lastSuccessAt.getTime();
        return advanced ? row : undefined;
      },
      { timeoutMs: 120_000, label: "second live medusa_orders poll" },
    );

    const after = await countOf("orders");
    check("a second poll re-read the overlap idempotently and created no new order rows", () => {
      expect(after).toBe(before);
      expect(second.consecutiveErrors).toBe(0);
    });
  }, 240_000);

  it("still writes modifiedAfter on a run with no new orders, and the config re-parses", async () => {
    const before = await monitors.getTarget(targetId);
    await monitors.updateTarget(targetId, {
      nextPollAt: new Date(Date.now() - 1000),
    });
    const market = createMarketTasks({ db: handle.db });
    await runtime.addJob(market.dispatchDueMonitorsTask, {});
    const third = await waitFor(
      async () => {
        const row = await monitors.getTarget(targetId);
        const advanced =
          row.lastSuccessAt !== null &&
          before.lastSuccessAt !== null &&
          row.lastSuccessAt.getTime() > before.lastSuccessAt.getTime();
        return advanced ? row : undefined;
      },
      { timeoutMs: 120_000, label: "third live medusa_orders poll" },
    );

    const state = commerceSyncState(third);
    const parsed = medusaOrdersTargetConfigSchema.safeParse({
      [COMMERCE_SYNC_CONFIG_KEY]: state,
    });
    check("the cursor is an ISO watermark and the stored config re-parses", () => {
      expect(ISO_INSTANT.test(String(state["modifiedAfter"]))).toBe(true);
      expect(ISO_INSTANT.test(String(state["lastSyncedAt"]))).toBe(true);
      expect(typeof state["lastOrderCount"]).toBe("number");
      expect(parsed.success).toBe(true);
      expect(third.consecutiveErrors).toBe(0);
    });
  }, 240_000);

  it("keeps buyer personal data out of every domain column", async () => {
    const leaks = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n
         from orders
        where buyer_display_name is not null
           or buyer_external_id like '%@%'`,
    );
    check("no buyer PII in domain columns", () => {
      expect(Number(leaks.rows[0]?.n)).toBe(0);
    });
  });
});
