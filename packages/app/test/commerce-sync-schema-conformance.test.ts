/**
 * Conformance test between the STRUCTURALLY RE-DECLARED copies of two
 * scheduling-config schemas (loxep-6xl), pure Zod, no database and no
 * worker runtime — a lighter companion to `commerce-sync.test.ts`, which
 * proves the SAME drift guard end to end through a real poll.
 *
 * ## Why this lives here, not in `packages/commerce/test/`
 *
 * The bd issue's literal ask was a conformance test in
 * `packages/commerce/test/`, importable by "one side's test suite". That is
 * infeasible under this sweep's write fence: `@loxep/commerce` does not
 * depend on `@loxep/market` (deliberately — see `sync.ts`'s module doc, "
 * `@loxep/commerce` deliberately does not depend on `@loxep/market`"), so a
 * test inside that package cannot import market's copy without adding a
 * `@loxep/market` dependency to `packages/commerce/package.json` and
 * relinking the workspace — both outside this sweep's fence (no
 * `package.json`/`bun.lock` edits). `@loxep/app` already depends on both
 * `@loxep/commerce` and `@loxep/market` (and `@loxep/inventory`), which is
 * exactly why `commerce-sync.test.ts` already lives here and already
 * exercises the `woo_orders` half of this drift guard end to end. This file
 * adds the missing PURE-SCHEMA coverage next to it: every target type that
 * carries a re-declared config schema, round-tripped through a canonical
 * fixture set on both sides, with no DB/worker cost.
 *
 * ## What is duplicated, and why
 *
 * Three domains register FOUR target types against `@loxep/market`'s shared
 * `monitor_targets` scheduling model, and each domain's config schema is
 * RE-DECLARED (not imported) inside `@loxep/market`'s
 * `monitorTargetConfigSchemas`, because the scheduler must not take a
 * dependency on every domain that registers against it:
 *
 *   - `woo_orders` / `ebay_orders` / `medusa_orders` — @loxep/commerce's
 *     `commerceSync` cursor (`wooOrdersTargetConfigSchema` /
 *     `ebayOrdersTargetConfigSchema` / `medusaOrdersTargetConfigSchema`, all
 *     THE SAME OBJECT per `sync.ts`/`medusa-sync.ts` — the cursor's fields
 *     are provider-neutral facts regardless of which adapter produced them).
 *   - `ebay_purchases` — @loxep/inventory's `purchaseSync` cursor
 *     (`purchaseSyncTargetConfigSchema`, `purchase-sync.ts`).
 *
 * The `commerceSync` pair drifted on nullability once already (the
 * `modifiedAfter: null` incident, `ebay_orders`, 2026-08-13 — market's copy
 * was fixed first, the executor-facing package's own copy was the second
 * half of the same bug). `purchaseSyncStateSchema`'s `lastPurchasedAt` was
 * written nullable from the start specifically citing that incident; this
 * test is what makes a FUTURE repeat of either fail loudly here instead of
 * live. `medusa_orders` (loxep-xxz) is a THIRD alias of the exact same
 * object as `woo_orders`/`ebay_orders`, so its pair is a tautology on day
 * one — the point is that it starts failing the day someone specializes the
 * Medusa copy instead of reusing `commerceSyncTargetConfigSchema`.
 */
import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_CONFIG_KEY,
  COMMERCE_SYNC_CONFIG_KEY,
  monitorTargetConfigSchemas,
} from "@loxep/market";
import {
  ebayOrdersTargetConfigSchema,
  medusaOrdersTargetConfigSchema,
  wooOrdersTargetConfigSchema,
} from "@loxep/commerce";
import {
  PURCHASE_SYNC_CONFIG_KEY,
  purchaseSyncTargetConfigSchema,
} from "@loxep/inventory";

/** A schema pair that is supposed to accept/reject identically. */
interface SchemaPair {
  label: string;
  market: { safeParse: (input: unknown) => { success: boolean } };
  owner: { safeParse: (input: unknown) => { success: boolean } };
}

function assertBothAgree(pair: SchemaPair, config: unknown, expected: boolean): void {
  const marketResult = pair.market.safeParse(config).success;
  const ownerResult = pair.owner.safeParse(config).success;
  expect(
    marketResult,
    `${pair.label}: @loxep/market's copy on ${JSON.stringify(config)}`,
  ).toBe(expected);
  expect(
    ownerResult,
    `${pair.label}: the owning package's copy on ${JSON.stringify(config)}`,
  ).toBe(expected);
}

describe("commerceSync (woo_orders / ebay_orders / medusa_orders) schema conformance", () => {
  const pairs: SchemaPair[] = [
    {
      label: "woo_orders",
      market: monitorTargetConfigSchemas.woo_orders,
      owner: wooOrdersTargetConfigSchema,
    },
    {
      label: "ebay_orders",
      market: monitorTargetConfigSchemas.ebay_orders,
      owner: ebayOrdersTargetConfigSchema,
    },
    {
      label: "medusa_orders",
      market: monitorTargetConfigSchemas.medusa_orders,
      owner: medusaOrdersTargetConfigSchema,
    },
  ];

  const acceptedFixtures: Record<string, unknown>[] = [
    {},
    { [COMMERCE_SYNC_CONFIG_KEY]: {} },
    // The null-watermark shape the live incident was about: a sync that saw
    // zero orders writes this explicitly, and it must round-trip.
    { [COMMERCE_SYNC_CONFIG_KEY]: { modifiedAfter: null } },
    // The field simply absent — the OTHER legitimate "no watermark yet".
    { [COMMERCE_SYNC_CONFIG_KEY]: { lastOrderCount: 0 } },
    {
      [COMMERCE_SYNC_CONFIG_KEY]: {
        modifiedAfter: "2026-08-01T00:00:00.000Z",
        lastSyncedAt: "2026-08-01T00:05:00.000Z",
        lastOrderCount: 12,
        perPage: 20,
        maxPages: 10,
      },
    },
    // The scheduler's own namespace travels alongside on every real row.
    {
      [COMMERCE_SYNC_CONFIG_KEY]: { lastOrderCount: 3 },
      [ADAPTIVE_CONFIG_KEY]: { enabled: false, unchangedStreak: 2 },
    },
  ];

  const rejectedFixtures: Record<string, unknown>[] = [
    // A typo inside the namespace.
    { [COMMERCE_SYNC_CONFIG_KEY]: { modifedAfter: "2026-08-01T00:00:00.000Z" } },
    // Not a date string.
    { [COMMERCE_SYNC_CONFIG_KEY]: { modifiedAfter: "not-a-date" } },
    // Below the documented per-page floor.
    { [COMMERCE_SYNC_CONFIG_KEY]: { perPage: 0 } },
    // Above the documented per-page ceiling.
    { [COMMERCE_SYNC_CONFIG_KEY]: { perPage: 101 } },
  ];

  for (const pair of pairs) {
    describe(pair.label, () => {
      it.each(acceptedFixtures)("accepts on BOTH sides: %j", (config) => {
        assertBothAgree(pair, config, true);
      });
      it.each(rejectedFixtures)("rejects on BOTH sides: %j", (config) => {
        assertBothAgree(pair, config, false);
      });
    });
  }
});

describe("purchaseSync (ebay_purchases) schema conformance", () => {
  const pair: SchemaPair = {
    label: "ebay_purchases",
    market: monitorTargetConfigSchemas.ebay_purchases,
    owner: purchaseSyncTargetConfigSchema,
  };

  it("both sides agree the config key is 'purchaseSync'", () => {
    expect(PURCHASE_SYNC_CONFIG_KEY).toBe("purchaseSync");
  });

  const acceptedFixtures: Record<string, unknown>[] = [
    {},
    { [PURCHASE_SYNC_CONFIG_KEY]: {} },
    // The null-watermark shape, written deliberately from the start citing
    // the ebay_orders incident (see purchase-sync.ts's module doc).
    { [PURCHASE_SYNC_CONFIG_KEY]: { lastPurchasedAt: null } },
    { [PURCHASE_SYNC_CONFIG_KEY]: { lastPurchaseCount: 0 } },
    {
      [PURCHASE_SYNC_CONFIG_KEY]: {
        lastPurchasedAt: "2026-08-01T00:00:00.000Z",
        lastSyncedAt: "2026-08-01T04:00:00.000Z",
        lastPurchaseCount: 3,
        maxPages: 5,
        entriesPerPage: 50,
      },
    },
    {
      [PURCHASE_SYNC_CONFIG_KEY]: { lastPurchaseCount: 0 },
      [ADAPTIVE_CONFIG_KEY]: { enabled: true, unchangedStreak: 1 },
    },
  ];

  const rejectedFixtures: Record<string, unknown>[] = [
    { [PURCHASE_SYNC_CONFIG_KEY]: { lastPurchsedAt: "2026-08-01T00:00:00.000Z" } },
    { [PURCHASE_SYNC_CONFIG_KEY]: { lastPurchasedAt: "not-a-date" } },
    { [PURCHASE_SYNC_CONFIG_KEY]: { entriesPerPage: 0 } },
    { [PURCHASE_SYNC_CONFIG_KEY]: { entriesPerPage: 201 } },
    { [PURCHASE_SYNC_CONFIG_KEY]: { maxPages: 101 } },
  ];

  it.each(acceptedFixtures)("accepts on BOTH sides: %j", (config) => {
    assertBothAgree(pair, config, true);
  });
  it.each(rejectedFixtures)("rejects on BOTH sides: %j", (config) => {
    assertBothAgree(pair, config, false);
  });
});
