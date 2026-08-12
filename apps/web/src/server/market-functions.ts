/**
 * Server functions for the /market workspace surfaces (loxep-62y.4).
 *
 * Handlers use dynamic imports so `@/server/admin` (and the server packages
 * behind it) stay out of the client bundle; only type-only imports from
 * server packages are allowed at the top level here — mirrors
 * `@/server/admin-functions.ts`.
 *
 * Role gates (ADR-0017): reads of ordinary product data call `requireSession`
 * (any authenticated member); monitor create/update/delete call
 * `requireAdmin`. `@loxep/market` is reached only through
 * `@/server/admin`'s `getMarketModule`/`getMonitorService` (never a static
 * top-level import) because its index re-exports `tasks.ts`, which reaches
 * `graphile-worker` via `@loxep/jobs` — the same SSR-bundling hazard
 * documented on `getNotificationsModule`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { JsonValue } from '@/server/admin-functions';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Monitors (loxep-62y.4.1)
// ---------------------------------------------------------------------------

export interface MonitorDto {
  id: string;
  targetType: string;
  name: string;
  connectionId: string | null;
  connectionName: string | null;
  enabled: boolean;
  intervalSeconds: number;
  priority: number;
  nextPollAt: string | null;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  backoffUntil: string | null;
  consecutiveErrors: number;
  config: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
}

export const fetchMonitors = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MonitorDto[]> => {
    const { requireSession, getAdminServices, getMonitorService } = await import('@/server/admin');
    await requireSession();
    const admin = getAdminServices();
    const monitorService = await getMonitorService();
    const [targets, connections] = await Promise.all([
      monitorService.listTargets(),
      admin.connections.listConnections()
    ]);
    const connectionNameById = new Map(connections.map((row) => [row.id, row.name]));
    return targets.map((target) => ({
      id: target.id,
      targetType: target.targetType,
      name: target.name,
      connectionId: target.connectionId,
      connectionName: target.connectionId
        ? (connectionNameById.get(target.connectionId) ?? null)
        : null,
      enabled: target.enabled,
      intervalSeconds: target.intervalSeconds,
      priority: target.priority,
      nextPollAt: iso(target.nextPollAt),
      lastPollAt: iso(target.lastPollAt),
      lastSuccessAt: iso(target.lastSuccessAt),
      backoffUntil: iso(target.backoffUntil),
      consecutiveErrors: target.consecutiveErrors,
      config: target.config as Record<string, JsonValue>,
      createdAt: iso(target.createdAt),
      updatedAt: iso(target.updatedAt)
    }));
  }
);

/**
 * Mirrors `monitorTargetConfigSchemas` in `@loxep/market/monitors.ts`:
 * `ebay_item` carries its own `externalItemId` and an optional connection;
 * `ebay_watchlist` is identified by its connection, so the connection is
 * required; `ebay_search` (Phase 2 discovery) needs at least one of
 * `query`/`categoryId`; `ebay_seller` (Phase 2 discovery) is identified by
 * `sellerUsername`, with `query`/`categoryId` as optional narrowing — both
 * discovery types take an optional `maxItems` poll-paging cap. Search/seller
 * filter grammar beyond query/category (price bounds, conditions, …) is not
 * exposed by this Phase 2 dashboard UI; the underlying config schema accepts
 * it and a future settings surface can add it without a server-fn change.
 */
const createMonitorInput = z.discriminatedUnion('targetType', [
  z.strictObject({
    targetType: z.literal('ebay_item'),
    name: z.string().trim().min(1),
    connectionId: z.uuid().nullable(),
    intervalSeconds: z.number().int().positive(),
    priority: z.number().int(),
    enabled: z.boolean(),
    externalItemId: z.string().trim().min(1)
  }),
  z.strictObject({
    targetType: z.literal('ebay_watchlist'),
    name: z.string().trim().min(1),
    connectionId: z.uuid(),
    intervalSeconds: z.number().int().positive(),
    priority: z.number().int(),
    enabled: z.boolean()
  }),
  z
    .strictObject({
      targetType: z.literal('ebay_search'),
      name: z.string().trim().min(1),
      connectionId: z.uuid().nullable(),
      intervalSeconds: z.number().int().positive(),
      priority: z.number().int(),
      enabled: z.boolean(),
      query: z.string().trim().min(1).optional(),
      categoryId: z.string().trim().min(1).optional(),
      maxItems: z.number().int().positive().max(1000).optional()
    })
    .refine((data) => data.query !== undefined || data.categoryId !== undefined, {
      message: 'A search monitor needs a query or a category',
      path: ['query']
    }),
  z.strictObject({
    targetType: z.literal('ebay_seller'),
    name: z.string().trim().min(1),
    connectionId: z.uuid().nullable(),
    intervalSeconds: z.number().int().positive(),
    priority: z.number().int(),
    enabled: z.boolean(),
    sellerUsername: z.string().trim().min(1),
    query: z.string().trim().min(1).optional(),
    categoryId: z.string().trim().min(1).optional(),
    maxItems: z.number().int().positive().max(1000).optional()
  })
]);

/** Builds the per-target-type `config` payload for `createMonitor`. */
function createMonitorConfig(data: z.infer<typeof createMonitorInput>): Record<string, unknown> {
  switch (data.targetType) {
    case 'ebay_item':
      return { externalItemId: data.externalItemId };
    case 'ebay_watchlist':
      return {};
    case 'ebay_search':
      return {
        ...(data.query !== undefined ? { query: data.query } : {}),
        ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
        ...(data.maxItems !== undefined ? { maxItems: data.maxItems } : {})
      };
    case 'ebay_seller':
      return {
        sellerUsername: data.sellerUsername,
        ...(data.query !== undefined ? { query: data.query } : {}),
        ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
        ...(data.maxItems !== undefined ? { maxItems: data.maxItems } : {})
      };
    default: {
      // Exhaustiveness guard: `data` is `never` here only while every
      // `createMonitorInput` branch above is handled — a future branch left
      // unhandled fails typecheck instead of silently falling through.
      const exhaustive: never = data;
      void exhaustive;
      return {};
    }
  }
}

export const createMonitor = createServerFn({ method: 'POST' })
  .inputValidator(createMonitorInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getMonitorService } = await import('@/server/admin');
    const session = await requireAdmin();
    const monitorService = await getMonitorService();
    const target = await monitorService.createTarget({
      targetType: data.targetType,
      name: data.name,
      connectionId: data.connectionId,
      intervalSeconds: data.intervalSeconds,
      priority: data.priority,
      enabled: data.enabled,
      config: createMonitorConfig(data),
      createdByUserId: session.user.id
    });
    return { id: target.id };
  });

const updateMonitorInput = z
  .strictObject({
    id: z.uuid(),
    name: z.string().trim().min(1).optional(),
    connectionId: z.uuid().nullable().optional(),
    intervalSeconds: z.number().int().positive().optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional(),
    /** Only meaningful for `ebay_item` targets; merged into existing config. */
    externalItemId: z.string().trim().min(1).optional(),
    /** Only meaningful for `ebay_search`/`ebay_seller` targets; merged into existing config. */
    query: z.string().trim().min(1).optional(),
    categoryId: z.string().trim().min(1).optional(),
    /** Only meaningful for `ebay_seller` targets; merged into existing config. */
    sellerUsername: z.string().trim().min(1).optional(),
    maxItems: z.number().int().positive().max(1000).optional()
  })
  .refine((patch) => Object.keys(patch).length > 1, { message: 'empty update' });

/** Config keys `updateMonitorInput` may carry — merged into existing config, not replaced. */
const UPDATABLE_CONFIG_KEYS = [
  'externalItemId',
  'query',
  'categoryId',
  'sellerUsername',
  'maxItems'
] as const;

export const updateMonitor = createServerFn({ method: 'POST' })
  .inputValidator(updateMonitorInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getMonitorService } = await import('@/server/admin');
    await requireAdmin();
    const monitorService = await getMonitorService();
    const { id, externalItemId, query, categoryId, sellerUsername, maxItems, ...patch } = data;
    const configPatch = { externalItemId, query, categoryId, sellerUsername, maxItems };
    const hasConfigPatch = UPDATABLE_CONFIG_KEYS.some((key) => configPatch[key] !== undefined);
    let config: Record<string, unknown> | undefined;
    if (hasConfigPatch) {
      const existing = await monitorService.getTarget(id);
      config = { ...(existing.config as Record<string, unknown>) };
      for (const key of UPDATABLE_CONFIG_KEYS) {
        const value = configPatch[key];
        if (value !== undefined) config[key] = value;
      }
    }
    const target = await monitorService.updateTarget(id, {
      ...patch,
      ...(config !== undefined ? { config } : {})
    });
    return { id: target.id };
  });

export const setMonitorEnabled = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid(), enabled: z.boolean() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getMonitorService } = await import('@/server/admin');
    await requireAdmin();
    const monitorService = await getMonitorService();
    const target = await monitorService.updateTarget(data.id, { enabled: data.enabled });
    return { id: target.id };
  });

export interface RemoveMonitorResultDto {
  id: string;
  action: 'deleted' | 'disabled';
}

/**
 * Monitors that have never polled carry no observation/event history, so
 * removal is a hard delete; monitors with poll history are disabled instead
 * so their history stays intact (`monitors.ts`'s `deleteTarget` doc: linked
 * `monitor_items`/`market_events` RESTRICT the delete on purpose).
 */
export const removeMonitor = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<RemoveMonitorResultDto> => {
    const { requireAdmin, getMonitorService } = await import('@/server/admin');
    await requireAdmin();
    const monitorService = await getMonitorService();
    const target = await monitorService.getTarget(data.id);
    if (target.lastPollAt === null) {
      await monitorService.deleteTarget(data.id);
      return { id: data.id, action: 'deleted' };
    }
    await monitorService.updateTarget(data.id, { enabled: false });
    return { id: data.id, action: 'disabled' };
  });

export interface ConnectionOptionDto {
  id: string;
  name: string;
  status: string;
}

/**
 * Lightweight eBay-connection picker list for the monitor dialog.
 *
 * Archived accounts are omitted (loxep-o7h): archiving is terminal
 * retirement, so a new monitor must never be pointed at one. Existing
 * targets keep their `connection_id` — the poll path skips them instead (see
 * `createArchivedConnectionGate` in `@loxep/app`).
 */
export const fetchEbayConnectionOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionOptionDto[]> => {
    const [{ requireSession, getAdminServices }, { isConnectionArchived }] = await Promise.all([
      import('@/server/admin'),
      import('@loxep/domain')
    ]);
    await requireSession();
    const rows = await getAdminServices().connections.listConnections({ provider: 'ebay' });
    return rows
      .filter((row) => !isConnectionArchived(row.status))
      .map((row) => ({ id: row.id, name: row.name, status: row.status }));
  }
);

export interface MonitorDefaultsDto {
  intervalSeconds: number;
}

/**
 * Installation-wide monitor cadence baseline (loxep-62y.2.7): the `monitors.
 * defaults` setting the worker's poll executor already reads through
 * `services.monitorSettings.read().defaultIntervalSeconds`
 * (`@loxep/app/poll-executor.ts`) and `/settings` already lists. The monitor
 * create dialog reads it here to seed `intervalSeconds` instead of a
 * hardcoded fallback, so the same baseline reaches new targets everywhere.
 * `monitorDefaultsSetting` is a value import from `@loxep/domain`, dynamic
 * like every other server-package handle in this file (top-level imports
 * here are type-only — see the file doc).
 */
export const fetchMonitorDefaults = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MonitorDefaultsDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { monitorDefaultsSetting } = await import('@loxep/domain');
    const { settings } = getAdminServices();
    const defaults = await settings.get(monitorDefaultsSetting);
    return { intervalSeconds: defaults.intervalSeconds };
  }
);

// ---------------------------------------------------------------------------
// Watched items (loxep-62y.4.2)
// ---------------------------------------------------------------------------

export interface LatestObservationDto {
  observedAt: string;
  price: string | null;
  currency: string | null;
  availability: string | null;
  quantityAvailable: number | null;
  listingState: string | null;
}

export interface LinkedMonitorDto {
  id: string;
  name: string;
}

export interface MarketItemDto {
  id: string;
  provider: string;
  marketplace: string;
  externalItemId: string;
  title: string | null;
  canonicalUrl: string | null;
  currentState: string;
  listingType: string | null;
  listingEndsAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  latestObservation: LatestObservationDto | null;
  monitors: LinkedMonitorDto[];
}

export interface MarketItemsPageDto {
  items: MarketItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Sensible default page size for the items table. */
export const MARKET_ITEMS_PAGE_SIZE = 25;

function toObservationDto(
  row: {
    observedAt: Date;
    price: string | null;
    currency: string | null;
    availability: string | null;
    quantityAvailable: number | null;
    listingState: string | null;
  } | null
): LatestObservationDto | null {
  if (row === null) return null;
  return {
    observedAt: iso(row.observedAt),
    price: row.price,
    currency: row.currency,
    availability: row.availability,
    quantityAvailable: row.quantityAvailable,
    listingState: row.listingState
  };
}

/** Whitelisted sort keys for `fetchMarketItems` — mirrors `@loxep/market`'s `WATCHED_ITEM_SORT_KEYS`. */
const fetchMarketItemsInput = z.strictObject({
  page: z.number().int().nonnegative().optional(),
  /** Restrict to items currently linked (actively discovered) by one monitor. */
  monitorTargetId: z.uuid().nullable().optional(),
  sortBy: z.enum(['lastObserved']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional()
});

export const fetchMarketItems = createServerFn({ method: 'GET' })
  .inputValidator(fetchMarketItemsInput)
  .handler(async ({ data }): Promise<MarketItemsPageDto> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const market = await getMarketModule();
    const page = data.page ?? 0;
    const pageSize = MARKET_ITEMS_PAGE_SIZE;

    let allowedIds: string[] | null = null;
    if (data.monitorTargetId) {
      const links = await handle.db.query.monitorItems.findMany({
        where: (table, { eq }) => eq(table.monitorTargetId, data.monitorTargetId as string),
        columns: { marketplaceItemId: true }
      });
      allowedIds = links.map((link) => link.marketplaceItemId);
      if (allowedIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }
    }

    // Ordering (and, when `monitorTargetId` narrows the set, filtering) live
    // in `@loxep/market`'s `listWatchedItemIds` (loxep-foi.7) — this stays a
    // two-pass read (ids, then page rows): no aggregate/count helper is
    // available through the relational query callback API, and volumes here
    // are Phase 1 scale (see `@loxep/market/metrics.ts`'s continuous-aggregate
    // trigger-criteria note for when this would need revisiting).
    const idRows = await market.listWatchedItemIds(handle.db, {
      allowedItemIds: allowedIds,
      ...(data.sortBy !== undefined ? { sortBy: data.sortBy } : {}),
      ...(data.sortDir !== undefined ? { sortDir: data.sortDir } : {})
    });
    const total = idRows.length;
    const pageIds = idRows.slice(page * pageSize, (page + 1) * pageSize).map((row) => row.id);
    if (pageIds.length === 0) {
      return { items: [], total, page, pageSize };
    }

    const [pageItemRows, observationLists, linkRows] = await Promise.all([
      handle.db.query.marketplaceItems.findMany({
        where: (table, { inArray }) => inArray(table.id, pageIds)
      }),
      Promise.all(pageIds.map((id) => market.latestObservations(handle.db, id, 1))),
      handle.db.query.monitorItems.findMany({
        where: (table, { inArray, eq, and }) =>
          and(inArray(table.marketplaceItemId, pageIds), eq(table.active, true))
      })
    ]);

    const monitorTargetIds = [...new Set(linkRows.map((link) => link.monitorTargetId))];
    const monitorTargetRows =
      monitorTargetIds.length > 0
        ? await handle.db.query.monitorTargets.findMany({
            where: (table, { inArray }) => inArray(table.id, monitorTargetIds),
            columns: { id: true, name: true }
          })
        : [];
    const monitorNameById = new Map(monitorTargetRows.map((row) => [row.id, row.name]));
    const monitorsByItemId = new Map<string, LinkedMonitorDto[]>();
    for (const link of linkRows) {
      const list = monitorsByItemId.get(link.marketplaceItemId) ?? [];
      list.push({
        id: link.monitorTargetId,
        name: monitorNameById.get(link.monitorTargetId) ?? 'unknown'
      });
      monitorsByItemId.set(link.marketplaceItemId, list);
    }

    const observationByItemId = new Map(
      pageIds.map((id, index) => [id, observationLists[index]?.[0] ?? null])
    );
    const itemById = new Map(pageItemRows.map((row) => [row.id, row]));

    const items: MarketItemDto[] = pageIds
      .map((id) => itemById.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((item) => ({
        id: item.id,
        provider: item.provider,
        marketplace: item.marketplace,
        externalItemId: item.externalItemId,
        title: item.title,
        canonicalUrl: item.canonicalUrl,
        currentState: item.currentState,
        listingType: item.listingType,
        listingEndsAt: iso(item.listingEndsAt),
        firstSeenAt: iso(item.firstSeenAt),
        lastSeenAt: iso(item.lastSeenAt),
        latestObservation: toObservationDto(observationByItemId.get(item.id) ?? null),
        monitors: monitorsByItemId.get(item.id) ?? []
      }));

    return { items, total, page, pageSize };
  });

export interface MarketItemDetailDto extends MarketItemDto {
  sellerExternalId: string | null;
  conditionCode: string | null;
  categoryExternalId: string | null;
  listingStartedAt: string | null;
}

export const fetchMarketItem = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<MarketItemDetailDto> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const item = await handle.db.query.marketplaceItems.findFirst({
      where: (table, { eq }) => eq(table.id, data.id)
    });
    if (item === undefined) {
      throw new Error(`Marketplace item "${data.id}" not found`);
    }
    const market = await getMarketModule();
    const [observations, linkRows] = await Promise.all([
      market.latestObservations(handle.db, data.id, 1),
      handle.db.query.monitorItems.findMany({
        where: (table, { eq, and }) =>
          and(eq(table.marketplaceItemId, data.id), eq(table.active, true))
      })
    ]);
    const monitorTargetIds = linkRows.map((link) => link.monitorTargetId);
    const monitorTargetRows =
      monitorTargetIds.length > 0
        ? await handle.db.query.monitorTargets.findMany({
            where: (table, { inArray }) => inArray(table.id, monitorTargetIds),
            columns: { id: true, name: true }
          })
        : [];

    return {
      id: item.id,
      provider: item.provider,
      marketplace: item.marketplace,
      externalItemId: item.externalItemId,
      title: item.title,
      canonicalUrl: item.canonicalUrl,
      currentState: item.currentState,
      listingType: item.listingType,
      listingEndsAt: iso(item.listingEndsAt),
      firstSeenAt: iso(item.firstSeenAt),
      lastSeenAt: iso(item.lastSeenAt),
      sellerExternalId: item.sellerExternalId,
      conditionCode: item.conditionCode,
      categoryExternalId: item.categoryExternalId,
      listingStartedAt: iso(item.listingStartedAt),
      latestObservation: toObservationDto(observations[0] ?? null),
      monitors: monitorTargetRows.map((row) => ({ id: row.id, name: row.name }))
    };
  });

// ---------------------------------------------------------------------------
// Item detail: history and events (loxep-62y.4.3)
// ---------------------------------------------------------------------------

export interface PriceHistoryPointDto {
  bucketStart: string;
  minPrice: string | null;
  maxPrice: string | null;
  lastPrice: string | null;
  observationCount: number;
}

export const fetchItemPriceHistory = createServerFn({ method: 'GET' })
  .inputValidator(
    z.strictObject({
      marketplaceItemId: z.uuid(),
      bucketSeconds: z.number().int().positive().optional()
    })
  )
  .handler(async ({ data }): Promise<PriceHistoryPointDto[]> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const market = await getMarketModule();
    const buckets = await market.priceHistory(handle.db, {
      marketplaceItemId: data.marketplaceItemId,
      ...(data.bucketSeconds !== undefined ? { bucketSeconds: data.bucketSeconds } : {})
    });
    return buckets.map((bucket) => ({
      bucketStart: iso(bucket.bucketStart),
      minPrice: bucket.minPrice,
      maxPrice: bucket.maxPrice,
      lastPrice: bucket.lastPrice,
      observationCount: bucket.observationCount
    }));
  });

export interface AvailabilityHistoryPointDto {
  bucketStart: string;
  lastQuantityAvailable: number | null;
  lastListingState: string | null;
  wentUnavailable: boolean;
}

export const fetchItemAvailabilityHistory = createServerFn({ method: 'GET' })
  .inputValidator(
    z.strictObject({
      marketplaceItemId: z.uuid(),
      bucketSeconds: z.number().int().positive().optional()
    })
  )
  .handler(async ({ data }): Promise<AvailabilityHistoryPointDto[]> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const market = await getMarketModule();
    const buckets = await market.availabilityHistory(handle.db, {
      marketplaceItemId: data.marketplaceItemId,
      ...(data.bucketSeconds !== undefined ? { bucketSeconds: data.bucketSeconds } : {})
    });
    return buckets.map((bucket) => ({
      bucketStart: iso(bucket.bucketStart),
      lastQuantityAvailable: bucket.lastQuantityAvailable,
      lastListingState: bucket.lastListingState,
      wentUnavailable: bucket.wentUnavailable
    }));
  });

export interface RestockSelloutIntervalDto {
  from: string | null;
  to: string | null;
  state: 'in_stock' | 'out_of_stock';
}

export interface RestockSelloutDto {
  selloutCount: number;
  restockCount: number;
  avgOutOfStockSeconds: number | null;
  avgInStockSeconds: number | null;
  currentState: 'in_stock' | 'out_of_stock' | 'unknown';
  intervals: RestockSelloutIntervalDto[];
}

export const fetchItemRestockSellout = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ marketplaceItemId: z.uuid() }))
  .handler(async ({ data }): Promise<RestockSelloutDto> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const market = await getMarketModule();
    const result = await market.restockSellout(handle.db, {
      marketplaceItemId: data.marketplaceItemId
    });
    return {
      selloutCount: result.selloutCount,
      restockCount: result.restockCount,
      avgOutOfStockSeconds: result.avgOutOfStockSeconds,
      avgInStockSeconds: result.avgInStockSeconds,
      currentState: result.currentState,
      intervals: result.intervals.map((interval) => ({
        from: iso(interval.from),
        to: iso(interval.to),
        state: interval.state
      }))
    };
  });

export interface ItemActivitySummaryDto {
  windowSeconds: number;
  eventCounts: Record<string, number>;
  priceChangePct: number | null;
  observationCount: number;
  lastObservedAt: string | null;
}

/** Default activity-summary window: 7 days. */
const DEFAULT_ACTIVITY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const fetchItemActivitySummary = createServerFn({ method: 'GET' })
  .inputValidator(
    z.strictObject({
      marketplaceItemId: z.uuid(),
      windowSeconds: z.number().int().positive().optional()
    })
  )
  .handler(async ({ data }): Promise<ItemActivitySummaryDto> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const market = await getMarketModule();
    const summary = await market.itemActivitySummary(handle.db, {
      marketplaceItemId: data.marketplaceItemId,
      windowSeconds: data.windowSeconds ?? DEFAULT_ACTIVITY_WINDOW_SECONDS
    });
    return {
      windowSeconds: summary.windowSeconds,
      eventCounts: summary.eventCounts,
      priceChangePct: summary.priceChangePct,
      observationCount: summary.observationCount,
      lastObservedAt: iso(summary.lastObservedAt)
    };
  });

export interface MarketEventDto {
  id: string;
  eventType: string;
  detectedAt: string;
  fromObservedAt: string | null;
  toObservedAt: string;
  payload: Record<string, JsonValue>;
  ruleId: string | null;
  ruleName: string | null;
  monitorTargetId: string | null;
  monitorTargetName: string | null;
}

export interface MarketEventsPageDto {
  events: MarketEventDto[];
  total: number;
  page: number;
  pageSize: number;
}

export const MARKET_EVENTS_PAGE_SIZE = 25;

export const fetchItemEvents = createServerFn({ method: 'GET' })
  .inputValidator(
    z.strictObject({
      marketplaceItemId: z.uuid(),
      page: z.number().int().nonnegative().optional(),
      /** Whitelisted against `@loxep/market`'s `ITEM_EVENTS_SORT_KEYS` — only `detectedAt` sorts today. */
      sortBy: z.enum(['detectedAt']).optional(),
      sortDir: z.enum(['asc', 'desc']).optional()
    })
  )
  .handler(async ({ data }): Promise<MarketEventsPageDto> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const market = await getMarketModule();
    const page = data.page ?? 0;
    const pageSize = MARKET_EVENTS_PAGE_SIZE;
    const { events: pageEvents, total } = await market.listItemEventsPage(handle.db, {
      marketplaceItemId: data.marketplaceItemId,
      page,
      pageSize,
      ...(data.sortBy !== undefined ? { sortBy: data.sortBy } : {}),
      ...(data.sortDir !== undefined ? { sortDir: data.sortDir } : {})
    });
    if (pageEvents.length === 0) {
      return { events: [], total, page, pageSize };
    }

    const ruleIds = [
      ...new Set(pageEvents.map((event) => event.ruleId).filter((id): id is string => id !== null))
    ];
    const targetIds = [
      ...new Set(
        pageEvents.map((event) => event.monitorTargetId).filter((id): id is string => id !== null)
      )
    ];
    const [ruleRows, targetRows] = await Promise.all([
      ruleIds.length > 0
        ? handle.db.query.opportunityRules.findMany({
            where: (table, { inArray }) => inArray(table.id, ruleIds),
            columns: { id: true, name: true }
          })
        : Promise.resolve([]),
      targetIds.length > 0
        ? handle.db.query.monitorTargets.findMany({
            where: (table, { inArray }) => inArray(table.id, targetIds),
            columns: { id: true, name: true }
          })
        : Promise.resolve([])
    ]);
    const ruleNameById = new Map(ruleRows.map((row) => [row.id, row.name]));
    const targetNameById = new Map(targetRows.map((row) => [row.id, row.name]));

    return {
      events: pageEvents.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        detectedAt: iso(event.detectedAt),
        fromObservedAt: iso(event.fromObservedAt),
        toObservedAt: iso(event.toObservedAt),
        payload: event.payload as Record<string, JsonValue>,
        ruleId: event.ruleId,
        ruleName: event.ruleId ? (ruleNameById.get(event.ruleId) ?? null) : null,
        monitorTargetId: event.monitorTargetId,
        monitorTargetName: event.monitorTargetId
          ? (targetNameById.get(event.monitorTargetId) ?? null)
          : null
      })),
      total,
      page,
      pageSize
    };
  });

// ---------------------------------------------------------------------------
// Opportunity payload helper (shared by overview + opportunities dashboard)
// ---------------------------------------------------------------------------

/**
 * `market_events.payload.opportunity` — the block `stampEventWithRule`
 * (`@loxep/market/opportunities.ts`) merges onto a rule-stamped event's
 * payload. No typed export exists for this shape (the package deliberately
 * keeps `payload` as opaque jsonb), so it is read defensively here: a
 * present-but-malformed block returns `null` rather than throwing, since a
 * dashboard read should never break on unexpected historical data.
 */
export interface OpportunityPayloadDto {
  ruleId: string;
  ruleName: string;
  priority: number;
  score: number;
  reasons: string[];
  matchCount: number;
  evaluatedAt: string | null;
}

function readOpportunityPayload(payload: Record<string, JsonValue>): OpportunityPayloadDto | null {
  const block = payload['opportunity'];
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return null;
  const record = block as Record<string, JsonValue>;
  const ruleId = record['ruleId'];
  const score = record['score'];
  if (typeof ruleId !== 'string' || typeof score !== 'number') return null;
  const ruleName = record['ruleName'];
  const reasons = record['reasons'];
  const evaluatedAt = record['evaluatedAt'];
  return {
    ruleId,
    ruleName: typeof ruleName === 'string' ? ruleName : ruleId,
    priority: typeof record['priority'] === 'number' ? record['priority'] : 0,
    score,
    reasons: Array.isArray(reasons)
      ? reasons.filter((reason): reason is string => typeof reason === 'string')
      : [],
    matchCount: typeof record['matchCount'] === 'number' ? record['matchCount'] : 0,
    evaluatedAt: typeof evaluatedAt === 'string' ? evaluatedAt : null
  };
}

// ---------------------------------------------------------------------------
// Overview (loxep-62y.4.1, extended loxep-7dp.6 with discovery/opportunity cards)
// ---------------------------------------------------------------------------

export interface MarketEventSummaryDto {
  id: string;
  eventType: string;
  detectedAt: string;
  marketplaceItemId: string;
  itemTitle: string | null;
  monitorTargetId: string | null;
  monitorTargetName: string | null;
}

export interface TopOpportunityDto {
  id: string;
  marketplaceItemId: string;
  itemTitle: string | null;
  ruleId: string;
  ruleName: string;
  score: number;
  detectedAt: string;
}

export interface MarketOverviewTrendBucketDto {
  bucketStart: string;
  count: number;
}

export interface MarketOverviewDto {
  activeMonitorCount: number;
  watchedItemCount: number;
  eventsLast24hCount: number;
  /** New-listing discovery events (Phase 2 `ebay_search`/`ebay_seller`) in the last 24h. */
  newListingCount24h: number;
  /** Highest-scoring rule-stamped event among the most recent ones, if any. */
  topOpportunity: TopOpportunityDto | null;
  recentEvents: MarketEventSummaryDto[];
  /**
   * Hourly-bucketed count of all-item events over the trailing 24h, derived
   * in-process from `events24h` (already fetched for `eventsLast24hCount`) —
   * no extra query. Powers the overview sparkline/trend badge; not a general
   * market-wide time-series read model.
   */
  eventsTrend: MarketOverviewTrendBucketDto[];
  /**
   * Hourly-bucketed count of `new_listing` events over the trailing 24h,
   * derived in-process from `newListings24h` (already fetched for
   * `newListingCount24h`, extended with `detectedAt`) — no extra query.
   * Powers the "New listings (24h)" KPI tile sparkline.
   */
  newListingsTrend: MarketOverviewTrendBucketDto[];
}

const OVERVIEW_TREND_BUCKET_HOURS = 24;
const OVERVIEW_TREND_BUCKET_MS = 60 * 60 * 1000;

/** Hourly-bucketed count over a trailing window, in-process — shared by `eventsTrend` and `newListingsTrend`. */
function bucketHourly(rows: { detectedAt: Date }[], since: Date): MarketOverviewTrendBucketDto[] {
  const buckets: MarketOverviewTrendBucketDto[] = Array.from(
    { length: OVERVIEW_TREND_BUCKET_HOURS },
    (_, index) => ({
      bucketStart: iso(new Date(since.getTime() + index * OVERVIEW_TREND_BUCKET_MS)),
      count: 0
    })
  );
  for (const row of rows) {
    const offsetMs = row.detectedAt.getTime() - since.getTime();
    const bucketIndex = Math.min(
      OVERVIEW_TREND_BUCKET_HOURS - 1,
      Math.max(0, Math.floor(offsetMs / OVERVIEW_TREND_BUCKET_MS))
    );
    const bucket = buckets[bucketIndex];
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

const RECENT_EVENTS_LIMIT = 10;
/**
 * How many of the most recent rule-stamped events `topOpportunity` scans.
 * `market_events` has no index on `payload->'opportunity'->>'score'`, so
 * "top of the last N" (not "top of all time") keeps this an ordinary
 * `detected_at DESC LIMIT` read — see `fetchOpportunityEvents`'s doc for the
 * same trade-off spelled out at Phase 1/2 read-model scale.
 */
const TOP_OPPORTUNITY_SCAN_LIMIT = 50;

export const fetchMarketOverview = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MarketOverviewDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      activeMonitors,
      watchedItems,
      events24h,
      newListings24h,
      recentEvents,
      recentOpportunities
    ] = await Promise.all([
      handle.db.query.monitorTargets.findMany({
        where: (table, { eq }) => eq(table.enabled, true),
        columns: { id: true }
      }),
      handle.db.query.marketplaceItems.findMany({ columns: { id: true } }),
      handle.db.query.marketEvents.findMany({
        where: (table, { gt }) => gt(table.detectedAt, since),
        columns: { id: true, detectedAt: true }
      }),
      handle.db.query.marketEvents.findMany({
        where: (table, { gt, and, eq }) =>
          and(gt(table.detectedAt, since), eq(table.eventType, 'new_listing')),
        columns: { id: true, detectedAt: true }
      }),
      handle.db.query.marketEvents.findMany({
        orderBy: (table, { desc }) => [desc(table.detectedAt)],
        limit: RECENT_EVENTS_LIMIT
      }),
      handle.db.query.marketEvents.findMany({
        where: (table, { isNotNull }) => isNotNull(table.ruleId),
        orderBy: (table, { desc }) => [desc(table.detectedAt)],
        limit: TOP_OPPORTUNITY_SCAN_LIMIT
      })
    ]);

    const itemIds = [...new Set(recentEvents.map((event) => event.marketplaceItemId))];
    const targetIds = [
      ...new Set(
        recentEvents.map((event) => event.monitorTargetId).filter((id): id is string => id !== null)
      )
    ];
    const [itemRows, targetRows] = await Promise.all([
      itemIds.length > 0
        ? handle.db.query.marketplaceItems.findMany({
            where: (table, { inArray }) => inArray(table.id, itemIds),
            columns: { id: true, title: true }
          })
        : Promise.resolve([]),
      targetIds.length > 0
        ? handle.db.query.monitorTargets.findMany({
            where: (table, { inArray }) => inArray(table.id, targetIds),
            columns: { id: true, name: true }
          })
        : Promise.resolve([])
    ]);
    const itemTitleById = new Map(itemRows.map((row) => [row.id, row.title]));
    const targetNameById = new Map(targetRows.map((row) => [row.id, row.name]));

    let topOpportunity: TopOpportunityDto | null = null;
    for (const event of recentOpportunities) {
      const opportunity = readOpportunityPayload(event.payload as Record<string, JsonValue>);
      if (opportunity === null) continue;
      if (topOpportunity === null || opportunity.score > topOpportunity.score) {
        topOpportunity = {
          id: event.id,
          marketplaceItemId: event.marketplaceItemId,
          itemTitle: null,
          ruleId: opportunity.ruleId,
          ruleName: opportunity.ruleName,
          score: opportunity.score,
          detectedAt: iso(event.detectedAt)
        };
      }
    }
    if (topOpportunity !== null) {
      const item = await handle.db.query.marketplaceItems.findFirst({
        where: (table, { eq }) => eq(table.id, topOpportunity!.marketplaceItemId),
        columns: { title: true }
      });
      topOpportunity = { ...topOpportunity, itemTitle: item?.title ?? null };
    }

    const eventsTrend = bucketHourly(events24h, since);
    const newListingsTrend = bucketHourly(newListings24h, since);

    return {
      activeMonitorCount: activeMonitors.length,
      watchedItemCount: watchedItems.length,
      eventsLast24hCount: events24h.length,
      newListingCount24h: newListings24h.length,
      topOpportunity,
      eventsTrend,
      newListingsTrend,
      recentEvents: recentEvents.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        detectedAt: iso(event.detectedAt),
        marketplaceItemId: event.marketplaceItemId,
        itemTitle: itemTitleById.get(event.marketplaceItemId) ?? null,
        monitorTargetId: event.monitorTargetId,
        monitorTargetName: event.monitorTargetId
          ? (targetNameById.get(event.monitorTargetId) ?? null)
          : null
      }))
    };
  }
);

// ---------------------------------------------------------------------------
// Search/seller discovery dashboard (loxep-7dp.6, /market/searches)
//
// No `@loxep/market` read model exists yet for "discovered items per
// discovery monitor" or "recent new_listing events" — `discovery.ts` only
// exports the pure derivation functions the poller uses, not a dashboard
// read path. Implemented here as direct queries over `monitor_targets`,
// `monitor_items` (active links = currently-discovered items), and
// `market_events` (`event_type = 'new_listing'`), the same tables/relations
// `fetchMarketOverview` and `fetchMarketItems` already read.
// ---------------------------------------------------------------------------

const DISCOVERY_TARGET_TYPES = ['ebay_search', 'ebay_seller'] as const;

export interface DiscoveryMonitorStatsDto {
  monitorTargetId: string;
  /** Active `monitor_items` links — items this monitor currently has discovered. */
  discoveredItemCount: number;
  newListingCount24h: number;
  lastNewListingAt: string | null;
}

export interface NewListingEventDto {
  id: string;
  detectedAt: string;
  marketplaceItemId: string;
  itemTitle: string | null;
  itemCanonicalUrl: string | null;
  monitorTargetId: string | null;
  monitorTargetName: string | null;
}

export interface SearchDashboardDto {
  monitorStats: DiscoveryMonitorStatsDto[];
  recentNewListings: NewListingEventDto[];
}

const RECENT_NEW_LISTINGS_LIMIT = 25;

export const fetchSearchDashboard = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SearchDashboardDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const discoveryTargets = await handle.db.query.monitorTargets.findMany({
      where: (table, { inArray }) => inArray(table.targetType, [...DISCOVERY_TARGET_TYPES]),
      columns: { id: true }
    });
    const targetIds = discoveryTargets.map((row) => row.id);
    if (targetIds.length === 0) {
      return { monitorStats: [], recentNewListings: [] };
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [itemLinks, newListingEvents, recentEventRows] = await Promise.all([
      handle.db.query.monitorItems.findMany({
        where: (table, { inArray, eq, and }) =>
          and(inArray(table.monitorTargetId, targetIds), eq(table.active, true)),
        columns: { monitorTargetId: true }
      }),
      handle.db.query.marketEvents.findMany({
        where: (table, { inArray, eq, and }) =>
          and(inArray(table.monitorTargetId, targetIds), eq(table.eventType, 'new_listing')),
        columns: { monitorTargetId: true, detectedAt: true }
      }),
      handle.db.query.marketEvents.findMany({
        where: (table, { inArray, eq, and }) =>
          and(inArray(table.monitorTargetId, targetIds), eq(table.eventType, 'new_listing')),
        orderBy: (table, { desc }) => [desc(table.detectedAt)],
        limit: RECENT_NEW_LISTINGS_LIMIT
      })
    ]);

    const discoveredCountByTarget = new Map<string, number>();
    for (const link of itemLinks) {
      discoveredCountByTarget.set(
        link.monitorTargetId,
        (discoveredCountByTarget.get(link.monitorTargetId) ?? 0) + 1
      );
    }
    const newListingCount24hByTarget = new Map<string, number>();
    const lastNewListingByTarget = new Map<string, Date>();
    for (const event of newListingEvents) {
      if (event.monitorTargetId === null) continue;
      if (event.detectedAt > since) {
        newListingCount24hByTarget.set(
          event.monitorTargetId,
          (newListingCount24hByTarget.get(event.monitorTargetId) ?? 0) + 1
        );
      }
      const last = lastNewListingByTarget.get(event.monitorTargetId);
      if (last === undefined || event.detectedAt > last) {
        lastNewListingByTarget.set(event.monitorTargetId, event.detectedAt);
      }
    }

    const monitorStats: DiscoveryMonitorStatsDto[] = targetIds.map((monitorTargetId) => ({
      monitorTargetId,
      discoveredItemCount: discoveredCountByTarget.get(monitorTargetId) ?? 0,
      newListingCount24h: newListingCount24hByTarget.get(monitorTargetId) ?? 0,
      lastNewListingAt: iso(lastNewListingByTarget.get(monitorTargetId) ?? null)
    }));

    const itemIds = [...new Set(recentEventRows.map((event) => event.marketplaceItemId))];
    const eventTargetIds = [
      ...new Set(
        recentEventRows
          .map((event) => event.monitorTargetId)
          .filter((id): id is string => id !== null)
      )
    ];
    const [itemRows, targetRows] = await Promise.all([
      itemIds.length > 0
        ? handle.db.query.marketplaceItems.findMany({
            where: (table, { inArray }) => inArray(table.id, itemIds),
            columns: { id: true, title: true, canonicalUrl: true }
          })
        : Promise.resolve([]),
      eventTargetIds.length > 0
        ? handle.db.query.monitorTargets.findMany({
            where: (table, { inArray }) => inArray(table.id, eventTargetIds),
            columns: { id: true, name: true }
          })
        : Promise.resolve([])
    ]);
    const itemById = new Map(itemRows.map((row) => [row.id, row]));
    const targetNameById = new Map(targetRows.map((row) => [row.id, row.name]));

    return {
      monitorStats,
      recentNewListings: recentEventRows.map((event) => ({
        id: event.id,
        detectedAt: iso(event.detectedAt),
        marketplaceItemId: event.marketplaceItemId,
        itemTitle: itemById.get(event.marketplaceItemId)?.title ?? null,
        itemCanonicalUrl: itemById.get(event.marketplaceItemId)?.canonicalUrl ?? null,
        monitorTargetId: event.monitorTargetId,
        monitorTargetName: event.monitorTargetId
          ? (targetNameById.get(event.monitorTargetId) ?? null)
          : null
      }))
    };
  }
);

// ---------------------------------------------------------------------------
// Opportunities dashboard (loxep-7dp.6, /market/opportunities)
//
// No `@loxep/market` read model exists for "rule-stamped events" either —
// `opportunities.ts` owns evaluation/stamping (`market_events.rule_id`), not
// a paginated read. Implemented as a direct query, same two-pass
// count-then-page shape `fetchMarketItems`/`fetchItemEvents` already use at
// this scale.
// ---------------------------------------------------------------------------

export interface OpportunityEventDto {
  id: string;
  eventType: string;
  detectedAt: string;
  marketplaceItemId: string;
  itemTitle: string | null;
  itemCanonicalUrl: string | null;
  ruleId: string;
  /** The rule's CURRENT name if it still exists, else the name frozen in the payload at stamp time. */
  ruleName: string;
  score: number;
  reasons: string[];
}

export interface OpportunityEventsPageDto {
  events: OpportunityEventDto[];
  total: number;
  page: number;
  pageSize: number;
}

export const OPPORTUNITY_EVENTS_PAGE_SIZE = 25;

/**
 * `detectedAtFrom`/`detectedAtTo` are epoch-ms bounds of a half-open local-day
 * range, computed client-side (`Date` day-boundary arithmetic, DST-safe)
 * from the toolbar's single-date `detectedAt` filter — see
 * `opportunities-table/index.tsx`. Both or neither: a lone bound can't
 * express "this calendar day".
 */
const fetchOpportunityEventsInput = z
  .strictObject({
    page: z.number().int().nonnegative().optional(),
    /** Whitelisted against `@loxep/market`'s `OPPORTUNITY_EVENTS_SORT_KEYS`. */
    sortBy: z.enum(['detectedAt', 'score', 'rule']).optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    detectedAtFrom: z.number().int().optional(),
    detectedAtTo: z.number().int().optional()
  })
  .refine((data) => (data.detectedAtFrom === undefined) === (data.detectedAtTo === undefined), {
    message: 'detectedAtFrom and detectedAtTo must be provided together',
    path: ['detectedAtFrom']
  });

export const fetchOpportunityEvents = createServerFn({ method: 'GET' })
  .inputValidator(fetchOpportunityEventsInput)
  .handler(async ({ data }): Promise<OpportunityEventsPageDto> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const market = await getMarketModule();
    const page = data.page ?? 0;
    const pageSize = OPPORTUNITY_EVENTS_PAGE_SIZE;

    const { events: pageEvents, total } = await market.listOpportunityEventsPage(handle.db, {
      page,
      pageSize,
      ...(data.sortBy !== undefined ? { sortBy: data.sortBy } : {}),
      ...(data.sortDir !== undefined ? { sortDir: data.sortDir } : {}),
      ...(data.detectedAtFrom !== undefined
        ? { detectedAtFrom: new Date(data.detectedAtFrom) }
        : {}),
      ...(data.detectedAtTo !== undefined ? { detectedAtTo: new Date(data.detectedAtTo) } : {})
    });
    if (pageEvents.length === 0) {
      return { events: [], total, page, pageSize };
    }

    const itemIds = [...new Set(pageEvents.map((event) => event.marketplaceItemId))];
    const itemRows = await handle.db.query.marketplaceItems.findMany({
      where: (table, { inArray }) => inArray(table.id, itemIds),
      columns: { id: true, title: true, canonicalUrl: true }
    });
    const itemById = new Map(itemRows.map((row) => [row.id, row]));

    return {
      events: pageEvents.map((event) => {
        const opportunity = readOpportunityPayload(event.payload as Record<string, JsonValue>);
        const ruleId = event.ruleId ?? opportunity?.ruleId ?? '';
        return {
          id: event.id,
          eventType: event.eventType,
          detectedAt: iso(event.detectedAt),
          marketplaceItemId: event.marketplaceItemId,
          itemTitle: itemById.get(event.marketplaceItemId)?.title ?? null,
          itemCanonicalUrl: itemById.get(event.marketplaceItemId)?.canonicalUrl ?? null,
          ruleId,
          // Current rule name wins (renames stay reflected); falls back to the
          // name frozen in the payload at stamp time for a since-deleted rule.
          ruleName: event.currentRuleName ?? opportunity?.ruleName ?? 'unknown rule',
          score: opportunity?.score ?? 0,
          reasons: opportunity?.reasons ?? []
        };
      }),
      total,
      page,
      pageSize
    };
  });
