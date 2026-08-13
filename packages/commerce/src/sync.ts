/**
 * Incremental WooCommerce order sync and its scheduling state.
 *
 * ## PROVISIONAL (design open question 6): where the sync cursor lives
 *
 * The design document's recommendation — reuse `monitor_targets` with a new
 * target type rather than build a second scheduler — is what this module
 * implements. The target type is `woo_orders` and the cursor lives under a
 * namespaced `config.commerceSync` key, exactly the way `@loxep/market` keeps
 * its transient `config.adaptive` state. Nothing about the scheduling model
 * changes: claim semantics, adaptive cadence, backoff, and rate budgets are
 * reused as-is, and `monitor_targets` gains no column.
 *
 * The ownership tension the design flags is resolved in documentation, not in
 * code: Domain Boundaries now describes the scheduling model as shared
 * foundation infrastructure that domains register target types against. See
 * the "Scheduling is shared foundation infrastructure" paragraph there, also
 * marked PROVISIONAL.
 *
 * ### Why the target row is still written with direct SQL
 *
 * `woo_orders` IS now registered in `@loxep/market` (loxep-xh9.7.2):
 * `MONITOR_TARGET_TYPES` includes it, `monitorTargetConfigSchemas.woo_orders`
 * carries a structural re-declaration of {@link wooOrdersTargetConfigSchema},
 * and `@loxep/app` routes the type to this package's sync service. CRUD
 * through `createMonitorService` therefore works for these rows.
 *
 * {@link ensureWooOrderSyncTarget} nevertheless keeps its direct insert, and
 * that is a boundary decision rather than leftover scaffolding:
 * **@loxep/commerce deliberately does not depend on @loxep/market.** Commerce
 * and Market Intelligence are distinct ownership boundaries, and the
 * registration model exists precisely so a domain can use the shared
 * scheduling mechanism without taking a dependency on the package that
 * implements it. Reaching for `createMonitorService` here would invert that.
 * The insert writes exactly the columns the service would, validated against
 * this package's own schema, so the two paths produce identical rows.
 *
 * The two config schemas are duplicated by design, guarded by a drift test in
 * `packages/app` (`commerce-sync.test.ts`) that round-trips a config through
 * both. They differ in one intentional way: this one is a `looseObject`
 * because it must pass the scheduler's `adaptive` namespace through without
 * knowing its shape, while market's is strict and names `adaptive` itself.
 *
 * Everything else about the row already worked untouched, because the
 * scheduling primitives are type-agnostic: `claimDueTargets`,
 * `recordPollSuccess`, and `recordPollFailure` all operate on any
 * `monitor_targets` row regardless of `target_type`.
 *
 * ## Watermark discipline
 *
 * WooCommerce's `modified_after` filter is EXCLUSIVE and pairs with
 * `dates_are_gmt=true`, so the stored cursor is the last watermark SEEN, never
 * watermark + 1ms. It is additionally rewound by
 * {@link CURSOR_OVERLAP_SECONDS} before storage: two orders can share a
 * `date_modified_gmt` to the second, and a page boundary landing between them
 * would otherwise skip the second one forever. Re-fetching a small overlap is
 * free — ingestion is idempotent — while a skipped order is invisible.
 */
import type { LoxepDb } from "@loxep/db";
import { monitorTargets } from "@loxep/db/schema";
import type { WooAdapter } from "@loxep/integration-woo";
import { iterateWooOrders } from "@loxep/integration-woo";
import { z } from "zod";
import { CommerceNotFoundError, CommerceValidationError } from "./errors.ts";
import { createOrderIngestionService } from "./orders.ts";
import type { OrderIngestionService } from "./orders.ts";
import { jsonbLiteral, textLiteral, uuidLiteral } from "./sql.ts";

/** `monitor_targets.target_type` for WooCommerce order polling. PROVISIONAL. */
export const WOO_ORDERS_TARGET_TYPE = "woo_orders";

/** Namespaced `monitor_targets.config` key this package owns. */
export const COMMERCE_SYNC_CONFIG_KEY = "commerceSync";

/** Default poll cadence for a new order-sync target: every 15 minutes. */
export const DEFAULT_SYNC_INTERVAL_SECONDS = 900;

/**
 * How far the stored watermark is rewound. One second, because WooCommerce
 * serializes `date_modified_gmt` to second precision — anything finer would
 * not protect against the tie it exists to protect against.
 */
export const CURSOR_OVERLAP_SECONDS = 1;

/** Conservative page size for a polite poll against a self-hosted store. */
export const DEFAULT_SYNC_PER_PAGE = 20;

/** Pages one scheduled sync may walk before stopping and keeping its cursor. */
export const DEFAULT_SYNC_MAX_PAGES = 10;

/* ----------------------------------------------------------- config schema */

/**
 * The `woo_orders` target-type config contract. This package's schema is the
 * AUTHORITY for its own service; `@loxep/market` carries a structural
 * re-declaration so the monitor service can validate a config it is asked to
 * store (see the module doc for the drift guard).
 *
 * `adaptive` is passed through untouched: that namespace belongs to the
 * scheduler, and re-declaring its shape here would create a second source of
 * truth for someone else's state.
 */
export const wooOrdersTargetConfigSchema = z.looseObject({
  [COMMERCE_SYNC_CONFIG_KEY]: z
    .strictObject({
      /**
       * Watermark handed to `modified_after` on the next poll. `null` is a
       * legitimate stored value — `writeOrderSyncCursor` records it
       * explicitly after a sync that saw zero orders, and this schema
       * rejecting it poisoned a target's own config on its next poll (live
       * eBay orders, 2026-08-13; the market-side copy was fixed first and
       * this copy — the one the executor actually validates through — was
       * the second half of the same bug).
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
    })
    .optional(),
});

export type WooOrdersTargetConfig = z.infer<typeof wooOrdersTargetConfigSchema>;

/**
 * The same shape under a provider-neutral name. Every commerce order sync —
 * WooCommerce today, eBay in `ebay-sync.ts` — stores its cursor under the one
 * `config.commerceSync` namespace, because the cursor's fields are the same
 * facts (a watermark, a last-run stamp, a page budget) regardless of which
 * provider produced them. One namespace, one schema, one set of read/write
 * helpers; only the `target_type` differs.
 */
export const commerceSyncTargetConfigSchema = wooOrdersTargetConfigSchema;

/** The cursor as callers see it. */
export interface WooOrderSyncCursor {
  monitorTargetId: string;
  modifiedAfter: Date | null;
  lastSyncedAt: Date | null;
  lastOrderCount: number | null;
  perPage: number | null;
  maxPages: number | null;
}

/** Provider-neutral alias — see {@link commerceSyncTargetConfigSchema}. */
export type CommerceOrderSyncCursor = WooOrderSyncCursor;

function readCursorFrom(
  monitorTargetId: string,
  config: unknown,
  targetType: string = WOO_ORDERS_TARGET_TYPE,
): WooOrderSyncCursor {
  const parsed = commerceSyncTargetConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    throw new CommerceValidationError(
      `invalid "${targetType}" monitor config: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ")}`,
    );
  }
  const state = parsed.data[COMMERCE_SYNC_CONFIG_KEY];
  return {
    monitorTargetId,
    modifiedAfter:
      state?.modifiedAfter == null ? null : new Date(state.modifiedAfter),
    lastSyncedAt:
      state?.lastSyncedAt === undefined ? null : new Date(state.lastSyncedAt),
    lastOrderCount: state?.lastOrderCount ?? null,
    perPage: state?.perPage ?? null,
    maxPages: state?.maxPages ?? null,
  };
}

/* ------------------------------------------------------------ target rows */

export interface EnsureWooOrderSyncTargetInput {
  connectionId: string;
  name?: string;
  intervalSeconds?: number;
  enabled?: boolean;
  /** Seed the watermark on first creation (a backfill start point). */
  modifiedAfter?: Date;
  createdByUserId?: string | null;
}

/**
 * Find or create the single `woo_orders` scheduling row for a connection.
 *
 * `monitor_targets` has no unique constraint on
 * `(connection_id, target_type)` — the foundation deliberately allows several
 * targets of one type per connection — so "one order-sync target per
 * connection" is this package's invariant, enforced by looking before
 * inserting rather than by adding a constraint to someone else's table.
 */
export async function ensureWooOrderSyncTarget(
  db: LoxepDb,
  input: EnsureWooOrderSyncTargetInput,
): Promise<WooOrderSyncCursor> {
  return ensureOrderSyncTarget(db, {
    ...input,
    targetType: WOO_ORDERS_TARGET_TYPE,
    namePrefix: "WooCommerce orders",
  });
}

/**
 * The provider-neutral form of {@link ensureWooOrderSyncTarget}. A second
 * provider is a different `targetType` and a different default name; every
 * other rule — one target per connection, enforced by looking rather than by
 * a constraint, and a direct insert rather than a `@loxep/market` dependency —
 * is identical and lives here once.
 */
export async function ensureOrderSyncTarget(
  db: LoxepDb,
  input: EnsureWooOrderSyncTargetInput & {
    targetType: string;
    namePrefix: string;
  },
): Promise<WooOrderSyncCursor> {
  const { targetType, namePrefix } = input;
  const connection = await db.query.connections.findFirst({
    where: (table, { eq }) => eq(table.id, input.connectionId),
    columns: { id: true, name: true },
  });
  if (connection === undefined) {
    throw new CommerceNotFoundError(
      `unknown connection "${input.connectionId}"`,
    );
  }

  const existing = await db.query.monitorTargets.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.connectionId, input.connectionId),
        eq(table.targetType, targetType),
      ),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    columns: { id: true, config: true },
  });
  if (existing !== undefined) {
    return readCursorFrom(existing.id, existing.config, targetType);
  }

  const config =
    input.modifiedAfter === undefined
      ? {}
      : {
          [COMMERCE_SYNC_CONFIG_KEY]: {
            modifiedAfter: input.modifiedAfter.toISOString(),
          },
        };
  // Direct insert rather than @loxep/market's createMonitorService: that
  // service validates target_type against a closed enum with no registration
  // seam (see the module doc).
  const inserted = await db
    .insert(monitorTargets)
    .values({
      connectionId: input.connectionId,
      targetType,
      name: input.name ?? `${namePrefix} — ${connection.name}`,
      enabled: input.enabled ?? true,
      intervalSeconds: input.intervalSeconds ?? DEFAULT_SYNC_INTERVAL_SECONDS,
      // A new sync target is immediately due.
      nextPollAt: new Date(),
      config,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning({ id: monitorTargets.id, config: monitorTargets.config });
  const row = inserted[0];
  if (row === undefined) {
    throw new CommerceNotFoundError("monitor target insert returned no row");
  }
  return readCursorFrom(row.id, row.config, targetType);
}

/** Read the stored cursor for a connection, or null when none exists yet. */
export async function readWooOrderSyncCursor(
  db: LoxepDb,
  connectionId: string,
): Promise<WooOrderSyncCursor | null> {
  return readOrderSyncCursor(db, connectionId, WOO_ORDERS_TARGET_TYPE);
}

/** The provider-neutral form of {@link readWooOrderSyncCursor}. */
export async function readOrderSyncCursor(
  db: LoxepDb,
  connectionId: string,
  targetType: string,
): Promise<WooOrderSyncCursor | null> {
  const row = await db.query.monitorTargets.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.connectionId, connectionId),
        eq(table.targetType, targetType),
      ),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    columns: { id: true, config: true },
  });
  return row === undefined ? null : readCursorFrom(row.id, row.config, targetType);
}

/**
 * Merge new cursor state into `config.commerceSync`, leaving every other
 * namespaced key (notably the scheduler's `adaptive`) untouched. The same
 * `jsonb_set`-with-fallback shape `@loxep/market` uses, for the same reason: a
 * whole-object write would clobber state this package does not own.
 */
export async function writeOrderSyncCursor(
  db: LoxepDb,
  monitorTargetId: string,
  patch: {
    modifiedAfter?: Date | null;
    lastSyncedAt?: Date;
    lastOrderCount?: number;
  },
): Promise<void> {
  const state: Record<string, unknown> = {};
  if (patch.modifiedAfter !== undefined) {
    state["modifiedAfter"] =
      patch.modifiedAfter === null ? null : patch.modifiedAfter.toISOString();
  }
  if (patch.lastSyncedAt !== undefined) {
    state["lastSyncedAt"] = patch.lastSyncedAt.toISOString();
  }
  if (patch.lastOrderCount !== undefined) {
    state["lastOrderCount"] = patch.lastOrderCount;
  }
  if (Object.keys(state).length === 0) return;
  const literal = jsonbLiteral({ [COMMERCE_SYNC_CONFIG_KEY]: state });
  const key = COMMERCE_SYNC_CONFIG_KEY;
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
    throw new CommerceNotFoundError(
      `unknown monitor target "${monitorTargetId}"`,
    );
  }
}

/**
 * The cursor write is already target-type-agnostic — it takes a monitor
 * target id — so the WooCommerce-named export is a plain alias kept for the
 * callers that predate the second provider.
 */
export const writeWooOrderSyncCursor = writeOrderSyncCursor;

/* ------------------------------------------------------------------- sync */

/**
 * Injectable provider boundary. The sync service never constructs an adapter
 * itself: credentials come from the connection credential service, which lives
 * in the composition root, and a test wants a fake here.
 */
export type WooAdapterFactory = (input: {
  connectionId: string;
}) => Promise<WooAdapter> | WooAdapter;

export interface SyncWooOrdersInput {
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

export interface SyncWooOrdersResult {
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

export interface WooOrderSyncService {
  ensureTarget: (
    input: EnsureWooOrderSyncTargetInput,
  ) => Promise<WooOrderSyncCursor>;
  readCursor: (connectionId: string) => Promise<WooOrderSyncCursor | null>;
  syncConnection: (input: SyncWooOrdersInput) => Promise<SyncWooOrdersResult>;
}

export function createWooOrderSync(options: {
  db: LoxepDb;
  adapterFactory: WooAdapterFactory;
  /** Reuse an already-built ingestion service (tests, composition roots). */
  ingestion?: OrderIngestionService;
}): WooOrderSyncService {
  const { db, adapterFactory } = options;
  const ingestion =
    options.ingestion ?? createOrderIngestionService({ db });

  async function syncConnection(
    input: SyncWooOrdersInput,
  ): Promise<SyncWooOrdersResult> {
    const cursor = await ensureWooOrderSyncTarget(db, {
      connectionId: input.connectionId,
    });
    const perPage = input.perPage ?? cursor.perPage ?? DEFAULT_SYNC_PER_PAGE;
    const maxPages = input.maxPages ?? cursor.maxPages ?? DEFAULT_SYNC_MAX_PAGES;
    const modifiedAfter =
      input.modifiedAfter === undefined
        ? cursor.modifiedAfter
        : input.modifiedAfter;

    const adapter = await adapterFactory({ connectionId: input.connectionId });

    let pages = 0;
    let ordersSeen = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let duplicatesMarked = 0;
    let highWatermarkMillis: number | null = null;
    const currencies = new Set<string>();

    for await (const page of iterateWooOrders(
      adapter,
      {
        perPage,
        ...(modifiedAfter === null ? {} : { modifiedAfter }),
      },
      { maxPages },
    )) {
      pages += 1;
      for (const fact of page.orders) {
        const result = await ingestion.ingestWooOrder({
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

    // Rewind by the overlap so a same-second tie across a page boundary is
    // re-read rather than lost. Ingestion is idempotent; a skipped order is not
    // recoverable without a full re-read.
    const nextModifiedAfter =
      highWatermarkMillis === null
        ? modifiedAfter
        : new Date(highWatermarkMillis - CURSOR_OVERLAP_SECONDS * 1000);

    if (input.persistCursor !== false) {
      await writeWooOrderSyncCursor(db, cursor.monitorTargetId, {
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
    ensureTarget: (input) => ensureWooOrderSyncTarget(db, input),
    readCursor: (connectionId) => readWooOrderSyncCursor(db, connectionId),
    syncConnection,
  };
}
