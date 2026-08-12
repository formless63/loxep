/**
 * Incremental eBay order sync and its scheduling state — the sibling of
 * `sync.ts`, sharing every piece of scheduling machinery with the WooCommerce
 * leg and differing in exactly three places: the `monitor_targets.target_type`
 * (`ebay_orders`), the direction of the provider's date filter, and how the
 * provider page source is supplied.
 *
 * ## Scheduling: the same `monitor_targets` row, a different target type
 *
 * PROVISIONAL, per design open question 6 — no second scheduler, no
 * `commerce_sync_cursors` table, no new column. The cursor lives under the
 * same namespaced `config.commerceSync` key the Woo leg uses, because the
 * fields ARE the same facts; `sync.ts` owns the read/write helpers and this
 * module passes its own target type to them.
 *
 * ### Registration gap a reviewer must know about
 *
 * `woo_orders` is registered in `@loxep/market`'s `MONITOR_TARGET_TYPES` and
 * `monitorTargetConfigSchemas`, so those rows are creatable through
 * `createMonitorService`. **`ebay_orders` is not**, because
 * `packages/market` was outside this change's write fence. The consequence is
 * narrow and non-blocking:
 *
 * ```text
 * works today   ensureEbayOrderSyncTarget()'s direct insert
 *               claimDueTargets / recordPollSuccess / recordPollFailure
 *                 (all target-type-agnostic — they read `target_type` as text)
 *               @loxep/app's routed poll executor
 * does NOT      createMonitorService.createTarget({ targetType: 'ebay_orders' })
 *               — its `targetType` is a closed z.enum
 * ```
 *
 * So scheduled polling works end to end; only monitor-service CRUD over these
 * rows does not. Closing the gap is a two-line edit to `@loxep/market` (the
 * enum plus a `commerceSyncStateSchema` entry) and is filed as a follow-up.
 *
 * ## Watermark discipline — the opposite bracket from WooCommerce
 *
 * eBay's `filter=lastmodifieddate:[<from>..]` range is **INCLUSIVE** on the
 * lower bound, where WordPress's `modified_after` is EXCLUSIVE. That makes the
 * stored cursor safer, not more dangerous: passing back the last watermark
 * SEEN re-reads the boundary order rather than skipping it, and ingestion is
 * idempotent. The one-second rewind from {@link CURSOR_OVERLAP_SECONDS} is
 * kept anyway — eBay's `lastModifiedDate` has millisecond precision, so ties
 * are less likely than with Woo's second-precision stamps, but a page boundary
 * landing between two same-millisecond orders is still possible and re-reading
 * a small overlap is free.
 *
 * ## The provider seam is a FUNCTION, not an adapter
 *
 * `sync.ts` takes a `WooAdapterFactory` and calls `iterateWooOrders` itself,
 * which makes `@loxep/commerce` depend on `@loxep/integration-woo`. This
 * module deliberately does not repeat that: it takes
 * {@link EbayOrderPageIterator}, a plain async-generator function the
 * composition root binds to `iterateEbayOrders`. `@loxep/commerce` therefore
 * has no eBay dependency at all — the same boundary direction that keeps
 * `@loxep/market` free of provider packages — and a test supplies canned pages
 * without constructing anything provider-shaped.
 */
import type { LoxepDb } from "@loxep/db";
import type { EbayOrderFactLike } from "./ebay.ts";
import { createOrderIngestionService } from "./orders.ts";
import type { OrderIngestionService } from "./orders.ts";
import {
  CURSOR_OVERLAP_SECONDS,
  DEFAULT_SYNC_MAX_PAGES,
  commerceSyncTargetConfigSchema,
  ensureOrderSyncTarget,
  readOrderSyncCursor,
  writeOrderSyncCursor,
} from "./sync.ts";
import type {
  CommerceOrderSyncCursor,
  EnsureWooOrderSyncTargetInput,
} from "./sync.ts";

/** `monitor_targets.target_type` for eBay order polling. PROVISIONAL. */
export const EBAY_ORDERS_TARGET_TYPE = "ebay_orders";

/**
 * Default page size for an eBay order poll. Smaller than eBay's 200 cap on
 * purpose: `includeFulfillments` spends one extra call PER ORDER, so the page
 * size is also the worst-case call count for one page.
 */
export const DEFAULT_EBAY_SYNC_PER_PAGE = 25;

/**
 * The `ebay_orders` target-type config contract. Structurally identical to
 * the `woo_orders` one — see {@link commerceSyncTargetConfigSchema} — because
 * the cursor's fields are provider-neutral facts.
 */
export const ebayOrdersTargetConfigSchema = commerceSyncTargetConfigSchema;

export type EbayOrdersTargetConfig = ReturnType<
  typeof ebayOrdersTargetConfigSchema.parse
>;

/* ------------------------------------------------------------ target rows */

/**
 * Find or create the single `ebay_orders` scheduling row for a connection.
 * Same invariant as the Woo leg: one order-sync target per connection,
 * enforced by looking before inserting rather than by adding a constraint to
 * `monitor_targets`.
 */
export async function ensureEbayOrderSyncTarget(
  db: LoxepDb,
  input: EnsureWooOrderSyncTargetInput,
): Promise<CommerceOrderSyncCursor> {
  return ensureOrderSyncTarget(db, {
    ...input,
    targetType: EBAY_ORDERS_TARGET_TYPE,
    namePrefix: "eBay orders",
  });
}

/** Read the stored eBay cursor for a connection, or null when none exists. */
export async function readEbayOrderSyncCursor(
  db: LoxepDb,
  connectionId: string,
): Promise<CommerceOrderSyncCursor | null> {
  return readOrderSyncCursor(db, connectionId, EBAY_ORDERS_TARGET_TYPE);
}

/* ------------------------------------------------------------------- sync */

/** One page of provider-shaped order facts, as the adapter yields them. */
export interface EbayOrderPageLike {
  orders: readonly EbayOrderFactLike[];
}

/**
 * The injected provider boundary. Structurally satisfied by
 * `iterateEbayOrders(adapter, input, options)` from
 * `@loxep/integration-ebay`, bound to a connection by the composition root.
 */
export type EbayOrderPageIterator = (input: {
  connectionId: string;
  modifiedAfter: Date | null;
  perPage: number;
  maxPages: number;
  includeFulfillments: boolean;
}) => AsyncIterable<EbayOrderPageLike>;

export interface SyncEbayOrdersInput {
  connectionId: string;
  /** Override the stored cursor (a backfill, or a forced re-read). */
  modifiedAfter?: Date | null;
  perPage?: number;
  maxPages?: number;
  /**
   * Read each order's shipments (one extra provider call per shipped order).
   * Default true: eBay reports REAL fulfillment objects, and the alternative
   * is an order marked `fulfilled` with no shipment rows behind it.
   */
  includeFulfillments?: boolean;
  /** Explicit attribution for orders this run creates. */
  economicEntityId?: string | null;
  actorUserId?: string | null;
  /** Skip cursor persistence (a dry run). */
  persistCursor?: boolean;
  now?: Date;
}

export interface SyncEbayOrdersResult {
  connectionId: string;
  monitorTargetId: string;
  pages: number;
  ordersSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  duplicatesMarked: number;
  /** The watermark handed to this run, or null for a full read. */
  modifiedAfter: Date | null;
  /** The watermark stored for the next run. */
  nextModifiedAfter: Date | null;
  /** Distinct order currencies observed — the no-FX grouping key. */
  currencies: string[];
  /** Orders whose provider status vocabulary this adapter did not recognize. */
  unrecognizedStatuses: string[];
}

export interface EbayOrderSyncService {
  ensureTarget: (
    input: EnsureWooOrderSyncTargetInput,
  ) => Promise<CommerceOrderSyncCursor>;
  readCursor: (connectionId: string) => Promise<CommerceOrderSyncCursor | null>;
  syncConnection: (input: SyncEbayOrdersInput) => Promise<SyncEbayOrdersResult>;
}

export function createEbayOrderSync(options: {
  db: LoxepDb;
  iterateOrders: EbayOrderPageIterator;
  /** Reuse an already-built ingestion service (tests, composition roots). */
  ingestion?: OrderIngestionService;
}): EbayOrderSyncService {
  const { db, iterateOrders } = options;
  const ingestion = options.ingestion ?? createOrderIngestionService({ db });

  async function syncConnection(
    input: SyncEbayOrdersInput,
  ): Promise<SyncEbayOrdersResult> {
    const cursor = await ensureEbayOrderSyncTarget(db, {
      connectionId: input.connectionId,
    });
    const perPage =
      input.perPage ?? cursor.perPage ?? DEFAULT_EBAY_SYNC_PER_PAGE;
    const maxPages = input.maxPages ?? cursor.maxPages ?? DEFAULT_SYNC_MAX_PAGES;
    const modifiedAfter =
      input.modifiedAfter === undefined
        ? cursor.modifiedAfter
        : input.modifiedAfter;

    let pages = 0;
    let ordersSeen = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let duplicatesMarked = 0;
    let highWatermarkMillis: number | null = null;
    const currencies = new Set<string>();
    const unrecognizedStatuses = new Set<string>();

    for await (const page of iterateOrders({
      connectionId: input.connectionId,
      modifiedAfter,
      perPage,
      maxPages,
      includeFulfillments: input.includeFulfillments ?? true,
    })) {
      pages += 1;
      for (const fact of page.orders) {
        const result = await ingestion.ingestEbayOrder({
          connectionId: input.connectionId,
          fact,
          ...(input.economicEntityId === undefined
            ? {}
            : { economicEntityId: input.economicEntityId }),
          ...(input.actorUserId === undefined
            ? {}
            : { actorUserId: input.actorUserId }),
          ...(input.now === undefined ? {} : { now: input.now }),
        });
        ordersSeen += 1;
        if (result.created) created += 1;
        else if (result.effect === "updated") updated += 1;
        else unchanged += 1;
        if (result.duplicateOfOrderId !== null) duplicatesMarked += 1;
        if (fact.currency !== "") currencies.add(fact.currency.toUpperCase());
        // `unknown` is the adapter's honest floor, and a run full of them is
        // the signal that eBay's vocabulary moved. Surfaced, not swallowed.
        if (fact.fulfillmentStatus === "unknown") {
          unrecognizedStatuses.add(fact.providerStatusRaw);
        }
        if (fact.updatedAt !== null) {
          const millis = new Date(fact.updatedAt).getTime();
          if (
            !Number.isNaN(millis) &&
            (highWatermarkMillis === null || millis > highWatermarkMillis)
          ) {
            highWatermarkMillis = millis;
          }
        }
      }
    }

    // eBay's range bracket is inclusive, so the rewind is belt-and-braces
    // rather than load-bearing; re-reading a small overlap is free and a
    // skipped order is not recoverable without a full re-read.
    const nextModifiedAfter =
      highWatermarkMillis === null
        ? modifiedAfter
        : new Date(highWatermarkMillis - CURSOR_OVERLAP_SECONDS * 1000);

    if (input.persistCursor !== false) {
      await writeOrderSyncCursor(db, cursor.monitorTargetId, {
        modifiedAfter: nextModifiedAfter,
        lastSyncedAt: input.now ?? new Date(),
        lastOrderCount: ordersSeen,
      });
    }

    return {
      connectionId: input.connectionId,
      monitorTargetId: cursor.monitorTargetId,
      pages,
      ordersSeen,
      created,
      updated,
      unchanged,
      duplicatesMarked,
      modifiedAfter,
      nextModifiedAfter,
      currencies: [...currencies].sort(),
      unrecognizedStatuses: [...unrecognizedStatuses].sort(),
    };
  }

  return {
    ensureTarget: (input) => ensureEbayOrderSyncTarget(db, input),
    readCursor: (connectionId) => readEbayOrderSyncCursor(db, connectionId),
    syncConnection,
  };
}
