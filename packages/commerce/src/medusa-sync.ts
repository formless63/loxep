/**
 * Incremental Medusa order sync and its scheduling state — the third sibling
 * of `sync.ts` (WooCommerce) and `ebay-sync.ts`, sharing every piece of
 * scheduling machinery and differing in the `monitor_targets.target_type`
 * (`medusa_orders`), the provider's watermark semantics, and — the one thing
 * genuinely new here — a provider whose filters FAIL OPEN.
 *
 * ## Scheduling: the same `monitor_targets` row, a third target type
 *
 * PROVISIONAL, per design open question 6 (unchanged since the Woo/eBay
 * legs) — no second scheduler, no `commerce_sync_cursors` table, no new
 * column. The cursor lives under the same namespaced `config.commerceSync`
 * key every commerce order-sync leg uses, because the fields ARE the same
 * facts; `sync.ts` owns the read/write helpers and this module passes its
 * own target type to them.
 *
 * Unlike `ebay-sync.ts` when it first shipped, `medusa_orders` is registered
 * in `@loxep/market`'s `MONITOR_TARGET_TYPES` AND `monitorTargetConfigSchemas`
 * from the start (loxep-xxz) — the split-registration gap `ebay_orders` once
 * had (loxep-itn closed it) is deliberately not repeated a third time.
 *
 * ## Watermark discipline — the THIRD variant
 *
 * WooCommerce's `modified_after` is EXCLUSIVE at second precision (rewind
 * mandatory). eBay's `lastmodifieddate` range is INCLUSIVE at millisecond
 * precision (rewind kept as belt-and-braces). Medusa's `updated_at[$gte]` is
 * INCLUSIVE, live-verified on 2.18.0, full ISO-8601 with milliseconds and a
 * `Z` designator. So, like eBay, the stored cursor is the last watermark
 * SEEN — re-reading the boundary order is safe because ingestion is
 * idempotent — and the shared {@link CURSOR_OVERLAP_SECONDS} rewind is kept
 * for the same reason eBay keeps it: a same-instant tie across a page
 * boundary is still possible, and re-reading a small overlap is free while a
 * skipped order is not recoverable without a full re-read. No new constant.
 *
 * ## What is genuinely different: Medusa's filters FAIL OPEN
 *
 * Live-verified on 2.18.0: `updated_at[$nope]=…` and `not_a_field[$gte]=…`
 * BOTH return HTTP 200 with the UNFILTERED result count — a typo in a
 * watermark filter does not error, it silently degrades to a full scan.
 * `packages/integrations/medusa/src/orders.ts`'s `iterateMedusaOrders`
 * already carries the countermeasure: it asserts every returned order's
 * `updated_at >= watermark` and throws a `provider_unavailable`
 * `MedusaAdapterError` (`assertWatermarkHonored`) the instant that invariant
 * is violated, rather than silently accepting an unfiltered page.
 *
 * Because {@link MedusaOrderPageIterator} is bound by the composition root to
 * that exact function, THIS module gets the canary for free — and it MUST
 * NOT re-implement it, wrap it away, or swallow it. No try/catch around
 * `iterateOrders` exists below for exactly that reason: a thrown
 * `MedusaAdapterError` propagates to the caller (`@loxep/app`'s poll
 * executor), which is what turns a poisoned filter into a loud poll failure
 * with backoff instead of a silent, unbounded store scan.
 *
 * For the same reason, `maxPages` here is not politeness but a BLAST-RADIUS
 * BOUND: if a future regression in the adapter's query construction ever
 * defeated the watermark filter without tripping the canary, the page cap is
 * what stops a single poll from walking an entire store. Defaults: per-page
 * {@link DEFAULT_MEDUSA_SYNC_PER_PAGE} (25, comfortably below the adapter's
 * own `MEDUSA_MAX_LIMIT` ceiling), `maxPages` the shared
 * {@link DEFAULT_SYNC_MAX_PAGES} (10).
 *
 * ## The provider seam is a FUNCTION, not an adapter
 *
 * Same boundary direction as `ebay-sync.ts`: this module takes
 * {@link MedusaOrderPageIterator}, a plain async-generator function the
 * composition root binds to `iterateMedusaOrders`. `@loxep/commerce`
 * therefore takes no dependency on `@loxep/integration-medusa` — the
 * `packages/commerce/package.json` manifest needs NO change at all — and a
 * test supplies canned pages without constructing anything provider-shaped.
 */
import type { LoxepDb } from "@loxep/db";
import type { MedusaOrderFactLike } from "./medusa.ts";
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

/** `monitor_targets.target_type` for Medusa order polling. PROVISIONAL. */
export const MEDUSA_ORDERS_TARGET_TYPE = "medusa_orders";

/**
 * Default page size for a Medusa order poll. Comfortably below the adapter's
 * own `MEDUSA_MAX_LIMIT` (200) — a self-hosted backend deserves a polite
 * default, not the adapter's own protective ceiling.
 */
export const DEFAULT_MEDUSA_SYNC_PER_PAGE = 25;

/**
 * The `medusa_orders` target-type config contract. The SAME object as
 * {@link commerceSyncTargetConfigSchema} — a third alias, not a new schema —
 * because the cursor's fields (a watermark, a last-run stamp, a page budget)
 * are provider-neutral facts regardless of which adapter produced them.
 */
export const medusaOrdersTargetConfigSchema = commerceSyncTargetConfigSchema;

export type MedusaOrdersTargetConfig = ReturnType<
  typeof medusaOrdersTargetConfigSchema.parse
>;

/* ------------------------------------------------------------ target rows */

/**
 * Find or create the single `medusa_orders` scheduling row for a connection.
 * Same invariant as the Woo/eBay legs: one order-sync target per connection,
 * enforced by looking before inserting rather than by adding a constraint to
 * `monitor_targets`.
 */
export async function ensureMedusaOrderSyncTarget(
  db: LoxepDb,
  input: EnsureWooOrderSyncTargetInput,
): Promise<CommerceOrderSyncCursor> {
  return ensureOrderSyncTarget(db, {
    ...input,
    targetType: MEDUSA_ORDERS_TARGET_TYPE,
    namePrefix: "Medusa orders",
  });
}

/** Read the stored Medusa cursor for a connection, or null when none exists. */
export async function readMedusaOrderSyncCursor(
  db: LoxepDb,
  connectionId: string,
): Promise<CommerceOrderSyncCursor | null> {
  return readOrderSyncCursor(db, connectionId, MEDUSA_ORDERS_TARGET_TYPE);
}

/* ------------------------------------------------------------------- sync */

/** One page of provider-shaped order facts, as the adapter yields them. */
export interface MedusaOrderPageLike {
  orders: readonly MedusaOrderFactLike[];
}

/**
 * The injected provider boundary. Structurally satisfied by
 * `iterateMedusaOrders(adapter, { updatedAfter, limit }, { maxPages })` from
 * `@loxep/integration-medusa`, bound to a connection by the composition
 * root. Unlike eBay's iterator there is no `includeFulfillments` flag —
 * Medusa's adapter always requests fulfillments as part of its default field
 * list (see that package's module doc), so there is no per-call toggle to
 * carry through here.
 */
export type MedusaOrderPageIterator = (input: {
  connectionId: string;
  modifiedAfter: Date | null;
  perPage: number;
  maxPages: number;
}) => AsyncIterable<MedusaOrderPageLike>;

export interface SyncMedusaOrdersInput {
  connectionId: string;
  /** Override the stored cursor (a backfill, or a forced re-read). */
  modifiedAfter?: Date | null;
  perPage?: number;
  maxPages?: number;
  /** Explicit attribution for orders this run creates. */
  economicEntityId?: string | null;
  actorUserId?: string | null;
  /** Skip cursor persistence (a dry run). */
  persistCursor?: boolean;
  now?: Date;
}

export interface SyncMedusaOrdersResult {
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
}

export interface MedusaOrderSyncService {
  ensureTarget: (
    input: EnsureWooOrderSyncTargetInput,
  ) => Promise<CommerceOrderSyncCursor>;
  readCursor: (connectionId: string) => Promise<CommerceOrderSyncCursor | null>;
  syncConnection: (
    input: SyncMedusaOrdersInput,
  ) => Promise<SyncMedusaOrdersResult>;
}

export function createMedusaOrderSync(options: {
  db: LoxepDb;
  iterateOrders: MedusaOrderPageIterator;
  /** Reuse an already-built ingestion service (tests, composition roots). */
  ingestion?: OrderIngestionService;
}): MedusaOrderSyncService {
  const { db, iterateOrders } = options;
  const ingestion = options.ingestion ?? createOrderIngestionService({ db });

  async function syncConnection(
    input: SyncMedusaOrdersInput,
  ): Promise<SyncMedusaOrdersResult> {
    const cursor = await ensureMedusaOrderSyncTarget(db, {
      connectionId: input.connectionId,
    });
    const perPage =
      input.perPage ?? cursor.perPage ?? DEFAULT_MEDUSA_SYNC_PER_PAGE;
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

    // No try/catch here — see the module doc. A `MedusaAdapterError` thrown
    // by the injected iterator's fail-open canary must propagate untouched.
    for await (const page of iterateOrders({
      connectionId: input.connectionId,
      modifiedAfter,
      perPage,
      maxPages,
    })) {
      pages += 1;
      for (const fact of page.orders) {
        const result = await ingestion.ingestMedusaOrder({
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

    // Medusa's bracket is inclusive, so the rewind is belt-and-braces rather
    // than load-bearing, exactly as it is for eBay; re-reading a small
    // overlap is free and a skipped order is not recoverable without a full
    // re-read.
    const nextModifiedAfter =
      highWatermarkMillis === null
        ? modifiedAfter
        : new Date(highWatermarkMillis - CURSOR_OVERLAP_SECONDS * 1000);

    if (input.persistCursor !== false) {
      // Written explicitly even when `nextModifiedAfter` is null (a first
      // sync that saw zero orders) — the 2026-08-13 live regression this
      // shared cursor writer and its schemas were fixed for.
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
    };
  }

  return {
    ensureTarget: (input) => ensureMedusaOrderSyncTarget(db, input),
    readCursor: (connectionId) => readMedusaOrderSyncCursor(db, connectionId),
    syncConnection,
  };
}
