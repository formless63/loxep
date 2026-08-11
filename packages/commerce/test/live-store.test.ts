/**
 * LIVE tier — ingestion against a REAL PRODUCTION WooCommerce store with
 * read-only credentials, into a throwaway scratch database.
 *
 * Skips cleanly when ~/.config/loxep/woo.env is absent (CI has
 * no credentials).
 *
 * ABSOLUTE RULES honored here, and how:
 *
 * - **Read-only against the provider.** Every provider call is a GET through
 *   the adapter, which has no other method.
 * - **Polite volume.** The store has hundreds of orders; this file reads at
 *   most FOUR pages of five, and never walks the whole history. `maxPages` is
 *   the hard stop, and the rate budget is set deliberately low.
 * - **No credential material and no customer PII in any output.** Assertions
 *   only ever receive booleans, numbers, and regex-checked scalars that are
 *   structurally incapable of being personal data. Order payloads — which
 *   carry billing/shipping addresses, email, phone, IP, and user agent — are
 *   never passed to `expect()`, never logged, and never snapshotted. The
 *   {@link check} wrapper replaces any thrown assertion output with a message
 *   built solely from a hand-written label, so a vitest diff cannot print a
 *   payload.
 * - **The scratch database is dropped afterwards**, so the retained payloads
 *   (which DO contain personal data — that is the whole point of open question
 *   8) do not outlive the test.
 */
import {
  createRateBudget,
  createWooAdapter,
  loadWooCredentialsFromEnvFile,
} from "@loxep/integration-woo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrderIngestionService } from "../src/orders.ts";
import { orderSummary } from "../src/reports.ts";
import { createWooOrderSync } from "../src/sync.ts";
import type { SyncWooOrdersResult } from "../src/sync.ts";
import { createMigratedScratchDb, seedConnection, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

const creds = loadWooCredentialsFromEnvFile();

if (creds === null) {
  console.info(
    "[live-store] skipped: no credentials at ~/.config/loxep/woo.env",
  );
}

const describeLive = creds === null ? describe.skip : describe;

/** A bounded slice: five orders per page, at most two pages per sync. */
const PER_PAGE = 5;
const MAX_PAGES = 2;

const DECIMAL = /^-?\d+\.\d{6}$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Run assertions with SCRUBBED failure output. Vitest prints the thrown
 * message and, for `expect` failures, a diff of the compared values — which
 * against a live store could be a customer's address. Anything thrown inside
 * is replaced by a message built solely from `label`.
 */
function check(label: string, assertions: () => void): void {
  try {
    assertions();
  } catch {
    throw new Error(`live-store assertion failed: ${label}`);
  }
}

describeLive("live WooCommerce ingestion", () => {
  let scratch: ScratchDb;
  let connectionId: string;
  let firstRun: SyncWooOrdersResult;

  beforeAll(async () => {
    if (creds === null) return;
    scratch = await createMigratedScratchDb("loxep_test_commerce_live");
    const entityId = await seedEntity(scratch, "Syracuse Synergy LLC");
    connectionId = await seedConnection(scratch, {
      name: "examplestore (live, read-only)",
      economicEntityId: entityId,
    });

    const sync = createWooOrderSync({
      db: scratch.handle.db,
      adapterFactory: () =>
        createWooAdapter({
          ...creds,
          // Deliberately gentle against someone's production shop.
          rateBudget: createRateBudget({ capacity: 4, refillPerSecond: 1 }),
        }),
      ingestion: createOrderIngestionService({ db: scratch.handle.db }),
    });

    firstRun = await sync.syncConnection({
      connectionId,
      // No watermark: take the store's most recent slice, bounded by maxPages.
      modifiedAfter: null,
      perPage: PER_PAGE,
      maxPages: MAX_PAGES,
    });
  }, 180_000);

  afterAll(async () => {
    if (creds === null) return;
    await scratch.close();
  });

  it("ingests a bounded slice of real orders", () => {
    check("slice is bounded and non-empty", () => {
      expect(firstRun.pages).toBeGreaterThan(0);
      expect(firstRun.pages).toBeLessThanOrEqual(MAX_PAGES);
      expect(firstRun.ordersSeen).toBeGreaterThan(0);
      expect(firstRun.ordersSeen).toBeLessThanOrEqual(PER_PAGE * MAX_PAGES);
      expect(firstRun.created).toBe(firstRun.ordersSeen);
      // A single store cannot produce cross-connection duplicates.
      expect(firstRun.duplicatesMarked).toBe(0);
    });
    check("currencies are ISO codes", () => {
      expect(firstRun.currencies.length).toBeGreaterThan(0);
      for (const currency of firstRun.currencies) {
        expect(CURRENCY.test(currency)).toBe(true);
      }
    });
    check("a watermark was persisted", () => {
      expect(firstRun.nextModifiedAfter).not.toBeNull();
    });
  });

  it("persisted lines and provenance for every order", async () => {
    const counts = await scratch.handle.pool.query<{
      orders: string;
      lines: string;
      links: string;
      objects: string;
    }>(
      `select (select count(*) from orders)::text as orders,
              (select count(*) from order_lines)::text as lines,
              (select count(*) from order_source_links)::text as links,
              (select count(*) from provider_objects)::text as objects`,
    );
    const row = counts.rows[0];
    check("counts line up", () => {
      expect(Number(row?.orders)).toBe(firstRun.ordersSeen);
      expect(Number(row?.lines)).toBeGreaterThan(0);
      // One provenance link and one retained payload per order.
      expect(Number(row?.links)).toBe(firstRun.ordersSeen);
      expect(Number(row?.objects)).toBe(firstRun.ordersSeen);
    });
  });

  it("keeps buyer personal data out of every domain column", async () => {
    // The payload in provider_objects DOES carry PII — that is the designed
    // provenance boundary. The domain columns must not.
    const leaks = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n
         from orders
        where buyer_display_name is not null
           or buyer_external_id like '%@%'`,
    );
    const shipping = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n
         from order_fulfillments
        where destination_region like '%@%'
           or coalesce(length(destination_country), 2) <> 2`,
    );
    check("no buyer PII in domain columns", () => {
      expect(Number(leaks.rows[0]?.n)).toBe(0);
      expect(Number(shipping.rows[0]?.n)).toBe(0);
    });
  });

  it("is idempotent: an immediate re-run creates nothing", async () => {
    const sync = createWooOrderSync({
      db: scratch.handle.db,
      adapterFactory: () =>
        createWooAdapter({
          ...creds!,
          rateBudget: createRateBudget({ capacity: 4, refillPerSecond: 1 }),
        }),
    });
    const second = await sync.syncConnection({
      connectionId,
      modifiedAfter: null,
      perPage: PER_PAGE,
      maxPages: MAX_PAGES,
      persistCursor: false,
    });

    const orders = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n from orders`,
    );
    check("re-run created nothing", () => {
      expect(second.created).toBe(0);
      expect(second.ordersSeen).toBe(firstRun.ordersSeen);
      expect(Number(orders.rows[0]?.n)).toBe(firstRun.ordersSeen);
    });
  }, 180_000);

  it("summarizes the slice grouped by currency", async () => {
    const summary = await orderSummary(scratch.handle.db, { connectionId });
    check("summary is currency-grouped and exact", () => {
      expect(summary.length).toBe(firstRun.currencies.length);
      let counted = 0;
      for (const group of summary) {
        expect(CURRENCY.test(group.currency)).toBe(true);
        expect(DECIMAL.test(group.grossAmount)).toBe(true);
        expect(DECIMAL.test(group.refundedAmount)).toBe(true);
        expect(DECIMAL.test(group.netAmount)).toBe(true);
        // Woo core reports no seller-side fees at all.
        expect(group.feeAmount).toBe("0.000000");
        expect(group.orderCount).toBeGreaterThan(0);
        counted += group.orderCount;
        // Every order lands in exactly one of the three status histograms.
        const statusTotal = Object.values(group.statusCounts).reduce(
          (sum, n) => sum + n,
          0,
        );
        expect(statusTotal).toBe(group.orderCount);
      }
      expect(counted).toBe(firstRun.ordersSeen);
    });
  });
});
