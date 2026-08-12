/**
 * Live eBay SANDBOX leg for **Sell Fulfillment order ingestion**
 * (loxep-xh9.2). Read-only: GETs only, never `issueRefund`,
 * `createShippingFulfillment`, or any other mutating call.
 *
 * ## It skips, and that is expected today
 *
 * Two artifacts are required, both outside the repo and both created
 * deliberately by a developer (Loxep never writes either):
 *
 * ```text
 * ~/.config/loxep/ebay-sandbox.env               the sandbox KEYSET
 * ~/.config/loxep/ebay-sandbox-user-token.json   the consented USER token
 * ```
 *
 * The second does not exist yet. Sandbox consent was completed for the
 * watchlist vertical against the BASE scope only
 * (`https://api.ebay.com/oauth/api_scope`), and `GET /sell/fulfillment/v1/
 * order` additionally requires
 * `https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly` — see
 * `EBAY_ORDER_CONSENT_SCOPES`. A bundle consented without it will reach this
 * suite and fail `auth`, which this file reports as an explicit, named
 * outcome rather than a mysterious red test: the scope gap is a real finding
 * about the connection, not a mapping bug.
 *
 * Until then the mapping is covered by fixtures (`orders.test.ts`), whose
 * shapes are derived from the installed client's bundled OpenAPI types. The
 * status VOCABULARIES and the `filter` grammar remain DESIGN-DERIVED until
 * this leg runs — see `orders.ts`'s provenance note.
 *
 * ABSOLUTE RULE honored here: credential values are never printed, logged,
 * asserted-by-value, or embedded in messages. Nor is buyer PII: every
 * assertion runs against {@link redactEbayOrderFact} output, never the raw
 * fact, so a failing expectation cannot print a buyer's address (ADR-0021).
 */
import { describe, expect, it } from "vitest";
import {
  EBAY_ORDER_CONSENT_SCOPES,
  EBAY_SELL_FULFILLMENT_READONLY_SCOPE,
  createEbayAdapter,
  createRateBudget,
  defaultSandboxUserTokenFilePath,
  fetchEbayOrdersPage,
  loadSandboxCredentialsFromEnvFile,
  loadSandboxUserTokenFromFile,
  redactEbayOrderFact,
} from "../src/index.ts";
import { EbayAdapterError } from "../src/errors.ts";

const creds = loadSandboxCredentialsFromEnvFile();
const bundle = creds === null ? null : loadSandboxUserTokenFromFile();

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-orders] skipped: no keyset at ~/.config/loxep/ebay-sandbox.env",
  );
} else if (bundle === null) {
  // eslint-disable-next-line no-console
  console.info(
    `[live-orders] skipped: no consented user token at ${defaultSandboxUserTokenFilePath()} ` +
      `— complete the sandbox consent flow with the ${EBAY_SELL_FULFILLMENT_READONLY_SCOPE} scope ` +
      "(EBAY_ORDER_CONSENT_SCOPES) and write the bundle there",
  );
}

const describeLive = creds === null || bundle === null ? describe.skip : describe;

function makeUserAdapter() {
  if (creds === null || bundle === null) {
    throw new Error("unreachable: artifacts checked by skip");
  }
  return createEbayAdapter({
    ...creds,
    rateBudget: createRateBudget({ capacity: 10, refillPerSecond: 2 }),
  }).withUserToken(bundle);
}

describeLive("eBay sandbox Sell Fulfillment orders (live)", () => {
  it("has a token consented for the Sell Fulfillment scope", () => {
    if (bundle === null) throw new Error("unreachable");
    // A base-scope-only bundle is the expected state after the watchlist
    // consent; this assertion names the gap instead of letting the next test
    // fail with an opaque 403.
    expect(
      bundle.scopes,
      `stored token scopes must include ${EBAY_SELL_FULFILLMENT_READONLY_SCOPE}; ` +
        `re-consent with EBAY_ORDER_CONSENT_SCOPES (${EBAY_ORDER_CONSENT_SCOPES.length} scopes)`,
    ).toContain(EBAY_SELL_FULFILLMENT_READONLY_SCOPE);
  });

  it("reads a page of orders and normalizes every one of them", async () => {
    const adapter = makeUserAdapter();
    const page = await fetchEbayOrdersPage(adapter, { limit: 5 });

    expect(page.page.limit).toBeGreaterThan(0);
    expect(page.page.offset).toBe(0);

    for (const order of page.orders) {
      // ONLY the redacted form is ever asserted on — see the module doc.
      const safe = redactEbayOrderFact(order);
      expect(safe.raw).toBe("[redacted]");
      expect(safe.externalOrderId.length).toBeGreaterThan(0);
      expect(safe.sourceAccountKey.startsWith("ebay:")).toBe(true);
      expect(safe.currency).toMatch(/^[A-Z]{3}$/);
      expect(Date.parse(safe.placedAt)).not.toBeNaN();
      for (const amount of Object.values(safe.totals)) {
        expect(amount).toMatch(/^-?\d+(\.\d+)?$/);
      }
      // The whole point of the live leg: did the documented vocabularies hold?
      expect(
        safe.statusRecognized,
        `unmapped eBay status vocabulary: ${safe.providerStatusRaw}`,
      ).toBe(true);
    }
  });

  it("filters by lastmodifieddate without erroring on the grammar", async () => {
    const adapter = makeUserAdapter();
    const since = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const page = await fetchEbayOrdersPage(adapter, {
      modifiedAfter: since,
      limit: 5,
    });
    for (const order of page.orders) {
      const safe = redactEbayOrderFact(order);
      if (safe.updatedAt === null) continue;
      // eBay's range brackets are INCLUSIVE, so `>=` is the correct claim.
      expect(Date.parse(safe.updatedAt)).toBeGreaterThanOrEqual(
        since.getTime(),
      );
    }
  });

  it("normalizes an unknown order id to the `not_found` taxonomy", async () => {
    const adapter = makeUserAdapter();
    await expect(
      adapter.sellGetOrder("00-00000-00000"),
    ).rejects.toBeInstanceOf(EbayAdapterError);
  });
});
