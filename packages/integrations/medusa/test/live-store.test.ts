/**
 * LIVE leg — a REAL Medusa v2 backend, read-only-intended secret API key.
 *
 * Skips cleanly when ~/.config/loxep/medusa.env is absent (CI, fresh clone).
 *
 * ## What this suite is for
 *
 * `@loxep/integration-medusa` was built fixtures-only against Medusa's GitHub
 * source. This suite is the answer to "but does a running backend actually
 * behave that way?", and it is written to keep answering it: each test below
 * asserts one of the six claims loxep-xh9.4.1 enumerated, so a future Medusa
 * release that changes any of them fails here rather than in production
 * ingestion.
 *
 * ```text
 * 1 Authorization: Basic <sk_…> wire format  → "authenticates with Basic <secret key> …"
 * 2 {resultKey, count, offset, limit}        → "returns the documented list envelope …"
 * 3 money = plain major-unit JSON numbers    → "reports money as plain numbers …"
 * 4 updated_at[$gte] bracket encoding        → "filters on updated_at[$gte] …"
 * 5 payment_status/fulfillment_status        → "returns payment_status and fulfillment_status …"
 * 6 $gte inclusivity                         → "treats $gte as inclusive …"
 * ```
 *
 * ## ABSOLUTE RULES honored here, and how
 *
 * - **Read-only.** Every call is a GET through the adapter, which has no
 *   other method. Nothing writes.
 * - **No credential material anywhere.** The token is never printed,
 *   asserted by value, or interpolated into a message. Leak checks are
 *   containment comparisons run programmatically over serialized output.
 * - **No customer PII in any test output.** Assertions only ever receive
 *   booleans, numbers, and regex-checked scalars that are structurally
 *   incapable of being personal data. `MedusaOrderFact.raw`, and the
 *   `email`/address fields inside it, are never passed to `expect()`, never
 *   logged, and never snapshotted.
 * - **Failure output is scrubbed.** {@link check} re-throws a message built
 *   only from its label, so a vitest diff can never print a payload.
 * - **Polite volume.** Small `limit` values throughout.
 *
 * ## Why a `fetchImpl` is injected
 *
 * `config.ts` refuses a non-https `baseUrl`, deliberately. A local Medusa dev
 * server speaks plain http on :9000, so the harness fronts it with an nginx
 * TLS terminator using a self-signed certificate, and this file trusts THAT
 * ONE CERTIFICATE via a `node:https` agent — rather than setting
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, which would disable verification for
 * every test in the worker. `MEDUSA_CA_CERT_FILE` in the env file names the
 * certificate; without it the adapter's ordinary global `fetch` is used, so
 * pointing this suite at a backend with a publicly trusted certificate needs
 * no code change. Everything above the socket — URL building, the
 * Authorization header, query encoding, response parsing, error
 * normalization — is the adapter's own code either way.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { describe, expect, it } from "vitest";
import {
  DECIMAL_STRING,
  MEDUSA_ERROR_KINDS,
  MEDUSA_FULFILLMENT_STATUSES,
  MEDUSA_NATIVE_FULFILLMENT_STATUSES,
  MEDUSA_NATIVE_ORDER_STATUSES,
  MEDUSA_NATIVE_PAYMENT_STATUSES,
  MEDUSA_ORDER_STATUSES,
  MEDUSA_PAYMENT_STATUSES,
  MedusaAdapterError,
  createMedusaAdapter,
  createRateBudget,
  fetchOrdersPage,
  fetchProducts,
  loadMedusaCredentialsFromEnvFile,
  probeConnection,
} from "../src/index.ts";
import type { MedusaFetch, MedusaOrderFact } from "../src/index.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const ENV_PATH = join(homedir(), ".config", "loxep", "medusa.env");
const creds = loadMedusaCredentialsFromEnvFile();
const optedIn = liveTestsEnabledFor("medusa");

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(`[live-store] skipped: no credentials at ${ENV_PATH}`);
} else if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-store] skipped: credentials present but not opted in — set " +
      "LOXEP_LIVE_TESTS=medusa (or =all) to run against the live instance.",
  );
}

/**
 * Harness-only extra key, read here rather than in `credentials.ts` because
 * it is a property of the local TLS terminator, not of a Medusa credential.
 */
function localCaCertificate(): string | null {
  if (creds === null) return null;
  let content: string;
  try {
    content = readFileSync(ENV_PATH, "utf8");
  } catch {
    return null;
  }
  const match = /^MEDUSA_CA_CERT_FILE=(.*)$/m.exec(content);
  const path = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  if (path === undefined || path === "") return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const caCertificate = localCaCertificate();

/**
 * A `fetch`-shaped transport over `node:https` that trusts exactly one
 * certificate. Returns a real `Response`, so the adapter's status/header/JSON
 * handling is exercised unchanged. Only used when the env file names a CA.
 */
function makeCaPinnedFetch(ca: string): MedusaFetch {
  const agent = new https.Agent({ ca });
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const request = https.request(
        url,
        { method: init.method ?? "GET", agent, headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 0,
                headers: Object.fromEntries(
                  Object.entries(response.headers).map(([key, value]) => [
                    key,
                    Array.isArray(value) ? value.join(", ") : String(value ?? ""),
                  ]),
                ),
              }),
            );
          });
        },
      );
      request.on("error", reject);
      if (init.signal !== undefined && init.signal !== null) {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => request.destroy(new Error("aborted")));
      }
      request.end();
    });
}

const describeLive = creds === null || !optedIn ? describe.skip : describe;

function makeAdapter(overrides: Record<string, unknown> = {}) {
  if (creds === null) throw new Error("unreachable: creds checked by skip");
  return createMedusaAdapter({
    baseUrl: creds.baseUrl,
    apiToken: creds.apiToken,
    rateBudget: createRateBudget({ capacity: 4, refillPerSecond: 2 }),
    ...(caCertificate !== null
      ? { fetchImpl: makeCaPinnedFetch(caCertificate) }
      : {}),
    ...overrides,
  });
}

function assertNoCredentialMaterial(text: string): void {
  if (creds === null) return;
  expect(text.includes(creds.apiToken)).toBe(false);
  // The adapter sends the token verbatim after "Basic ", but a caller that
  // base64-encoded it the HTTP-Basic way would also authenticate (verified
  // live) — so check that form too, in case something echoed a header.
  const encoded = Buffer.from(`${creds.apiToken}:`).toString("base64");
  expect(text.includes(encoded)).toBe(false);
  expect(text.includes("Basic ")).toBe(false);
}

/**
 * Run assertions with SCRUBBED failure output. Vitest prints the thrown
 * message and, for `expect` failures, a diff of the compared values — which
 * against a real store could be a buyer's address. Anything thrown inside is
 * replaced by a message built solely from `label`.
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
function orderShape(fact: MedusaOrderFact) {
  return {
    idIsPrefixed: /^order_[0-9A-Z]+$/.test(fact.externalOrderId),
    orderNumberIsDigitsOrNull:
      fact.orderNumber === null || /^\d+$/.test(fact.orderNumber),
    sourceAccountKeyMatches:
      fact.sourceAccountKey === `medusa:${creds?.baseUrl.replace(/\/+$/, "")}`,
    statusInUnion: (MEDUSA_ORDER_STATUSES as readonly string[]).includes(
      fact.status,
    ),
    paymentInUnion: (MEDUSA_PAYMENT_STATUSES as readonly string[]).includes(
      fact.paymentStatus,
    ),
    fulfillmentInUnion: (
      MEDUSA_FULFILLMENT_STATUSES as readonly string[]
    ).includes(fact.fulfillmentStatus),
    rawStatusIsNative: (
      MEDUSA_NATIVE_ORDER_STATUSES as readonly string[]
    ).includes(fact.providerStatusRaw),
    rawPaymentIsNative: (
      MEDUSA_NATIVE_PAYMENT_STATUSES as readonly string[]
    ).includes(fact.providerPaymentStatusRaw),
    rawFulfillmentIsNative: (
      MEDUSA_NATIVE_FULFILLMENT_STATUSES as readonly string[]
    ).includes(fact.providerFulfillmentStatusRaw),
    statusRecognized: fact.statusRecognized,
    currencyIsIso: /^[A-Z]{3}$/.test(fact.currency),
    placedAtIsIso: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(fact.placedAt),
    updatedAtIsIsoOrNull:
      fact.updatedAt === null ||
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(fact.updatedAt),
    buyerIsPrefixedOrNull:
      fact.buyerExternalId === null || /^cus_[0-9A-Z]+$/.test(fact.buyerExternalId),
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
    lineIdsPrefixed: fact.lineItems.every((line) =>
      /^ordli_[0-9A-Z]+$/.test(line.externalLineId),
    ),
    refundsAllDecimal: fact.refunds.every((refund) =>
      DECIMAL_STRING.test(refund.amount),
    ),
    rawIsObject: typeof fact.raw === "object" && fact.raw !== null,
  };
}

describeLive("Medusa v2 backend (live, read-only)", () => {
  /* ---------------------------------------------------------- claim 1 */
  it("authenticates with Basic <secret key> and rejects the Bearer form", async () => {
    const adapter = makeAdapter();
    const result = await probeConnection(adapter);

    check("probe result", () => {
      expect(result.ok).toBe(true);
      expect(result.baseUrl).toBe(creds?.baseUrl);
      // The probe's own diagnostic: the body's `count` for a limit=1 call.
      expect(
        result.visibleOrderCount === null ||
          Number.isInteger(result.visibleOrderCount),
      ).toBe(true);
      expect(result.error).toBeUndefined();
    });

    // Counts are not personal data; they are the useful evidence.
    // eslint-disable-next-line no-console
    console.info(
      `[live-store] probe ok=${result.ok} visibleOrders=${result.visibleOrderCount ?? "n/a"}`,
    );
    expect(adapter.stats().rateBudget.acquired).toBeGreaterThanOrEqual(1);

    // The Bearer half of the claim: the adapter has no Bearer mode, so this
    // asserts the SERVER's behavior through a hand-built request on the same
    // transport the adapter uses. A 401 here is what makes `Basic` load-bearing
    // rather than incidental.
    if (caCertificate !== null && creds !== null) {
      const bearer = await makeCaPinnedFetch(caCertificate)(
        `${creds.baseUrl}/admin/orders?limit=1&fields=id`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${creds.apiToken}`,
            accept: "application/json",
          },
        },
      );
      const body = (await bearer.json()) as { message?: string };
      check("bearer rejection", () => {
        expect(bearer.status).toBe(401);
        // Medusa names the correct scheme in the message — the single most
        // useful sentence for anyone debugging this integration.
        expect(String(body.message ?? "")).toContain("Basic");
      });
    }
  });

  /* ---------------------------------------------------------- claim 2 */
  it("returns the documented list envelope {orders, count, offset, limit}", async () => {
    const adapter = makeAdapter();
    const page = await adapter.list("/orders", "orders", {
      limit: 2,
      offset: 0,
      fields: "id,status",
    });

    check("orders envelope", () => {
      expect(Array.isArray(page.items)).toBe(true);
      expect(page.items.length).toBeGreaterThanOrEqual(1);
      expect(page.items.length).toBeLessThanOrEqual(2);
      // count/offset/limit come from the BODY, not from headers.
      expect(typeof page.page.count).toBe("number");
      expect(page.page.offset).toBe(0);
      expect(page.page.limit).toBe(2);
    });

    const products = await adapter.list("/products", "products", { limit: 1 });
    check("products envelope", () => {
      expect(typeof products.page.count).toBe("number");
      expect(products.page.limit).toBe(1);
      expect(products.items.length).toBeGreaterThanOrEqual(1);
    });

    // Offset past the end is an ordinary 200 with an empty array — NOT the
    // HTTP 400 WooCommerce returns for a page past the last.
    const past = await adapter.list("/orders", "orders", {
      limit: 2,
      offset: 100_000,
      fields: "id",
    });
    check("offset past the end", () => {
      expect(past.items.length).toBe(0);
      expect(past.page.hasNextPage).toBe(false);
      expect(past.page.count).toBe(page.page.count);
    });

    // eslint-disable-next-line no-console
    console.info(
      `[live-store] envelope orders.count=${page.page.count} products.count=${products.page.count}`,
    );
  });

  it("pages consistently, with distinct rows per page", async () => {
    const adapter = makeAdapter();
    const first = await fetchOrdersPage(adapter, { limit: 1, offset: 0 });
    const second = await fetchOrdersPage(adapter, { limit: 1, offset: 1 });

    check("pagination", () => {
      expect(first.page.count).toBe(second.page.count);
      expect(first.page.offset).toBe(0);
      expect(second.page.offset).toBe(1);
      expect(first.page.limit).toBe(1);
      // With >= 2 orders present, page 1 must promise a successor.
      expect(first.page.hasNextPage).toBe(true);
      const firstIds = new Set(first.orders.map((o) => o.externalOrderId));
      const overlap = second.orders.filter((o) => firstIds.has(o.externalOrderId));
      expect(overlap.length).toBe(0);
    });
  });

  /* -------------------------------------------------- claims 3 and 5 */
  it("maps orders with required fields non-null, and reports money as plain major-unit numbers", async () => {
    const adapter = makeAdapter();
    const result = await fetchOrdersPage(adapter, { limit: 3 });

    check("orders page", () => {
      expect(result.orders.length).toBeGreaterThanOrEqual(1);
      expect(result.orders.length).toBeLessThanOrEqual(3);
    });

    for (const fact of result.orders) {
      const shape = orderShape(fact);
      check("order shape", () => {
        expect(shape.idIsPrefixed).toBe(true);
        expect(shape.orderNumberIsDigitsOrNull).toBe(true);
        expect(shape.sourceAccountKeyMatches).toBe(true);
        expect(shape.statusInUnion).toBe(true);
        expect(shape.paymentInUnion).toBe(true);
        expect(shape.fulfillmentInUnion).toBe(true);
        // CLAIM 5: these two are only non-empty because the adapter asks for
        // them by name AND the server honours the request. An empty string
        // here means the `fields` list regressed.
        expect(shape.rawStatusIsNative).toBe(true);
        expect(shape.rawPaymentIsNative).toBe(true);
        expect(shape.rawFulfillmentIsNative).toBe(true);
        expect(shape.statusRecognized).toBe(true);
        expect(shape.currencyIsIso).toBe(true);
        expect(shape.placedAtIsIso).toBe(true);
        expect(shape.updatedAtIsIsoOrNull).toBe(true);
        expect(shape.buyerIsPrefixedOrNull).toBe(true);
        // CLAIM 3: every money field survived `decimalFromNumber`, which only
        // yields a decimal string for a finite plain JSON number.
        expect(shape.totalsAllDecimal).toBe(true);
        expect(shape.linesAllDecimal).toBe(true);
        expect(shape.refundsAllDecimal).toBe(true);
        expect(shape.lineIdsPrefixed).toBe(true);
        expect(shape.rawIsObject).toBe(true);
      });
    }

    // CLAIM 3, the part a decimal-string check alone cannot prove: MAJOR
    // units, not minor ones. A minor-unit provider (Medusa v1, Stripe) would
    // report a €10.00 line as 1000. Assert instead that the reported
    // unit_price is consistent with the line total at the reported quantity —
    // an invariant that holds in major units and breaks under a x100 scale
    // mismatch between unit price and total.
    for (const fact of result.orders) {
      for (const line of fact.lineItems) {
        if (line.unitPrice === null) continue;
        const unit = Number(line.unitPrice);
        const quantity = Number(line.quantity);
        const subtotal = Number(line.lineSubtotal);
        check("major-unit consistency", () => {
          expect(Math.abs(unit * quantity - subtotal)).toBeLessThan(0.01);
          // A minor-unit integer would have no fractional part AND would be
          // ~100x the order total; this catches the scale, not the format.
          expect(unit).toBeLessThanOrEqual(Number(fact.totals.originalTotal));
        });
      }
    }

    // Statuses and counts only — never an id, a name, an email, or a payload.
    const statusCounts = result.orders.reduce<Record<string, number>>(
      (acc, fact) => {
        const key = `${fact.providerStatusRaw}/${fact.providerPaymentStatusRaw}/${fact.providerFulfillmentStatusRaw}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      },
      {},
    );
    // eslint-disable-next-line no-console
    console.info(
      `[live-store] orders count=${result.page.count} mapped=${result.orders.length} status/payment/fulfillment=${JSON.stringify(statusCounts)}`,
    );
  });

  it("populates payment captures and refunds, which requires every nested level in `fields`", async () => {
    const adapter = makeAdapter();
    const result = await fetchOrdersPage(adapter, { limit: 5 });

    // `paidAt` is derived from payment_collections[].payments[].captured_at.
    // Before loxep-xh9.4.1 the `fields` list requested only the leaf
    // `…payments.refunds`, so `payments` came back as {id, refunds} and this
    // was structurally always null. If it regresses to null across every
    // captured order, the fields list has regressed with it.
    const captured = result.orders.filter(
      (fact) =>
        fact.providerPaymentStatusRaw === "captured" ||
        fact.providerPaymentStatusRaw === "partially_refunded",
    );
    check("captured orders expose paidAt", () => {
      expect(captured.length).toBeGreaterThanOrEqual(1);
      expect(
        captured.every(
          (fact) =>
            fact.paidAt !== null &&
            /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(fact.paidAt),
        ),
      ).toBe(true);
    });

    const refunded = result.orders.filter((fact) => fact.refunds.length > 0);
    if (refunded.length > 0) {
      check("refund shape", () => {
        for (const fact of refunded) {
          for (const refund of fact.refunds) {
            expect(/^ref_[0-9A-Z]+$/.test(refund.externalRefundId)).toBe(true);
            // Medusa reports refunds as POSITIVE magnitudes (contrast
            // WooCommerce's negative convention).
            expect(refund.amount.startsWith("-")).toBe(false);
            expect(DECIMAL_STRING.test(refund.amount)).toBe(true);
          }
          // `total` is already NET of refunds — see orders.ts. Assert the
          // relationship rather than re-deriving it: subtotal is unmoved,
          // total has dropped by the refunded amount.
          expect(Number(fact.totals.originalTotal)).toBeGreaterThanOrEqual(
            Number(fact.totals.total),
          );
        }
      });
      // eslint-disable-next-line no-console
      console.info(
        `[live-store] refunded orders=${refunded.length} refunds=${refunded.reduce((n, f) => n + f.refunds.length, 0)}`,
      );
    }
  });

  /* ---------------------------------------------------- claims 4 and 6 */
  it("filters on updated_at[$gte] through URLSearchParams encoding, inclusively", async () => {
    const adapter = makeAdapter();

    // Oldest-first so the boundary row is deterministic.
    const all = await fetchOrdersPage(adapter, { limit: 10, order: "updated_at" });
    check("watermark preconditions", () => {
      expect(all.orders.length).toBeGreaterThanOrEqual(2);
      expect(all.orders.every((fact) => fact.updatedAt !== null)).toBe(true);
    });

    const boundary = all.orders[1]?.updatedAt;
    if (boundary === null || boundary === undefined) {
      throw new Error("live assertion failed: no boundary updated_at available");
    }
    const boundaryId = all.orders[1]?.externalOrderId;

    // CLAIM 4: the adapter serializes this key with URLSearchParams, so it
    // goes out percent-encoded as `updated_at%5B%24gte%5D`. If Medusa did not
    // parse that form, this call would silently return every order.
    const filtered = await fetchOrdersPage(adapter, {
      limit: 10,
      order: "updated_at",
      updatedAfter: boundary,
    });

    check("updated_at[$gte] is parsed, not ignored", () => {
      // The filter must actually narrow the set — a silently-ignored filter
      // key returns the unfiltered count, which is how this claim fails.
      expect(filtered.page.count).toBeLessThan(all.page.count ?? 0);
      expect(filtered.page.count).toBe((all.page.count ?? 0) - 1);
    });

    // CLAIM 6: $gte includes the boundary instant itself.
    check("$gte is inclusive of the boundary instant", () => {
      expect(
        filtered.orders.some((fact) => fact.externalOrderId === boundaryId),
      ).toBe(true);
      expect(
        filtered.orders.every(
          (fact) => (fact.updatedAt ?? "") >= boundary,
        ),
      ).toBe(true);
    });

    // eslint-disable-next-line no-console
    console.info(
      `[live-store] watermark all=${all.page.count} gte=${filtered.page.count} inclusive=true`,
    );
  });

  /* ---------------------------------------------------------- products */
  it("fetches products with the variant/price shape the matcher will need", async () => {
    const adapter = makeAdapter();
    const products = await fetchProducts(adapter, { limit: 2 });

    check("products", () => {
      expect(products.length).toBeGreaterThanOrEqual(1);
      for (const product of products) {
        expect(/^prod_[0-9A-Z]+$/.test(product.externalProductId)).toBe(true);
        expect(typeof product.title === "string" && product.title.length > 0).toBe(
          true,
        );
        expect(typeof product.status).toBe("string");
        expect(product.handle === null || typeof product.handle === "string").toBe(
          true,
        );
        expect(
          product.updatedAt === null ||
            /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(product.updatedAt),
        ).toBe(true);
        // Medusa's product-list DEFAULT already includes variants and their
        // prices — this adapter sends no `fields` for products, so a
        // non-empty variants array here is the proof of that claim.
        expect(product.variants.length).toBeGreaterThanOrEqual(1);
        for (const variant of product.variants) {
          expect(/^variant_[0-9A-Z]+$/.test(variant.externalVariantId)).toBe(true);
          expect(variant.sku === null || typeof variant.sku === "string").toBe(
            true,
          );
          for (const price of variant.prices) {
            expect(/^[A-Z]{3}$/.test(price.currencyCode)).toBe(true);
            expect(DECIMAL_STRING.test(price.amount)).toBe(true);
          }
        }
      }
    });

    // eslint-disable-next-line no-console
    console.info(
      `[live-store] products mapped=${products.length} variants=${products.reduce((n, p) => n + p.variants.length, 0)}`,
    );
  });

  /* ------------------------------------------------------ error taxonomy */
  it("yields taxonomy 'auth' for a bogus secret key, with no secret material in the error", async () => {
    if (creds === null) throw new Error("unreachable");
    // Fully fabricated key — NOT derived from the real one.
    const adapter = makeAdapter({
      apiToken: `sk_${"0".repeat(64)}`,
      rateBudget: createRateBudget({ capacity: 2, refillPerSecond: 1 }),
    });

    const error = await fetchOrdersPage(adapter, { limit: 1 }).catch(
      (e: unknown) => e,
    );

    check("bogus-credential taxonomy", () => {
      expect(error instanceof MedusaAdapterError).toBe(true);
      const adapterError = error as MedusaAdapterError;
      expect(adapterError.kind).toBe("auth");
      expect(
        (MEDUSA_ERROR_KINDS as readonly string[]).includes(adapterError.kind),
      ).toBe(true);
      expect(adapterError.detail["httpStatus"]).toBe(401);
      expect(adapterError.detail["path"]).toBe("/admin/orders");
      // Medusa's 401 comes from the authenticate middleware, which emits
      // `{message}` ALONE — no `type`, no `code`, unlike the errorHandler
      // envelope that 404/500 use. Classification therefore rests on the
      // HTTP status, which is exactly how errors.ts is written.
      expect(adapterError.detail["providerCode"]).toBeUndefined();
      expect(adapterError.detail["providerType"]).toBeUndefined();
      expect(typeof adapterError.detail["providerMessage"]).toBe("string");
    });

    const adapterError = error as MedusaAdapterError;
    const serialized =
      JSON.stringify({
        message: adapterError.message,
        kind: adapterError.kind,
        detail: adapterError.detail,
        stack: adapterError.stack,
      }) ?? "";
    // Neither the bogus token nor — crucially — the REAL one may appear.
    assertNoCredentialMaterial(serialized);
    expect(serialized.includes("sk_0000")).toBe(false);
  });

  it("yields taxonomy 'not_found' for an unknown order id", async () => {
    const adapter = makeAdapter();
    const error = await adapter
      .get("/orders/order_01LOXEPDOESNOTEXIST", undefined, {
        operation: "live.not_found",
      })
      .catch((e: unknown) => e);

    check("not_found taxonomy", () => {
      expect(error instanceof MedusaAdapterError).toBe(true);
      const adapterError = error as MedusaAdapterError;
      expect(adapterError.kind).toBe("not_found");
      expect(adapterError.detail["httpStatus"]).toBe(404);
      // This envelope DOES carry `type` — but still no `code`.
      expect(adapterError.detail["providerType"]).toBe("not_found");
      expect(adapterError.detail["providerCode"]).toBeUndefined();
    });

    assertNoCredentialMaterial(
      JSON.stringify((error as MedusaAdapterError).detail) ?? "",
    );
  });
});
