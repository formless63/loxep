/**
 * Monitor scheduling (loxep-ubx.1): CRUD over `monitor_targets` plus the
 * data-driven due-work claim/poll-outcome primitives (ADR-0003, foundation
 * schema "Monitoring").
 *
 * Scheduling state lives in the database — `interval_seconds`,
 * `next_poll_at`, `priority`, `backoff_until`, `consecutive_errors` — and a
 * small number of recurring dispatcher jobs (see `tasks.ts`) claim due
 * targets. There is never one cron entry per monitored item.
 *
 * ## Claim semantics
 *
 * {@link claimDueTargets} is a single statement:
 *
 * ```sql
 * UPDATE monitor_targets SET next_poll_at = now + interval, ...
 *  WHERE id IN (SELECT id ... WHERE due ORDER BY priority, next_poll_at
 *               LIMIT n FOR UPDATE SKIP LOCKED)
 * RETURNING ...
 * ```
 *
 * `FOR UPDATE SKIP LOCKED` makes concurrent dispatchers partition the due
 * set instead of double-claiming: rows locked by one dispatcher are skipped
 * (not waited on) by the other, and because the claiming UPDATE advances
 * `next_poll_at` before commit, a target can never be claimed twice for the
 * same tick. Smaller `priority` claims first, matching Graphile Worker's
 * priority convention.
 *
 * ## Backoff
 *
 * {@link recordPollFailure} applies capped exponential backoff:
 * `backoff_until = failed_at + min(interval_seconds * 2^consecutive_errors,
 * 3600) seconds`, where `consecutive_errors` is the post-increment count
 * (first failure → 2× interval) and the cap is one hour
 * ({@link MAX_BACKOFF_SECONDS}). {@link recordPollSuccess} resets
 * `consecutive_errors`/`backoff_until`. The dispatcher never claims a target
 * whose `backoff_until` is in the future.
 *
 * ## Adaptive cadence
 *
 * `interval_seconds` is the operator-set BASE cadence and never changes by
 * itself. When a caller reports poll CHANGE information,
 * {@link recordPollSuccess} advances `next_poll_at` by the activity-adaptive
 * interval from `computeAdaptiveInterval` instead of the flat base, and
 * merges the transient streak state into `config.adaptive` — no schema
 * change, no extra table (see `adaptive.ts` for the exact tiers). Callers
 * that report nothing keep the historical flat behaviour, as does a target
 * configured with `config.adaptive.enabled = false`.
 *
 * The claim statement is deliberately untouched: adaptivity is computed at
 * RECORD time, so claim atomicity and at-least-once safety are exactly what
 * they were. The claim's own flat advance remains the safety net that keeps
 * a target scheduled when a poll job dies before recording anything.
 */
import { monitorTargets } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import {
  ADAPTIVE_CONFIG_KEY,
  DEFAULT_ADAPTIVE_SIGNAL_WINDOW_SECONDS,
  adaptiveConfigSchema,
  adaptiveStatePatch,
  evaluateAdaptiveInterval,
  nextUnchangedStreak,
  readAdaptiveState,
} from "./adaptive.ts";
import type { AdaptiveBounds, AdaptiveDecision } from "./adaptive.ts";
import { MarketNotFoundError, MarketValidationError } from "./errors.ts";
import { LISTING_STATE_ENDED } from "./events.ts";
import {
  intLiteral,
  jsonbLiteral,
  textLiteral,
  timestamptzLiteral,
  uuidLiteral,
} from "./sql.ts";

/**
 * Monitor target types; text + TS union, no PG enum (`monitor_targets`
 * `target_type` is a plain `text` column, so adding a type needs no
 * migration). `ebay_search`/`ebay_seller` are the Phase 2 discovery types —
 * they poll through the SAME claim/backoff/adaptive machinery as the Phase 1
 * types; only their executor differs.
 *
 * `woo_orders` and `ebay_orders` are the Phase 3 COMMERCE types and the first
 * entries here that @loxep/market does not own. Domain Boundaries'
 * PROVISIONAL "Scheduling is shared foundation infrastructure" rule makes
 * `monitor_targets` a shared mechanism any domain may register a target type
 * against; Market Intelligence owns the `ebay_watchlist`/`ebay_item`/
 * `ebay_search`/`ebay_seller` discovery types and the mechanism's
 * implementation, not the list. Nothing else about either row is special:
 * their executors live in @loxep/commerce (wired in @loxep/app), their
 * cursors live under the `commerceSync` namespace this package never reads,
 * and claim/backoff/adaptive advancement treat them exactly like any other
 * row. (`ebay_orders` was registered after `woo_orders` — see loxep-itn —
 * closing a gap where `ensureEbayOrderSyncTarget`'s direct insert worked but
 * `createMonitorService` CRUD did not.)
 */
/**
 * `etsy_listing`/`etsy_shop` (loxep-g4t.1) are the Etsy observation types —
 * both public-auth, the Etsy analogues of `ebay_item`/`ebay_seller`. They
 * are registered in this closed list AND `monitorTargetConfigSchemas`
 * TOGETHER, in the same change, deliberately learning from the
 * `ebay_orders` split-registration gap this module's doc calls out above
 * (and again in `packages/app/src/registry.ts`'s module doc) rather than
 * repeating it.
 */
/**
 * REVERB-TARGET-TYPES(loxep-g4t.3): `reverb_listing`/`reverb_shop` are the
 * Reverb observation types, registered in this closed list AND
 * `monitorTargetConfigSchemas` TOGETHER in the same change (same discipline
 * as `etsy_listing`/`etsy_shop` above). `reverb_listing` is the Reverb
 * analogue of `ebay_item`/`etsy_listing` (single listing, any PAT scope
 * that grants public read). `reverb_shop` is NARROWER than `etsy_shop`:
 * this survey did not confirm a public by-shop-slug listings endpoint, so
 * `reverb_shop` always observes the CONNECTED account's own listings (needs
 * `read_listings`) — it carries no shop identity of its own, the target
 * IS the connection, the same "no identity, only cursor/cap" shape
 * `woo_orders`/`etsy_orders` use. See
 * `apps/docs/src/content/docs/architecture/reverb-integration-design.md`.
 */
/**
 * PURCHASE-TARGET-TYPE(loxep-dgf.5): `ebay_purchases` is the Flipping
 * milestone 5 buy-side type — `GetMyeBayBuying`'s `WonList` container,
 * registered by `@loxep/inventory`, executed by `@loxep/inventory`. It is in
 * this closed list AND `monitorTargetConfigSchemas` TOGETHER, in the same
 * change, deliberately learning from the `ebay_orders` split-registration gap
 * this module's doc calls out above (same discipline as `etsy_listing`/
 * `etsy_shop`, `reverb_listing`/`reverb_shop`, and
 * `infrastructure_domain_reconcile`).
 *
 * UNLIKE those four, no `packages/app` poll route exists for it yet:
 * `@loxep/app`'s `package.json` does not declare `@loxep/inventory` as a
 * dependency, so its executor cannot be added without a dependency edit
 * outside this change's write fence. Registering the type here is still
 * correct and non-harmful in the meantime — `createMonitorService` CRUD
 * works, and NOTHING currently creates an `ebay_purchases` row (no settings
 * UI, no app-side `ensureTarget` caller shipped with this change either), so
 * the routing gap has no live consequence until both land together. See
 * `@loxep/inventory`'s `purchase-sync.ts` module doc for the full account.
 */
/**
 * MEDUSA-TARGET-TYPE(loxep-xxz): `medusa_orders` is the Phase 3 COMMERCE
 * order-sync type for a self-hosted Medusa store — the third provider to
 * share `woo_orders`/`ebay_orders`' exact shape (same `commerceSync` cursor
 * namespace, same provider-neutral `commerceSyncTargetConfigSchema` in
 * @loxep/commerce, because the cursor's fields — a watermark, a last-run
 * stamp, a page budget — are provider-neutral facts regardless of which
 * adapter produced them). Registered in this closed list AND
 * `monitorTargetConfigSchemas` TOGETHER, in the same change, per the
 * discipline this module's doc states above — the `ebay_orders`
 * split-registration gap must not recur a third time.
 */
export const MONITOR_TARGET_TYPES = [
  "ebay_watchlist",
  "ebay_item",
  "ebay_search",
  "ebay_seller",
  "woo_orders",
  "ebay_orders",
  "medusa_orders",
  "etsy_listing",
  "etsy_shop",
  "reverb_listing",
  "reverb_shop",
  "ebay_purchases",
  "infrastructure_domain_reconcile",
] as const;
export type MonitorTargetType = (typeof MONITOR_TARGET_TYPES)[number];

/** Exponential-backoff cap: one hour. */
export const MAX_BACKOFF_SECONDS = 3600;

/**
 * Pure backoff formula (exported for tests/documentation):
 * `min(intervalSeconds * 2^consecutiveErrors, 3600)` seconds, where
 * `consecutiveErrors` is the count AFTER the failing poll was recorded.
 * The exponent is clamped so the intermediate product cannot overflow.
 */
export function backoffSeconds(
  intervalSeconds: number,
  consecutiveErrors: number,
): number {
  const exponent = Math.min(Math.max(consecutiveErrors, 0), 20);
  return Math.min(intervalSeconds * 2 ** exponent, MAX_BACKOFF_SECONDS);
}

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a decimal string");

/**
 * The stored form of the eBay integration's small Loxep-owned search filter
 * shape (`EbaySearchFilters` in `@loxep/integration-ebay`). It is
 * re-declared rather than imported: `@loxep/market` owns the scheduling and
 * observation model and must not depend on a provider integration package
 * (ADR-0009's boundary direction). The two shapes are structurally identical
 * by design, so an executor can hand a validated config straight to
 * `searchListings` — the ONE deliberate difference is `listedAfter`, which is
 * an ISO-8601 string here because `config` is jsonb and jsonb has no date
 * type.
 *
 * Provider grammar (`price:[10..50]`, `sellers:{alice|bob}`, …) is encoded by
 * the integration package alone and never appears in a monitor config.
 */
export const ebaySearchFiltersSchema = z.strictObject({
  priceMin: decimalString.optional(),
  priceMax: decimalString.optional(),
  /** ISO-4217; the provider requires it whenever a price bound is set. */
  priceCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  buyingOptions: z
    .array(z.enum(["FIXED_PRICE", "AUCTION", "BEST_OFFER", "CLASSIFIED_AD"]))
    .min(1)
    .optional(),
  conditions: z
    .array(
      z.enum([
        "NEW",
        "USED",
        "UNSPECIFIED",
        "CERTIFIED_REFURBISHED",
        "EXCELLENT_REFURBISHED",
        "VERY_GOOD_REFURBISHED",
        "GOOD_REFURBISHED",
        "SELLER_REFURBISHED",
      ]),
    )
    .min(1)
    .optional(),
  conditionIds: z.array(z.string().regex(/^\d+$/)).min(1).optional(),
  sellers: z.array(z.string().min(1)).min(1).optional(),
  /** ISO-8601 instant; only listings created at/after it are considered. */
  listedAfter: z.iso.datetime().optional(),
});

export type EbaySearchFiltersConfig = z.infer<typeof ebaySearchFiltersSchema>;

/**
 * Namespaced `config` key @loxep/commerce owns on a `woo_orders`/`ebay_orders`
 * row. Declared here only so this package can name the key it must NOT
 * interpret.
 */
export const COMMERCE_SYNC_CONFIG_KEY = "commerceSync";

/**
 * Namespaced `config` key @loxep/infrastructure owns on an
 * `infrastructure_domain_reconcile` row. Declared here only so this package
 * can name the key it must NOT interpret.
 *
 * This is rule two of the three that keep the shared scheduling model from
 * becoming a dumping ground: the scheduler writes only `config.adaptive`,
 * Infrastructure writes only `config.infraSync`, and neither reads the
 * other's.
 */
export const INFRA_SYNC_CONFIG_KEY = "infraSync";

/**
 * The stored form of @loxep/infrastructure's reconcile sweep state.
 *
 * RE-DECLARED, NOT IMPORTED — the same discipline as
 * {@link commerceSyncStateSchema} and {@link ebaySearchFiltersSchema}, for the
 * same reason: @loxep/market owns the scheduling mechanism and must not depend
 * on a domain that registers against it. That direction would make every
 * registering domain a dependency of the scheduler, which is exactly the
 * coupling the registration rule exists to avoid, and the infrastructure
 * design states the constraint from the other side too —
 * "`@loxep/infrastructure` takes no dependency on `@loxep/market`".
 *
 * @loxep/infrastructure's own `infraSyncStateSchema` stays the AUTHORITY; this
 * copy exists so the monitor service can validate a config it is asked to
 * store. The duplication is guarded by a both-sides round-trip test, the way
 * `commerce-sync.test.ts` guards Commerce's.
 *
 * **This is the THIRD domain to register a target type**, and the Commerce
 * design named a third registrant as the trigger for building a runtime
 * registration seam that would remove this structural re-declaration
 * altogether. Phase 7's open question 5 raises the same point and leaves it to
 * the owner. Registering the third copy is the PROVISIONAL choice: the seam is
 * a refactor of a shared mechanism that three domains now depend on, and doing
 * it inside a milestone that also lands a migration, an adapter, and a
 * reconciler would make both changes harder to review. Recorded so the next
 * registrant does not have to rediscover the argument.
 *
 * Every field is optional: a freshly created target has swept nothing yet.
 */
export const infraSyncStateSchema = z.strictObject({
  /** When the last sweep finished, successfully or not. */
  lastSweptAt: z.iso.datetime().optional(),
  /** The `reconcile_runs.id` of the most recent sweep, for the UI's deep link. */
  lastRunId: z.string().uuid().optional(),
  /** Unresolved `dns_drift_findings` the last sweep left behind. */
  lastDriftCount: z.number().int().nonnegative().optional(),
  /**
   * `check` compares and records findings; `apply` also converges the
   * provider. The sweep's default is deliberately the operator's choice per
   * domain, because an unattended `apply` is a different risk posture from an
   * unattended `check`.
   */
  mode: z.enum(["apply", "check"]).optional(),
});
export type InfraSyncState = z.infer<typeof infraSyncStateSchema>;

/**
 * The stored form of @loxep/commerce's order-sync cursor — WooCommerce and
 * eBay share this one provider-neutral shape (`commerceSyncTargetConfigSchema`
 * in @loxep/commerce).
 *
 * RE-DECLARED, NOT IMPORTED — the same discipline as
 * {@link ebaySearchFiltersSchema}, for the same reason and with the same
 * consequence. @loxep/market owns the scheduling mechanism and must not
 * depend on a domain that registers against it (that direction would make
 * every registering domain a dependency of the scheduler, which is exactly
 * the coupling the registration rule exists to avoid). @loxep/commerce's
 * `wooOrdersTargetConfigSchema` stays the AUTHORITY for its own service; this
 * copy exists so the monitor service can validate a config it is asked to
 * store.
 *
 * The duplication is deliberate and guarded: `packages/app`'s
 * `commerce-sync.test.ts` asserts that a config @loxep/commerce writes is
 * accepted here and vice versa, so a drift between the two shapes fails a
 * test rather than a production write. The two differ in exactly one
 * intentional way — Commerce's schema is a `looseObject` (it must pass this
 * package's `adaptive` namespace through untouched without knowing its
 * shape), while this one is strict and names `adaptive` explicitly, because
 * here it IS known.
 *
 * Every field is optional: a freshly created target has no cursor yet, and a
 * first sync with no stored watermark is a deliberate "read the newest slice"
 * rather than an error.
 */
export const commerceSyncStateSchema = z.strictObject({
  /**
   * Watermark handed to the provider's modified-after filter on the next
   * poll. `null` is a legitimate stored value — commerce's cursor writer
   * records it explicitly after a sync that saw zero orders ("no watermark
   * yet"), and rejecting it here poisoned a target's own config after its
   * first empty sync (found live, eBay orders, 2026-08-13).
   */
  modifiedAfter: z.iso.datetime().nullable().optional(),
  /** When the last successful sync finished. */
  lastSyncedAt: z.iso.datetime().optional(),
  /** Orders ingested by the last sync (diagnostic only). */
  lastOrderCount: z.number().int().nonnegative().optional(),
  /** Per-page size override for this connection. */
  perPage: z.number().int().min(1).max(100).optional(),
  /** Page budget override for this connection. */
  maxPages: z.number().int().min(1).max(100).optional(),
});

export type CommerceSyncState = z.infer<typeof commerceSyncStateSchema>;

/**
 * Namespaced `config` key @loxep/inventory owns on an `ebay_purchases` row.
 * Declared here only so this package can name the key it must NOT interpret
 * — the same rule `COMMERCE_SYNC_CONFIG_KEY`/`INFRA_SYNC_CONFIG_KEY` state.
 */
export const PURCHASE_SYNC_CONFIG_KEY = "purchaseSync";

/**
 * The stored form of @loxep/inventory's `ebay_purchases` sync cursor.
 *
 * RE-DECLARED, NOT IMPORTED — the same discipline as
 * {@link commerceSyncStateSchema}/{@link infraSyncStateSchema}, for the same
 * reason: @loxep/market owns the scheduling mechanism and must not depend on
 * a domain that registers against it. @loxep/inventory's own
 * `purchaseSyncStateSchema` stays the AUTHORITY; this copy exists so the
 * monitor service can validate a config it is asked to store.
 */
export const purchaseSyncStateSchema = z.strictObject({
  /**
   * Diagnostic watermark, NOT currently used to filter the provider request
   * (Trading's `WonList` has no documented incremental date filter). `null`
   * is a legitimate stored value — @loxep/inventory's sync writes it
   * explicitly after a run that saw zero purchases — and this field is
   * `nullable().optional()` for the exact reason
   * `commerceSyncStateSchema.modifiedAfter` documents: a schema that REJECTS
   * a stored `null` poisons the target's own config on its next read (the
   * `ebay_orders` null-watermark bug, 2026-08-13 — this copy is written
   * deliberately nullable from the start rather than repeating that fix).
   */
  lastPurchasedAt: z.iso.datetime().nullable().optional(),
  /** When the last successful sync finished. */
  lastSyncedAt: z.iso.datetime().optional(),
  /** Purchase facts ingested by the last sync (diagnostic only). */
  lastPurchaseCount: z.number().int().nonnegative().optional(),
  /** Page budget override for this connection. */
  maxPages: z.number().int().min(1).max(100).optional(),
  /** Per-page size override for this connection. */
  entriesPerPage: z.number().int().min(1).max(200).optional(),
});

export type PurchaseSyncState = z.infer<typeof purchaseSyncStateSchema>;

/**
 * Per-target-type `config` validation. Provider adapters extend these
 * without changing the scheduling model — Phase 2's `ebay_search` and
 * `ebay_seller` add no columns and no tables.
 *
 * Every target type also accepts the namespaced `adaptive` key
 * (`adaptiveConfigSchema`): the scheduler's transient adaptivity state and
 * its `enabled` opt-out live there, so activity-adaptive cadence needs no
 * schema change and no new table.
 *
 * `maxItems` is the discovery types' COST knob: search and seller polls page
 * the provider, and each page spends the connection's rate budget, so the
 * config bounds how far one poll may page.
 */
export const monitorTargetConfigSchemas = {
  /** The watchlist itself is identified by the target's connection. */
  ebay_watchlist: z.strictObject({
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /** A single public listing identified by its external item id. */
  ebay_item: z.strictObject({
    externalItemId: z.string().min(1),
    marketplace: z.string().min(1).optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * A persistent search rule. At least one of `query`/`categoryId` is
   * required: the provider rejects a search with no anchoring criterion, and
   * a filters-only rule ("everything under $20") would be an unbounded crawl
   * rather than a monitor.
   */
  ebay_search: z
    .strictObject({
      query: z.string().min(1).optional(),
      categoryId: z.string().min(1).optional(),
      filters: ebaySearchFiltersSchema.optional(),
      maxItems: z.number().int().positive().max(1000).optional(),
      [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
    })
    .refine(
      (config) =>
        config.query !== undefined || config.categoryId !== undefined,
      {
        message: "ebay_search config needs at least one of query, categoryId",
        path: ["query"],
      },
    ),
  /**
   * Every currently purchasable listing of one seller. `query`/`categoryId`
   * are OPTIONAL narrowing: the provider refuses a filter-only search, so the
   * integration supplies a whole-site anchor when neither is set (see
   * `sellers.ts`). One seller per target, so each keeps its own cadence,
   * backoff, and event provenance.
   */
  ebay_seller: z.strictObject({
    sellerUsername: z.string().min(1),
    query: z.string().min(1).optional(),
    categoryId: z.string().min(1).optional(),
    maxItems: z.number().int().positive().max(1000).optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * One WooCommerce store's incremental ORDER SYNC (Phase 3, PROVISIONAL).
   * Registered by Commerce, executed by Commerce; the store itself is
   * identified by the target's connection, so — like `ebay_watchlist` — the
   * config carries no identity of its own, only the sync cursor under the
   * namespace Commerce owns.
   */
  woo_orders: z.strictObject({
    [COMMERCE_SYNC_CONFIG_KEY]: commerceSyncStateSchema.optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * One eBay seller account's incremental ORDER SYNC (Phase 3, PROVISIONAL).
   * Registered by Commerce, executed by Commerce — structurally identical to
   * `woo_orders` above (same `commerceSync` cursor shape; see
   * `ensureEbayOrderSyncTarget`/`ensureOrderSyncTarget` in @loxep/commerce,
   * which share one provider-neutral config schema) because the cursor's
   * fields are provider-neutral facts. The store/seller itself is identified
   * by the target's connection, so the config carries no identity of its own.
   */
  ebay_orders: z.strictObject({
    [COMMERCE_SYNC_CONFIG_KEY]: commerceSyncStateSchema.optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * One self-hosted Medusa store's incremental ORDER SYNC (Phase 3,
   * PROVISIONAL, loxep-xxz). Registered by Commerce, executed by Commerce —
   * structurally identical to `woo_orders`/`ebay_orders` above (same
   * `commerceSync` cursor shape, referencing {@link commerceSyncStateSchema}
   * rather than re-typing its fields, so `modifiedAfter`'s
   * `z.iso.datetime().nullable().optional()` stays defined in exactly one
   * place). The store itself is identified by the target's connection, so
   * the config carries no identity of its own.
   */
  medusa_orders: z.strictObject({
    [COMMERCE_SYNC_CONFIG_KEY]: commerceSyncStateSchema.optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * A single Etsy listing, identified by its external listing id
   * (loxep-g4t.1). Public auth — the Etsy analogue of `ebay_item`.
   */
  etsy_listing: z.strictObject({
    externalItemId: z.string().min(1),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * One Etsy shop's active listings, identified by the shop's external id
   * (loxep-g4t.1). Public auth by default — the Etsy analogue of
   * `ebay_seller`. Observing a shop the connection does not own is
   * mechanically identical but is the ToS-flagged case the design document
   * raises (`etsy-integration-design.md`, "ToS caution"); `maxItems` bounds
   * how far one poll pages the shop's listings, the same cost knob
   * `ebay_seller`/`ebay_search` use.
   */
  etsy_shop: z.strictObject({
    shopExternalId: z.string().min(1),
    maxItems: z.number().int().positive().max(1000).optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * REVERB-CONFIG-SCHEMAS(loxep-g4t.3): a single Reverb listing, identified
   * by its external listing id. Any PAT scope that grants public read — the
   * Reverb analogue of `ebay_item`/`etsy_listing`.
   */
  reverb_listing: z.strictObject({
    externalItemId: z.string().min(1),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * The connected Reverb account's own listings (needs the `read_listings`
   * PAT scope) — the Reverb analogue of `ebay_seller`/`etsy_shop`, but
   * NARROWER: it always observes the token owner's own account, never an
   * arbitrary third party's (this survey did not confirm a public
   * by-shop-slug listings endpoint — see
   * `reverb-integration-design.md`'s "Monitor target types"). The config
   * therefore carries no shop identity of its own — the shop IS the
   * target's connection, the same "no identity, only cursor/cap" shape
   * `woo_orders`/`ebay_orders` use for their own connection-scoped targets.
   * `maxItems` bounds how far one poll pages the account's listings, the
   * same cost knob `ebay_seller`/`etsy_shop` use.
   */
  reverb_shop: z.strictObject({
    maxItems: z.number().int().positive().max(1000).optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * One eBay account's incremental PURCHASE-HISTORY sync (Flipping milestone
   * 5, loxep-dgf.5, PROVISIONAL). Registered by @loxep/inventory, executed by
   * @loxep/inventory (pending the `packages/app` route — see the
   * `ebay_purchases` note on {@link MONITOR_TARGET_TYPES}). Structurally the
   * same "no identity of its own, only cursor/cap" shape `woo_orders`/
   * `ebay_orders` use — the account is the target's connection.
   */
  ebay_purchases: z.strictObject({
    [PURCHASE_SYNC_CONFIG_KEY]: purchaseSyncStateSchema.optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /**
   * One managed domain's recurring DNS reconcile sweep (Phase 7, loxep-lmy.1,
   * PROVISIONAL). Registered by Infrastructure, executed by Infrastructure;
   * this package neither knows nor reads what the sweep does.
   *
   * The domain it reconciles is NOT in this config: it is
   * `managed_domains.reconcile_target_id`, a real foreign key pointing from
   * Infrastructure at the scheduling row. The design chose that direction
   * deliberately over a `domainId` inside `config`, which would be a JSON
   * reference with no integrity. `connection_id` is set to the domain's DNS
   * provider connection, so backoff and rate-budget reasoning work exactly as
   * they do for every other row.
   *
   * The market-activity ADAPTIVE POLICY MUST BE OPTED OUT on these rows —
   * `config.adaptive.enabled = false`. That flag exists precisely for a target
   * whose cadence should not be driven by marketplace events, and this is its
   * first non-market use: a DNS sweep's right cadence has nothing to do with
   * listing churn.
   */
  infrastructure_domain_reconcile: z.strictObject({
    [INFRA_SYNC_CONFIG_KEY]: infraSyncStateSchema.optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
} as const satisfies Record<MonitorTargetType, z.ZodType>;

export type MonitorTargetRow = typeof monitorTargets.$inferSelect;

const baseTargetFields = {
  targetType: z.enum(MONITOR_TARGET_TYPES),
  name: z.string().min(1),
  connectionId: z.uuid().nullish(),
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().positive(),
  priority: z.number().int().optional(),
  config: z.unknown().optional(),
  nextPollAt: z.date().optional(),
  createdByUserId: z.string().min(1).nullish(),
};

const createTargetSchema = z.strictObject(baseTargetFields);

const updateTargetSchema = z
  .strictObject({
    targetType: baseTargetFields.targetType.optional(),
    name: baseTargetFields.name.optional(),
    connectionId: baseTargetFields.connectionId,
    enabled: z.boolean().optional(),
    intervalSeconds: baseTargetFields.intervalSeconds.optional(),
    priority: z.number().int().optional(),
    config: z.unknown().optional(),
    nextPollAt: z.date().nullish(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "empty update",
  });

export type CreateMonitorTargetInput = z.input<typeof createTargetSchema>;
export type UpdateMonitorTargetInput = z.input<typeof updateTargetSchema>;

function validateConfig(
  targetType: MonitorTargetType,
  config: unknown,
): Record<string, unknown> {
  const schema = monitorTargetConfigSchemas[targetType];
  const result = schema.safeParse(config ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    throw new MarketValidationError(
      `invalid "${targetType}" monitor config: ${issues}`,
    );
  }
  return result.data as Record<string, unknown>;
}

export interface MonitorService {
  createTarget: (input: CreateMonitorTargetInput) => Promise<MonitorTargetRow>;
  getTarget: (targetId: string) => Promise<MonitorTargetRow>;
  listTargets: (filter?: {
    enabled?: boolean;
    targetType?: MonitorTargetType;
  }) => Promise<MonitorTargetRow[]>;
  updateTarget: (
    targetId: string,
    patch: UpdateMonitorTargetInput,
  ) => Promise<MonitorTargetRow>;
  deleteTarget: (targetId: string) => Promise<void>;
}

/** CRUD service over `monitor_targets`. */
/**
 * `db.execute(<string>)` bypasses Drizzle's column mappers, so timestamptz
 * values come back as raw strings; coerce robustly.
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export function createMonitorService(options: { db: LoxepDb }): MonitorService {
  const { db } = options;

  async function getTarget(targetId: string): Promise<MonitorTargetRow> {
    const row = await db.query.monitorTargets.findFirst({
      where: (table, { eq }) => eq(table.id, targetId),
    });
    if (row === undefined) {
      throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
    }
    return row;
  }

  async function createTarget(
    input: CreateMonitorTargetInput,
  ): Promise<MonitorTargetRow> {
    const parsed = createTargetSchema.parse(input);
    const config = validateConfig(parsed.targetType, parsed.config);
    const inserted = await db
      .insert(monitorTargets)
      .values({
        targetType: parsed.targetType,
        name: parsed.name,
        connectionId: parsed.connectionId ?? null,
        enabled: parsed.enabled ?? true,
        intervalSeconds: parsed.intervalSeconds,
        priority: parsed.priority ?? 0,
        // A new monitor is immediately due unless the caller schedules it.
        nextPollAt: parsed.nextPollAt ?? new Date(),
        config,
        createdByUserId: parsed.createdByUserId ?? null,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new MarketNotFoundError("monitor target insert returned no row");
    }
    return row;
  }

  async function listTargets(filter?: {
    enabled?: boolean;
    targetType?: MonitorTargetType;
  }): Promise<MonitorTargetRow[]> {
    return db.query.monitorTargets.findMany({
      where: (table, { and, eq }) => {
        const conditions = [];
        if (filter?.enabled !== undefined) {
          conditions.push(eq(table.enabled, filter.enabled));
        }
        if (filter?.targetType !== undefined) {
          conditions.push(eq(table.targetType, filter.targetType));
        }
        return conditions.length > 0 ? and(...conditions) : undefined;
      },
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    });
  }

  async function updateTarget(
    targetId: string,
    patch: UpdateMonitorTargetInput,
  ): Promise<MonitorTargetRow> {
    const parsed = updateTargetSchema.parse(patch);
    const existing = await getTarget(targetId);

    const targetType = (parsed.targetType ??
      existing.targetType) as MonitorTargetType;
    if (!MONITOR_TARGET_TYPES.includes(targetType)) {
      throw new MarketValidationError(
        `existing target has unknown type "${targetType}"`,
      );
    }
    // Re-validate config whenever the type or the config changes.
    const config =
      parsed.config !== undefined || parsed.targetType !== undefined
        ? validateConfig(targetType, parsed.config ?? existing.config)
        : undefined;

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.targetType !== undefined) set["targetType"] = parsed.targetType;
    if (parsed.name !== undefined) set["name"] = parsed.name;
    if (parsed.connectionId !== undefined) {
      set["connectionId"] = parsed.connectionId;
    }
    if (parsed.enabled !== undefined) set["enabled"] = parsed.enabled;
    if (parsed.intervalSeconds !== undefined) {
      set["intervalSeconds"] = parsed.intervalSeconds;
    }
    if (parsed.priority !== undefined) set["priority"] = parsed.priority;
    if (config !== undefined) set["config"] = config;
    if (parsed.nextPollAt !== undefined) set["nextPollAt"] = parsed.nextPollAt;

    // Primary-key upsert (row is known to exist) — the package's standing
    // pattern for UPDATE without a direct drizzle-orm dependency.
    await db
      .insert(monitorTargets)
      .values({
        id: existing.id,
        targetType: existing.targetType,
        name: existing.name,
        intervalSeconds: existing.intervalSeconds,
      })
      .onConflictDoUpdate({ target: monitorTargets.id, set });
    return getTarget(targetId);
  }

  async function deleteTarget(targetId: string): Promise<void> {
    // Referencing rows (monitor_items, market_events, notification_rules)
    // intentionally RESTRICT the delete; disable the target instead when
    // history must be preserved.
    await getTarget(targetId);
    await db.execute(
      `delete from monitor_targets where id = ${uuidLiteral(targetId)}`,
    );
  }

  return { createTarget, getTarget, listTargets, updateTarget, deleteTarget };
}

/** A row claimed by {@link claimDueTargets} for immediate polling. */
export interface ClaimedTarget {
  id: string;
  connectionId: string | null;
  targetType: string;
  name: string;
  intervalSeconds: number;
  priority: number;
  config: Record<string, unknown>;
  /** The already-advanced next poll time (claim time + interval). */
  nextPollAt: Date;
}

/**
 * Atomically claim up to `limit` due targets and advance their
 * `next_poll_at` by one interval, so concurrent dispatchers never
 * double-claim (see the module doc for the exact semantics). A target is due
 * when it is enabled, `next_poll_at <= now`, and `backoff_until` is null or
 * past.
 */
export async function claimDueTargets(
  db: LoxepDb,
  options: { now?: Date; limit?: number } = {},
): Promise<ClaimedTarget[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;
  const nowLiteral = timestamptzLiteral(now);
  const result = await db.execute(
    `update monitor_targets
        set next_poll_at = ${nowLiteral} + interval_seconds * interval '1 second',
            updated_at = now()
      where id in (
        select id
          from monitor_targets
         where enabled = true
           and next_poll_at is not null
           and next_poll_at <= ${nowLiteral}
           and (backoff_until is null or backoff_until <= ${nowLiteral})
         order by priority asc, next_poll_at asc
         limit ${intLiteral(limit)}
         for update skip locked
      )
      returning id, connection_id, target_type, name, interval_seconds,
                priority, config, next_poll_at`,
  );
  const claimed = result.rows.map((row) => ({
    id: row["id"] as string,
    connectionId: (row["connection_id"] as string | null) ?? null,
    targetType: row["target_type"] as string,
    name: row["name"] as string,
    intervalSeconds: row["interval_seconds"] as number,
    priority: row["priority"] as number,
    config: (row["config"] as Record<string, unknown>) ?? {},
    nextPollAt: toDate(row["next_poll_at"]),
  }));
  // UPDATE ... RETURNING order is not guaranteed to follow the claiming
  // subquery's ORDER BY; re-sort so dispatch order is deterministic.
  claimed.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.nextPollAt.getTime() - b.nextPollAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  return claimed;
}

/** Activity signals derived from stored history for one monitor target. */
export interface AdaptiveSignals {
  /** `market_events` for the target's items inside the window. */
  recentEventCount: number;
  /** Observation `raw_state_hash` deltas inside the window. */
  recentChangeCount: number;
  /** Seconds to the soonest future `listing_ends_at`, or null. */
  secondsUntilListingEnd: number | null;
  /** The window actually used, in seconds. */
  windowSeconds: number;
}

/**
 * Derive the adaptive policy's activity inputs from tables that already
 * exist — `market_events`, `marketplace_item_observations` (hash deltas), and
 * `marketplace_items.listing_ends_at` — for the items linked to a target.
 * One statement, read-only; the policy itself stays pure.
 *
 * An event counts when it is attributed to this target OR concerns one of
 * its actively linked items. Auction proximity only considers items that are
 * still linked, not `ended`, and whose end is in the future.
 */
export async function collectAdaptiveSignals(
  db: LoxepDb,
  monitorTargetId: string,
  options: { now?: Date; windowSeconds?: number } = {},
): Promise<AdaptiveSignals> {
  const now = options.now ?? new Date();
  const windowSeconds =
    options.windowSeconds ?? DEFAULT_ADAPTIVE_SIGNAL_WINDOW_SECONDS;
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new MarketValidationError(
      "windowSeconds must be a positive integer number of seconds",
    );
  }
  const targetLiteral = uuidLiteral(monitorTargetId);
  const nowLiteral = timestamptzLiteral(now);
  const sinceLiteral = timestamptzLiteral(
    new Date(now.getTime() - windowSeconds * 1000),
  );
  const result = await db.execute(
    `with linked as (
        select marketplace_item_id
          from monitor_items
         where monitor_target_id = ${targetLiteral}
           and active = true
      ),
      event_counts as (
        select count(*)::int as n
          from market_events e
         where (
                 e.monitor_target_id = ${targetLiteral}
                 or e.marketplace_item_id in (select marketplace_item_id from linked)
               )
           and e.detected_at > ${sinceLiteral}
           and e.detected_at <= ${nowLiteral}
      ),
      hashes as (
        select o.raw_state_hash,
               lag(o.raw_state_hash) over (
                 partition by o.marketplace_item_id order by o.observed_at
               ) as previous_hash
          from marketplace_item_observations o
         where o.marketplace_item_id in (select marketplace_item_id from linked)
           and o.observed_at > ${sinceLiteral}
           and o.observed_at <= ${nowLiteral}
      ),
      change_counts as (
        select count(*)::int as n
          from hashes
         where raw_state_hash is not null
           and previous_hash is not null
           and raw_state_hash <> previous_hash
      ),
      ends as (
        select min(
                 extract(epoch from (i.listing_ends_at - ${nowLiteral}))
               )::double precision as seconds
          from marketplace_items i
         where i.id in (select marketplace_item_id from linked)
           and i.listing_ends_at is not null
           and i.listing_ends_at >= ${nowLiteral}
           and i.current_state <> ${textLiteral(LISTING_STATE_ENDED)}
      )
      select event_counts.n as event_count,
             change_counts.n as change_count,
             ends.seconds as seconds_until_end
        from event_counts, change_counts, ends`,
  );
  const row = result.rows[0];
  const secondsRaw = row?.["seconds_until_end"];
  return {
    recentEventCount: Number(row?.["event_count"] ?? 0),
    recentChangeCount: Number(row?.["change_count"] ?? 0),
    secondsUntilListingEnd:
      secondsRaw === null || secondsRaw === undefined
        ? null
        : Number(secondsRaw),
    windowSeconds,
  };
}

/**
 * Poll-outcome facts a caller may report to {@link recordPollSuccess}.
 * Supplying `changed` is what opts a call into adaptive advancement.
 */
export interface RecordPollSuccessOptions {
  at?: Date;
  /**
   * Whether this poll observed any change (a `raw_state_hash` delta, a new
   * item, a derived event). Omitted → the historical flat behaviour.
   */
  changed?: boolean;
  /** Seconds to the soonest future `listing_ends_at` for this target. */
  secondsUntilListingEnd?: number | null;
  /** `market_events` count in the recent window (default 0). */
  recentEventCount?: number;
  /** Observation-change count in the recent window (default: 1 if changed). */
  recentChangeCount?: number;
  /**
   * Hard interval bounds. `bounds.minSeconds` is where the caller injects its
   * per-connection RATE BUDGET floor — the eBay executor passes the floor its
   * limiter allows for the connection.
   */
  bounds?: Partial<AdaptiveBounds>;
  /**
   * Derive omitted signals from stored history via
   * {@link collectAdaptiveSignals} (one extra read). Default false: the poll
   * path performs no query a caller did not ask for.
   */
  deriveSignals?: boolean;
  /** Window for derived signals (default one hour). */
  signalWindowSeconds?: number;
}

/** What {@link recordPollSuccess} did with the schedule. */
export interface PollSuccessResult {
  /** The adaptive decision, or null when the flat path ran. */
  adaptive: (AdaptiveDecision & { unchangedStreak: number }) | null;
  /** The stored `next_poll_at` after the adaptive advance, else null. */
  nextPollAt: Date | null;
}

/**
 * Record a successful poll: stamps `last_poll_at`/`last_success_at` and
 * clears `consecutive_errors`/`backoff_until`. Safe to re-run (idempotent
 * for a fixed `at`).
 *
 * When `options.changed` is supplied and the target has not opted out
 * (`config.adaptive.enabled === false`), this also advances `next_poll_at` by
 * the adaptive interval and merges the new streak state into
 * `config.adaptive`. Replaying the same `at` recomputes the identical
 * interval and does not inflate the streak.
 */
export async function recordPollSuccess(
  db: LoxepDb,
  targetId: string,
  options: RecordPollSuccessOptions = {},
): Promise<PollSuccessResult> {
  const at = options.at ?? new Date();
  if (options.changed === undefined) {
    await recordFlatPollSuccess(db, targetId, at);
    return { adaptive: null, nextPollAt: null };
  }

  const target = await db.query.monitorTargets.findFirst({
    where: (table, { eq }) => eq(table.id, targetId),
  });
  if (target === undefined) {
    throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
  }
  const state = readAdaptiveState(target.config);
  if (!state.enabled) {
    await recordFlatPollSuccess(db, targetId, at);
    return { adaptive: null, nextPollAt: null };
  }

  const changed = options.changed;
  let recentEventCount = options.recentEventCount;
  let recentChangeCount = options.recentChangeCount;
  let secondsUntilListingEnd = options.secondsUntilListingEnd;
  if (
    options.deriveSignals === true &&
    (recentEventCount === undefined ||
      recentChangeCount === undefined ||
      secondsUntilListingEnd === undefined)
  ) {
    const signals = await collectAdaptiveSignals(db, targetId, {
      now: at,
      ...(options.signalWindowSeconds === undefined
        ? {}
        : { windowSeconds: options.signalWindowSeconds }),
    });
    recentEventCount ??= signals.recentEventCount;
    recentChangeCount ??= signals.recentChangeCount;
    secondsUntilListingEnd ??= signals.secondsUntilListingEnd;
  }

  const unchangedStreak = nextUnchangedStreak({ state, changed, at });
  const decision = evaluateAdaptiveInterval({
    baseIntervalSeconds: target.intervalSeconds,
    recentEventCount: recentEventCount ?? 0,
    // A changed poll is itself one observed change when nothing else is known.
    recentChangeCount: recentChangeCount ?? (changed ? 1 : 0),
    unchangedStreak,
    secondsUntilListingEnd: secondsUntilListingEnd ?? null,
    previousIntervalSeconds: state.lastComputedInterval,
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
  });

  const atLiteral = timestamptzLiteral(at);
  const patch = jsonbLiteral({
    [ADAPTIVE_CONFIG_KEY]: adaptiveStatePatch({ unchangedStreak, decision, at }),
  });
  const result = await db.execute(
    `update monitor_targets
        set last_poll_at = ${atLiteral},
            last_success_at = ${atLiteral},
            consecutive_errors = 0,
            backoff_until = null,
            next_poll_at = ${atLiteral}
              + ${intLiteral(decision.intervalSeconds)} * interval '1 second',
            config = case
                       when jsonb_typeof(config) = 'object'
                         then case
                                when jsonb_typeof(config -> '${ADAPTIVE_CONFIG_KEY}') = 'object'
                                  then jsonb_set(
                                         config,
                                         '{${ADAPTIVE_CONFIG_KEY}}',
                                         (config -> '${ADAPTIVE_CONFIG_KEY}') || (${patch} -> '${ADAPTIVE_CONFIG_KEY}')
                                       )
                                else config || ${patch}
                              end
                       else ${patch}
                     end,
            updated_at = now()
      where id = ${uuidLiteral(targetId)}
      returning next_poll_at`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
  }
  return {
    adaptive: { ...decision, unchangedStreak },
    nextPollAt: toDate(row["next_poll_at"]),
  };
}

/** The historical flat success bookkeeping (never touches `next_poll_at`). */
async function recordFlatPollSuccess(
  db: LoxepDb,
  targetId: string,
  at: Date,
): Promise<void> {
  const atLiteral = timestamptzLiteral(at);
  const result = await db.execute(
    `update monitor_targets
        set last_poll_at = ${atLiteral},
            last_success_at = ${atLiteral},
            consecutive_errors = 0,
            backoff_until = null,
            updated_at = now()
      where id = ${uuidLiteral(targetId)}
      returning id`,
  );
  if (result.rows.length === 0) {
    throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
  }
}

/**
 * Record a failed poll: stamps `last_poll_at`, increments
 * `consecutive_errors`, and sets `backoff_until` per the capped exponential
 * formula in the module doc (mirrored by {@link backoffSeconds}).
 */
export async function recordPollFailure(
  db: LoxepDb,
  targetId: string,
  options: { at?: Date } = {},
): Promise<{ consecutiveErrors: number; backoffUntil: Date }> {
  const at = timestamptzLiteral(options.at ?? new Date());
  const result = await db.execute(
    `update monitor_targets
        set last_poll_at = ${at},
            consecutive_errors = consecutive_errors + 1,
            backoff_until = ${at}
              + least(
                  interval_seconds::numeric
                    * power(2::numeric, least(consecutive_errors + 1, 20)),
                  ${intLiteral(MAX_BACKOFF_SECONDS)}::numeric
                ) * interval '1 second',
            updated_at = now()
      where id = ${uuidLiteral(targetId)}
      returning consecutive_errors, backoff_until`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
  }
  return {
    consecutiveErrors: row["consecutive_errors"] as number,
    backoffUntil: toDate(row["backoff_until"]),
  };
}
