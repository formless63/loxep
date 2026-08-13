/**
 * eBay buy-side purchase ingestion (Flipping milestone 5, loxep-dgf.5):
 * `WonList` purchase facts → `provider_objects` (provenance) →
 * `acquisitions` + `acquisition_costs`, in `status = 'draft'`, and STOPS.
 *
 * See `apps/docs/src/content/docs/architecture/flipping-lifecycle-design.md`
 * section 2a for the full design; this module implements its "Ingestion
 * shape" and "Idempotency" subsections.
 *
 * ## An ingested purchase does not become inventory
 *
 * This is the rule that keeps the feature from being actively harmful. A
 * reseller's eBay purchase history contains resale goods, shipping supplies,
 * repair parts, a birthday present, and their own replacement laptop charger.
 * Auto-minting an `inventory_items` row per purchase would fill the stock
 * ledger with things that are not stock, each carrying a cost basis. So this
 * module creates the acquisition and its costs and NEVER calls
 * `@loxep/inventory`'s items service — turning a draft acquisition's contents
 * into stock is the M4 intake-review queue's job (`@loxep/documents`'
 * `document_line_candidates`, per the design), not this sync's.
 *
 * `@loxep/documents`/the M4 intake queue had not shipped when this module was
 * written (loxep-dgf.4 is still open, blocked on an owner review). Until it
 * does, an ingested purchase's REVIEWABLE UNIT is the `draft` acquisition
 * itself — visible in the existing acquisitions list, its costs inspectable
 * and its lot allocatable — rather than a per-line intake candidate. Nothing
 * about this module's writes needs to change when the M4 queue lands: it is
 * additive on top of an acquisition that already exists.
 *
 * ## Scheduling: the shared `monitor_targets` model, PROVISIONAL
 *
 * Same shape `@loxep/commerce`'s `sync.ts`/`ebay-sync.ts` use for
 * `woo_orders`/`ebay_orders`: the target type is `ebay_purchases`, its cursor
 * lives under a namespaced `config.purchaseSync` key nothing else reads or
 * writes, and the row is written with a direct insert rather than through
 * `@loxep/market`'s `createMonitorService` — `@loxep/inventory` deliberately
 * does not depend on `@loxep/market` (the same boundary argument
 * `ebay-sync.ts`'s module doc makes), and `claimDueTargets` /
 * `recordPollSuccess` / `recordPollFailure` are type-agnostic over
 * `target_type` regardless. `ebay_purchases` IS registered in
 * `@loxep/market`'s `MONITOR_TARGET_TYPES` and `monitorTargetConfigSchemas`
 * (structurally re-declared, not imported — see that module) so
 * `createMonitorService` CRUD works for these rows from day one, learning
 * from the `ebay_orders` split-registration gap rather than repeating it.
 *
 * Cadence is measured in HOURS (`DEFAULT_PURCHASE_SYNC_INTERVAL_SECONDS`),
 * not the 60-second monitor baseline — purchase history is not a price feed.
 *
 * ## KNOWN GAP: `@loxep/app` has no route for `ebay_purchases` yet
 *
 * The design's scheduling item calls for a poll executor in `@loxep/app`
 * routing `ebay_purchases` to this module's `syncConnection`, mirroring
 * `commerce-ebay.ts`'s `ebay_orders` branch exactly. `@loxep/app`'s
 * `package.json` does not currently declare `@loxep/inventory` as a
 * dependency — unlike `@loxep/commerce`, which it already depends on — so
 * that executor cannot be added without a `package.json` edit (and a
 * `bun install` to relink the workspace symlink), which is outside this
 * change's write fence. Nothing here is broken by the gap: `ensureTarget`,
 * the cursor helpers, and `syncConnection` all work today via direct
 * invocation (a script, a test, a future on-demand task); what does NOT yet
 * work is SCHEDULED polling through `market.poll-target`, because no route
 * claims an `ebay_purchases` target. Filed as a follow-up; see this
 * package's `purchase-sync.test.ts` module doc and the bd notes on
 * loxep-dgf.5.
 *
 * ## Idempotency: an application-level check, not a constraint — ALSO A GAP
 *
 * The design calls for one migration: a partial unique index on
 * `acquisitions (connection_id, external_reference)`. Adding a migration is
 * outside this change's write fence (no `packages/db/migrations/**` edits).
 * {@link ingestEbayPurchase} instead looks for an existing acquisition with
 * the same `(connection_id, external_reference)` before inserting one. This
 * is idempotent against SEQUENTIAL re-polls (the normal case — a connection's
 * `ebay_purchases` target is claimed by one dispatcher at a time) but NOT
 * against two truly concurrent syncs of the same connection racing the
 * look-then-insert, which only the missing unique index would close. Flagged
 * for the orchestrator the same way the missing `@loxep/app` route is.
 */
import { createHash } from "node:crypto";
import type { LoxepDb } from "@loxep/db";
import { monitorTargets, providerObjects } from "@loxep/db/schema";
import { z } from "zod";
import { createAcquisitionsService } from "./acquisitions.ts";
import type { AcquisitionRow } from "./acquisitions.ts";
import { InventoryNotFoundError, InventoryValidationError } from "./errors.ts";
import { jsonbLiteral, textLiteral, uuidLiteral } from "./sql.ts";

/** `monitor_targets.target_type` for eBay purchase-history polling. */
export const EBAY_PURCHASES_TARGET_TYPE = "ebay_purchases";

/** Namespaced `monitor_targets.config` key this module owns. */
export const PURCHASE_SYNC_CONFIG_KEY = "purchaseSync";

/**
 * Default poll cadence: 4 hours. Purchase history is not a price feed (the
 * design's own words) — `ebay_watchlist`/`ebay_item` poll every minute,
 * `ebay_orders` every 15 minutes, and this is deliberately much further out.
 */
export const DEFAULT_PURCHASE_SYNC_INTERVAL_SECONDS = 4 * 60 * 60;

/** Conservative per-run page budget against `GetMyeBayBuying`. */
export const DEFAULT_PURCHASE_SYNC_MAX_PAGES = 10;
export const DEFAULT_PURCHASE_SYNC_ENTRIES_PER_PAGE = 100;

const EBAY_PROVIDER = "ebay";
const PURCHASE_OBJECT_TYPE = "ebay.purchase";

/* ----------------------------------------------------------- config schema */

/**
 * The `ebay_purchases` target-type config contract. This package's schema is
 * the AUTHORITY for its own service; `@loxep/market` carries a structural
 * re-declaration so the monitor service can validate a config it is asked to
 * store (same discipline as `wooOrdersTargetConfigSchema`/
 * `commerceSyncStateSchema`).
 *
 * The top level is a `looseObject`, not a `strictObject`, for the same reason
 * `@loxep/commerce`'s equivalent is: it must pass the scheduler's `adaptive`
 * namespace (written by `recordPollSuccess`/`recordPollFailure`) through
 * untouched without knowing its shape, because this package does not depend
 * on `@loxep/market` and must not fail to read a row the scheduler itself
 * wrote to.
 */
export const purchaseSyncStateSchema = z.strictObject({
  /**
   * Diagnostic watermark: the latest `purchasedAt` this connection has seen.
   * `null` is a legitimate stored value — written explicitly after a sync
   * that saw zero purchases — and this field is `nullable().optional()` for
   * exactly the reason `commerceSyncStateSchema.modifiedAfter` documents: a
   * schema that REJECTS a stored `null` poisons the target's own config on
   * its next read (found live, `ebay_orders`, 2026-08-13; the market-side
   * copy was fixed first, the package's own copy — the one the executor
   * actually validates through — was the second half of that bug). NOT
   * currently used to filter the `GetMyeBayBuying` request: Trading's
   * `WonList` container has no documented incremental date filter (unlike
   * `GetOrders`' `CreateTimeFrom`/`CreateTimeTo`), so every poll re-reads the
   * connection's current won-item window and idempotency does the rest. Kept
   * for display and for a future filter if eBay is confirmed to support one.
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

export const purchaseSyncTargetConfigSchema = z.looseObject({
  [PURCHASE_SYNC_CONFIG_KEY]: purchaseSyncStateSchema.optional(),
});

export type PurchaseSyncTargetConfig = z.infer<
  typeof purchaseSyncTargetConfigSchema
>;

/* ------------------------------------------------------------ target rows */

export interface PurchaseSyncCursor {
  monitorTargetId: string;
  lastPurchasedAt: Date | null;
  lastSyncedAt: Date | null;
  lastPurchaseCount: number | null;
  maxPages: number | null;
  entriesPerPage: number | null;
}

function readCursorFrom(
  monitorTargetId: string,
  config: unknown,
): PurchaseSyncCursor {
  const parsed = purchaseSyncTargetConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    throw new InventoryValidationError(
      `invalid "${EBAY_PURCHASES_TARGET_TYPE}" monitor config: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ")}`,
    );
  }
  const state = parsed.data[PURCHASE_SYNC_CONFIG_KEY];
  return {
    monitorTargetId,
    lastPurchasedAt:
      state?.lastPurchasedAt == null ? null : new Date(state.lastPurchasedAt),
    lastSyncedAt:
      state?.lastSyncedAt === undefined ? null : new Date(state.lastSyncedAt),
    lastPurchaseCount: state?.lastPurchaseCount ?? null,
    maxPages: state?.maxPages ?? null,
    entriesPerPage: state?.entriesPerPage ?? null,
  };
}

export interface EnsurePurchaseSyncTargetInput {
  connectionId: string;
  name?: string;
  intervalSeconds?: number;
  enabled?: boolean;
  createdByUserId?: string | null;
}

/**
 * Find or create the single `ebay_purchases` scheduling row for a
 * connection. `monitor_targets` has no unique constraint on
 * `(connection_id, target_type)`, so "one purchase-sync target per
 * connection" is this module's own invariant, enforced by looking before
 * inserting — the same pattern `ensureOrderSyncTarget` uses.
 */
export async function ensurePurchaseSyncTarget(
  db: LoxepDb,
  input: EnsurePurchaseSyncTargetInput,
): Promise<PurchaseSyncCursor> {
  const connection = await db.query.connections.findFirst({
    where: (table, { eq }) => eq(table.id, input.connectionId),
    columns: { id: true, name: true },
  });
  if (connection === undefined) {
    throw new InventoryNotFoundError(`unknown connection "${input.connectionId}"`);
  }

  const existing = await db.query.monitorTargets.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.connectionId, input.connectionId),
        eq(table.targetType, EBAY_PURCHASES_TARGET_TYPE),
      ),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    columns: { id: true, config: true },
  });
  if (existing !== undefined) {
    return readCursorFrom(existing.id, existing.config);
  }

  const inserted = await db
    .insert(monitorTargets)
    .values({
      connectionId: input.connectionId,
      targetType: EBAY_PURCHASES_TARGET_TYPE,
      name: input.name ?? `eBay purchases — ${connection.name}`,
      enabled: input.enabled ?? true,
      intervalSeconds:
        input.intervalSeconds ?? DEFAULT_PURCHASE_SYNC_INTERVAL_SECONDS,
      nextPollAt: new Date(),
      config: {},
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning({ id: monitorTargets.id, config: monitorTargets.config });
  const row = inserted[0];
  if (row === undefined) {
    throw new InventoryNotFoundError("monitor target insert returned no row");
  }
  return readCursorFrom(row.id, row.config);
}

/** Read the stored cursor for a connection, or null when none exists yet. */
export async function readPurchaseSyncCursor(
  db: LoxepDb,
  connectionId: string,
): Promise<PurchaseSyncCursor | null> {
  const row = await db.query.monitorTargets.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.connectionId, connectionId),
        eq(table.targetType, EBAY_PURCHASES_TARGET_TYPE),
      ),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    columns: { id: true, config: true },
  });
  return row === undefined ? null : readCursorFrom(row.id, row.config);
}

/**
 * Merge new cursor state into `config.purchaseSync`, leaving every other
 * namespaced key (notably the scheduler's `adaptive`) untouched — the same
 * `jsonb_set`-with-fallback shape `@loxep/commerce`'s `writeOrderSyncCursor`
 * uses, for the same reason.
 */
export async function writePurchaseSyncCursor(
  db: LoxepDb,
  monitorTargetId: string,
  patch: {
    lastPurchasedAt?: Date | null;
    lastSyncedAt?: Date;
    lastPurchaseCount?: number;
  },
): Promise<void> {
  const state: Record<string, unknown> = {};
  if (patch.lastPurchasedAt !== undefined) {
    state["lastPurchasedAt"] =
      patch.lastPurchasedAt === null ? null : patch.lastPurchasedAt.toISOString();
  }
  if (patch.lastSyncedAt !== undefined) {
    state["lastSyncedAt"] = patch.lastSyncedAt.toISOString();
  }
  if (patch.lastPurchaseCount !== undefined) {
    state["lastPurchaseCount"] = patch.lastPurchaseCount;
  }
  if (Object.keys(state).length === 0) return;
  const literal = jsonbLiteral({ [PURCHASE_SYNC_CONFIG_KEY]: state });
  const key = PURCHASE_SYNC_CONFIG_KEY;
  const result = await db.execute(
    `update monitor_targets
        set config = case
                       when jsonb_typeof(config) = 'object'
                         then case
                                when jsonb_typeof(config -> ${textLiteral(key)}) = 'object'
                                  then jsonb_set(
                                         config,
                                         array[${textLiteral(key)}],
                                         (config -> ${textLiteral(key)})
                                           || (${literal} -> ${textLiteral(key)})
                                       )
                                else config || ${literal}
                              end
                       else ${literal}
                     end,
            updated_at = now()
      where id = ${uuidLiteral(monitorTargetId)}
      returning id`,
  );
  if (result.rows.length === 0) {
    throw new InventoryNotFoundError(`unknown monitor target "${monitorTargetId}"`);
  }
}

/* --------------------------------------------------------------- ingestion */

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const currencyCode = z.string().regex(/^[A-Za-z]{3}$/, "expected ISO-4217");

/**
 * Structural mirror of `@loxep/integration-ebay`'s `EbayPurchaseFact`.
 * RE-DECLARED, NOT IMPORTED: `@loxep/inventory` does not depend on
 * `@loxep/integration-ebay` (it does not appear in `package.json`), the exact
 * boundary discipline `@loxep/commerce`'s `ebay-sync.ts` documents for
 * `EbayOrderFactLike` — provider-shaped facts are supplied by an injected
 * function the composition root binds, never imported directly.
 */
export interface EbayPurchaseFactLike {
  externalOrderId: string;
  sellerExternalId: string | null;
  currency: string;
  title: string;
  itemPriceAmount: string;
  shippingAmount: string;
  taxAmount: string;
  totalAmount: string;
  /** ISO-8601 UTC. */
  purchasedAt: string;
  raw: readonly Record<string, unknown>[];
}

const purchaseFactSchema = z.object({
  externalOrderId: z.string().min(1),
  sellerExternalId: z.string().min(1).nullable(),
  currency: currencyCode,
  title: z.string().min(1),
  itemPriceAmount: decimalString,
  shippingAmount: decimalString,
  taxAmount: decimalString,
  totalAmount: decimalString,
  purchasedAt: z.iso.datetime(),
  raw: z.array(z.record(z.string(), z.unknown())),
});

export interface IngestEbayPurchaseInput {
  connectionId: string;
  fact: EbayPurchaseFactLike;
  actorUserId?: string | null;
  now?: Date;
  /** Retain the raw provider payload (default true; false for a dry run). */
  retainProvenance?: boolean;
}

export interface IngestEbayPurchaseResult {
  created: boolean;
  /**
   * True when an acquisition with this `(connectionId, externalReference)`
   * already existed — see the module doc's idempotency-gap note.
   */
  skipped: boolean;
  acquisition: AcquisitionRow;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** `costType` per the design's `acquisition_costs` mapping. */
const COST_MAPPING = {
  goods: { costType: "goods", costClass: "goods" as const },
  shipping: { costType: "inbound_freight", costClass: "ancillary" as const },
  tax: { costType: "sales_tax", costClass: "ancillary" as const },
};

export interface PurchaseIngestionService {
  ingestEbayPurchase: (
    input: IngestEbayPurchaseInput,
  ) => Promise<IngestEbayPurchaseResult>;
}

export function createPurchaseIngestionService(options: {
  db: LoxepDb;
}): PurchaseIngestionService {
  const { db } = options;
  const acquisitionsService = createAcquisitionsService({ db });

  async function retainProvenance(input: {
    connectionId: string;
    fact: EbayPurchaseFactLike;
    now: Date;
  }): Promise<void> {
    const payload = { entries: input.fact.raw };
    const payloadHash = hashPayload(payload);
    const latest = await db.query.providerObjects.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.connectionId, input.connectionId),
          eq(table.provider, EBAY_PROVIDER),
          eq(table.objectType, PURCHASE_OBJECT_TYPE),
          eq(table.externalObjectId, input.fact.externalOrderId),
        ),
      orderBy: (table, { desc }) => [desc(table.fetchedAt)],
      columns: { id: true, payloadHash: true },
    });
    if (latest !== undefined && latest.payloadHash === payloadHash) return;
    await db.insert(providerObjects).values({
      connectionId: input.connectionId,
      provider: EBAY_PROVIDER,
      objectType: PURCHASE_OBJECT_TYPE,
      externalObjectId: input.fact.externalOrderId,
      fetchedAt: input.now,
      providerUpdatedAt: new Date(input.fact.purchasedAt),
      payload,
      payloadHash,
    });
  }

  return {
    async ingestEbayPurchase(input) {
      const parsed = purchaseFactSchema.safeParse(input.fact);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new InventoryValidationError(`invalid eBay purchase fact: ${issues}`);
      }
      const fact = parsed.data;
      const now = input.now ?? new Date();

      // Idempotency gap: see the module doc — this is a look-then-insert,
      // not a constraint, pending the design's `acquisitions_connection_
      // external_ref_uq` migration.
      const existing = await db.query.acquisitions.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.connectionId, input.connectionId),
            eq(table.externalReference, fact.externalOrderId),
          ),
      });
      if (existing !== undefined) {
        if (input.retainProvenance !== false) {
          await retainProvenance({ connectionId: input.connectionId, fact, now });
        }
        return { created: false, skipped: true, acquisition: existing };
      }

      const acquisition = await acquisitionsService.create({
        title: fact.title,
        sourceKind: "online_marketplace",
        currency: fact.currency,
        connectionId: input.connectionId,
        vendorName: fact.sellerExternalId,
        externalReference: fact.externalOrderId,
        status: "draft",
        acquiredAt: new Date(fact.purchasedAt),
        createdByUserId: input.actorUserId ?? null,
      });

      const costs: { key: keyof typeof COST_MAPPING; amount: string }[] = [
        { key: "goods", amount: fact.itemPriceAmount },
        { key: "shipping", amount: fact.shippingAmount },
        { key: "tax", amount: fact.taxAmount },
      ];
      for (const { key, amount } of costs) {
        if (/^0(\.0+)?$/.test(amount)) continue;
        const mapping = COST_MAPPING[key];
        await acquisitionsService.addCost({
          acquisitionId: acquisition.id,
          costType: mapping.costType,
          costClass: mapping.costClass,
          amount,
          currency: fact.currency,
          incurredAt: new Date(fact.purchasedAt),
        });
      }

      if (input.retainProvenance !== false) {
        await retainProvenance({ connectionId: input.connectionId, fact, now });
      }

      return { created: true, skipped: false, acquisition };
    },
  };
}

/* ------------------------------------------------------------------- sync */

/** The injected provider boundary — see the module doc's boundary note. */
export type EbayPurchasePageIterator = (input: {
  connectionId: string;
  maxPages: number;
  entriesPerPage: number;
}) => Promise<{
  purchases: readonly EbayPurchaseFactLike[];
  pages: number;
  truncated: boolean;
}>;

export interface SyncEbayPurchasesInput {
  connectionId: string;
  maxPages?: number;
  entriesPerPage?: number;
  actorUserId?: string | null;
  /** Skip cursor persistence (a dry run). */
  persistCursor?: boolean;
  now?: Date;
}

export interface SyncEbayPurchasesResult {
  connectionId: string;
  monitorTargetId: string;
  pages: number;
  truncated: boolean;
  purchasesSeen: number;
  created: number;
  skipped: number;
  currencies: string[];
  /** The latest `purchasedAt` observed this run, or null when none was. */
  lastPurchasedAt: Date | null;
}

export interface EbayPurchaseSyncService {
  ensureTarget: (
    input: EnsurePurchaseSyncTargetInput,
  ) => Promise<PurchaseSyncCursor>;
  readCursor: (connectionId: string) => Promise<PurchaseSyncCursor | null>;
  syncConnection: (
    input: SyncEbayPurchasesInput,
  ) => Promise<SyncEbayPurchasesResult>;
}

export function createEbayPurchaseSync(options: {
  db: LoxepDb;
  fetchPurchases: EbayPurchasePageIterator;
  /** Reuse an already-built ingestion service (tests, composition roots). */
  ingestion?: PurchaseIngestionService;
}): EbayPurchaseSyncService {
  const { db, fetchPurchases } = options;
  const ingestion =
    options.ingestion ?? createPurchaseIngestionService({ db });

  async function syncConnection(
    input: SyncEbayPurchasesInput,
  ): Promise<SyncEbayPurchasesResult> {
    const cursor = await ensurePurchaseSyncTarget(db, {
      connectionId: input.connectionId,
    });
    const maxPages =
      input.maxPages ?? cursor.maxPages ?? DEFAULT_PURCHASE_SYNC_MAX_PAGES;
    const entriesPerPage =
      input.entriesPerPage ??
      cursor.entriesPerPage ??
      DEFAULT_PURCHASE_SYNC_ENTRIES_PER_PAGE;

    const result = await fetchPurchases({
      connectionId: input.connectionId,
      maxPages,
      entriesPerPage,
    });

    let created = 0;
    let skipped = 0;
    const currencies = new Set<string>();
    let highWatermarkMillis: number | null = null;

    for (const fact of result.purchases) {
      const outcome = await ingestion.ingestEbayPurchase({
        connectionId: input.connectionId,
        fact,
        ...(input.actorUserId === undefined
          ? {}
          : { actorUserId: input.actorUserId }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (outcome.created) created += 1;
      else skipped += 1;
      if (fact.currency !== "") currencies.add(fact.currency.toUpperCase());
      const millis = new Date(fact.purchasedAt).getTime();
      if (
        !Number.isNaN(millis) &&
        (highWatermarkMillis === null || millis > highWatermarkMillis)
      ) {
        highWatermarkMillis = millis;
      }
    }

    const lastPurchasedAt =
      highWatermarkMillis === null
        ? cursor.lastPurchasedAt
        : new Date(highWatermarkMillis);

    if (input.persistCursor !== false) {
      await writePurchaseSyncCursor(db, cursor.monitorTargetId, {
        lastPurchasedAt,
        lastSyncedAt: input.now ?? new Date(),
        lastPurchaseCount: result.purchases.length,
      });
    }

    return {
      connectionId: input.connectionId,
      monitorTargetId: cursor.monitorTargetId,
      pages: result.pages,
      truncated: result.truncated,
      purchasesSeen: result.purchases.length,
      created,
      skipped,
      currencies: [...currencies].sort(),
      lastPurchasedAt,
    };
  }

  return {
    ensureTarget: (input) => ensurePurchaseSyncTarget(db, input),
    readCursor: (connectionId) => readPurchaseSyncCursor(db, connectionId),
    syncConnection,
  };
}
