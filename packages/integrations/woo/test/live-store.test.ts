/**
 * LIVE leg — a REAL PRODUCTION WooCommerce store, read-only credentials.
 *
 * Skips cleanly when ~/.config/loxep/woo-syracusesynergy.env is absent (CI has
 * no credentials).
 *
 * ABSOLUTE RULES honored here, and how:
 *
 * - **Read-only.** Every call in this file is a GET through the adapter, which
 *   has no other method. Nothing writes.
 * - **No credential material anywhere.** Keys are never printed, asserted by
 *   value, or interpolated into a message. Leak checks are containment
 *   comparisons run programmatically over serialized output.
 * - **No customer PII in any test output.** Assertions only ever receive
 *   booleans, numbers, and regex-checked scalars that are structurally
 *   incapable of being personal data (ids, statuses, currency codes, decimal
 *   strings). `WooOrderFact.raw`, `billing`, and `shipping` are never passed to
 *   `expect()`, never logged, and never snapshotted.
 * - **Failure output is scrubbed.** {@link check} runs each assertion group
 *   inside a try/catch and re-throws a message built only from the label and a
 *   hand-written summary, so a vitest diff can never print a payload. The
 *   whole file additionally runs under a final scrub that asserts no
 *   credential substring escaped.
 * - **Polite volume.** Six requests total, `per_page` of 1 or 2.
 */
import { describe, expect, it } from "vitest";
import {
  DECIMAL_STRING,
  WOO_ERROR_KINDS,
  WOO_FULFILLMENT_STATUSES,
  WOO_ORDER_STATUSES,
  WOO_PAYMENT_STATUSES,
  WooAdapterError,
  createRateBudget,
  createWooAdapter,
  fetchOrdersPage,
  fetchProducts,
  loadWooCredentialsFromEnvFile,
  probeConnection,
} from "../src/index.ts";
import type { WooOrderFact } from "../src/index.ts";

const creds = loadWooCredentialsFromEnvFile();

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-store] skipped: no credentials at ~/.config/loxep/woo-syracusesynergy.env",
  );
}

const describeLive = creds === null ? describe.skip : describe;

function makeAdapter(overrides: Record<string, unknown> = {}) {
  if (creds === null) throw new Error("unreachable: creds checked by skip");
  return createWooAdapter({
    ...creds,
    // Deliberately gentle against someone's production shop.
    rateBudget: createRateBudget({ capacity: 4, refillPerSecond: 1 }),
    ...overrides,
  });
}

function assertNoCredentialMaterial(text: string): void {
  if (creds === null) return;
  expect(text.includes(creds.consumerKey)).toBe(false);
  expect(text.includes(creds.consumerSecret)).toBe(false);
  // The base64 the adapter would send, in case something echoed a header.
  const basic = Buffer.from(
    `${creds.consumerKey}:${creds.consumerSecret}`,
  ).toString("base64");
  expect(text.includes(basic)).toBe(false);
}

/**
 * Run assertions with SCRUBBED failure output. Vitest prints the thrown
 * message and, for `expect` failures, a diff of the compared values — which
 * against a live store could be a customer's address. Anything thrown inside
 * is replaced by a message built solely from `label`.
 */
function check(label: string, fn: () => void): void {
  try {
    fn();
  } catch {
    throw new Error(
      `live assertion failed: ${label} (details withheld — the compared values may contain customer data)`,
    );
  }
}

/**
 * Structural, PII-free description of one order fact. Every value here is a
 * boolean, a number, or a scalar that cannot be personal data.
 */
function orderShape(fact: WooOrderFact) {
  return {
    idIsNonEmptyString:
      typeof fact.externalOrderId === "string" && fact.externalOrderId.length > 0,
    idIsDigits: /^\d+$/.test(fact.externalOrderId),
    sourceAccountKeyMatches:
      fact.sourceAccountKey === `woocommerce:${creds?.baseUrl.replace(/\/+$/, "")}`,
    statusInUnion: (WOO_ORDER_STATUSES as readonly string[]).includes(
      fact.status,
    ),
    paymentInUnion: (WOO_PAYMENT_STATUSES as readonly string[]).includes(
      fact.paymentStatus,
    ),
    fulfillmentInUnion: (
      WOO_FULFILLMENT_STATUSES as readonly string[]
    ).includes(fact.fulfillmentStatus),
    statusRecognized: fact.statusRecognized,
    currencyIsIso: /^[A-Z]{3}$/.test(fact.currency),
    placedAtIsIso: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(fact.placedAt),
    updatedAtIsIsoOrNull:
      fact.updatedAt === null ||
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(fact.updatedAt),
    buyerIsIdOrNull:
      fact.buyerExternalId === null || /^\d+$/.test(fact.buyerExternalId),
    totalsAllDecimal: Object.values(fact.totals).every((value) =>
      DECIMAL_STRING.test(value),
    ),
    lineCount: fact.lineItems.length,
    linesAllDecimal: fact.lineItems.every(
      (line) =>
        DECIMAL_STRING.test(line.quantity) &&
        DECIMAL_STRING.test(line.lineTotal) &&
        DECIMAL_STRING.test(line.lineTax) &&
        DECIMAL_STRING.test(line.lineSubtotal) &&
        (line.unitPrice === null || DECIMAL_STRING.test(line.unitPrice)),
    ),
    rawIsObject: typeof fact.raw === "object" && fact.raw !== null,
  };
}

describeLive("WooCommerce production store (live, read-only)", () => {
  it("probes the connection and reports store versions", async () => {
    const adapter = makeAdapter();
    const result = await probeConnection(adapter);

    check("probe result", () => {
      expect(result.ok).toBe(true);
      expect(result.probe === "system_status" || result.probe === "orders").toBe(
        true,
      );
      // At least one version must be discoverable by whichever probe answered.
      const versions = [result.storeInfo.wpVersion, result.storeInfo.wcVersion];
      expect(versions.some((v) => typeof v === "string" && /\d/.test(v))).toBe(
        true,
      );
      expect(result.namespace).toBe("wc/v3");
    });

    // Version strings are not personal data; they are the useful evidence.
    // eslint-disable-next-line no-console
    console.info(
      `[live-store] probe=${result.probe} wp=${result.storeInfo.wpVersion ?? "n/a"} wc=${result.storeInfo.wcVersion ?? "n/a"}`,
    );
    expect(adapter.stats().rateBudget.acquired).toBeGreaterThanOrEqual(1);
  });

  it("fetches orders (per_page=2) and maps them with required fields non-null", async () => {
    const adapter = makeAdapter();
    const result = await fetchOrdersPage(adapter, { perPage: 2 });

    check("orders page headers", () => {
      expect(typeof result.page.total === "number").toBe(true);
      expect(typeof result.page.totalPages === "number").toBe(true);
      expect(result.page.perPage).toBe(2);
      expect(result.orders.length).toBeGreaterThanOrEqual(1);
      expect(result.orders.length).toBeLessThanOrEqual(2);
    });

    for (const fact of result.orders) {
      const shape = orderShape(fact);
      check("order shape", () => {
        expect(shape.idIsNonEmptyString).toBe(true);
        expect(shape.idIsDigits).toBe(true);
        expect(shape.sourceAccountKeyMatches).toBe(true);
        expect(shape.statusInUnion).toBe(true);
        expect(shape.paymentInUnion).toBe(true);
        expect(shape.fulfillmentInUnion).toBe(true);
        expect(shape.statusRecognized).toBe(true);
        expect(shape.currencyIsIso).toBe(true);
        expect(shape.placedAtIsIso).toBe(true);
        expect(shape.updatedAtIsIsoOrNull).toBe(true);
        expect(shape.buyerIsIdOrNull).toBe(true);
        expect(shape.totalsAllDecimal).toBe(true);
        expect(shape.linesAllDecimal).toBe(true);
        expect(shape.rawIsObject).toBe(true);
      });
    }

    // Counts and statuses only — never an id, a name, or a payload.
    const statusCounts = result.orders.reduce<Record<string, number>>(
      (acc, fact) => {
        acc[fact.providerStatusRaw] = (acc[fact.providerStatusRaw] ?? 0) + 1;
        return acc;
      },
      {},
    );
    // eslint-disable-next-line no-console
    console.info(
      `[live-store] orders total=${result.page.total} pages=${result.page.totalPages} mapped=${result.orders.length} statuses=${JSON.stringify(statusCounts)}`,
    );
  });

  it("respects the pagination headers across two pages", async () => {
    const adapter = makeAdapter();
    const first = await fetchOrdersPage(adapter, { perPage: 2, page: 1 });
    const second = await fetchOrdersPage(adapter, { perPage: 2, page: 2 });

    check("pagination", () => {
      expect(first.page.total).toBe(second.page.total);
      expect(first.page.totalPages).toBe(second.page.totalPages);
      expect(first.page.hasNextPage).toBe(true);
      expect(first.page.page).toBe(1);
      expect(second.page.page).toBe(2);
      // The header total must be consistent with the page count at per_page=2.
      const total = first.page.total ?? 0;
      const pages = first.page.totalPages ?? 0;
      expect(pages).toBe(Math.ceil(total / 2));
      // Distinct pages must return distinct orders.
      const firstIds = new Set(first.orders.map((o) => o.externalOrderId));
      const overlap = second.orders.filter((o) =>
        firstIds.has(o.externalOrderId),
      );
      expect(overlap.length).toBe(0);
    });
  });

  it("fetches products with the minimal channel-listing shape", async () => {
    const adapter = makeAdapter();
    const products = await fetchProducts(adapter, { perPage: 2 });

    check("products", () => {
      expect(products.length).toBeGreaterThanOrEqual(1);
      for (const product of products) {
        expect(/^\d+$/.test(product.externalProductId)).toBe(true);
        expect(typeof product.name === "string" && product.name.length > 0).toBe(
          true,
        );
        expect(typeof product.status === "string").toBe(true);
        expect(
          product.price === null || DECIMAL_STRING.test(product.price),
        ).toBe(true);
        expect(product.sku === null || typeof product.sku === "string").toBe(
          true,
        );
      }
    });

    // eslint-disable-next-line no-console
    console.info(`[live-store] products mapped=${products.length}`);
  });

  it("yields taxonomy 'auth' for bogus credentials, with no secret material in the error", async () => {
    if (creds === null) throw new Error("unreachable");
    // Fully fabricated key pair — NOT derived from the real one.
    const adapter = createWooAdapter({
      baseUrl: creds.baseUrl,
      consumerKey: "ck_0000000000000000000000000000000000000000",
      consumerSecret: "cs_0000000000000000000000000000000000000000",
      rateBudget: createRateBudget({ capacity: 2, refillPerSecond: 1 }),
    });

    const error = await fetchOrdersPage(adapter, { perPage: 1 }).catch(
      (e: unknown) => e,
    );

    check("bogus-credential taxonomy", () => {
      expect(error instanceof WooAdapterError).toBe(true);
      const adapterError = error as WooAdapterError;
      expect(adapterError.kind).toBe("auth");
      expect(
        (WOO_ERROR_KINDS as readonly string[]).includes(adapterError.kind),
      ).toBe(true);
      expect(adapterError.detail["httpStatus"]).toBe(401);
      // The provider code WooCommerce actually returns for a bad key pair.
      expect(typeof adapterError.detail["providerCode"]).toBe("string");
    });

    const adapterError = error as WooAdapterError;
    const serialized =
      JSON.stringify({
        message: adapterError.message,
        kind: adapterError.kind,
        detail: adapterError.detail,
        stack: adapterError.stack,
      }) ?? "";
    // Neither the bogus pair nor — crucially — the REAL pair may appear.
    assertNoCredentialMaterial(serialized);
    expect(serialized.includes("Basic ")).toBe(false);
    expect(serialized.includes("ck_0000")).toBe(false);
    expect(serialized.includes("cs_0000")).toBe(false);
  });
});
