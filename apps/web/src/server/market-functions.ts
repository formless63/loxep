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
 * documented on `getStorageBackendsService`.
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
 * required.
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
  })
]);

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
      config: data.targetType === 'ebay_item' ? { externalItemId: data.externalItemId } : {},
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
    externalItemId: z.string().trim().min(1).optional()
  })
  .refine((patch) => Object.keys(patch).length > 1, { message: 'empty update' });

export const updateMonitor = createServerFn({ method: 'POST' })
  .inputValidator(updateMonitorInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getMonitorService } = await import('@/server/admin');
    await requireAdmin();
    const monitorService = await getMonitorService();
    const { id, externalItemId, ...patch } = data;
    let config: Record<string, unknown> | undefined;
    if (externalItemId !== undefined) {
      const existing = await monitorService.getTarget(id);
      config = { ...(existing.config as Record<string, unknown>), externalItemId };
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

/** Lightweight eBay-connection picker list for the monitor dialog. */
export const fetchEbayConnectionOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().connections.listConnections({ provider: 'ebay' });
    return rows.map((row) => ({ id: row.id, name: row.name, status: row.status }));
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

const fetchMarketItemsInput = z.strictObject({
  page: z.number().int().nonnegative().optional(),
  /** Restrict to items currently linked (actively discovered) by one monitor. */
  monitorTargetId: z.uuid().nullable().optional()
});

export const fetchMarketItems = createServerFn({ method: 'GET' })
  .inputValidator(fetchMarketItemsInput)
  .handler(async ({ data }): Promise<MarketItemsPageDto> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
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

    // Two-pass read (ids, then page rows) — no aggregate/count helper is
    // available through the relational query callback API; volumes here are
    // Phase 1 scale (see `@loxep/market/metrics.ts`'s continuous-aggregate
    // trigger-criteria note for when this would need revisiting).
    const idRows = await handle.db.query.marketplaceItems.findMany({
      where: allowedIds
        ? (table, { inArray }) => inArray(table.id, allowedIds as string[])
        : undefined,
      columns: { id: true },
      orderBy: (table, { desc }) => [desc(table.lastSeenAt)]
    });
    const total = idRows.length;
    const pageIds = idRows.slice(page * pageSize, (page + 1) * pageSize).map((row) => row.id);
    if (pageIds.length === 0) {
      return { items: [], total, page, pageSize };
    }

    const market = await getMarketModule();
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
      page: z.number().int().nonnegative().optional()
    })
  )
  .handler(async ({ data }): Promise<MarketEventsPageDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const page = data.page ?? 0;
    const pageSize = MARKET_EVENTS_PAGE_SIZE;
    const allEvents = await handle.db.query.marketEvents.findMany({
      where: (table, { eq }) => eq(table.marketplaceItemId, data.marketplaceItemId),
      orderBy: (table, { desc }) => [desc(table.detectedAt)]
    });
    const total = allEvents.length;
    const pageEvents = allEvents.slice(page * pageSize, (page + 1) * pageSize);
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
// Overview (loxep-62y.4.1)
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

export interface MarketOverviewDto {
  activeMonitorCount: number;
  watchedItemCount: number;
  eventsLast24hCount: number;
  recentEvents: MarketEventSummaryDto[];
}

const RECENT_EVENTS_LIMIT = 10;

export const fetchMarketOverview = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MarketOverviewDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [activeMonitors, watchedItems, events24h, recentEvents] = await Promise.all([
      handle.db.query.monitorTargets.findMany({
        where: (table, { eq }) => eq(table.enabled, true),
        columns: { id: true }
      }),
      handle.db.query.marketplaceItems.findMany({ columns: { id: true } }),
      handle.db.query.marketEvents.findMany({
        where: (table, { gt }) => gt(table.detectedAt, since),
        columns: { id: true }
      }),
      handle.db.query.marketEvents.findMany({
        orderBy: (table, { desc }) => [desc(table.detectedAt)],
        limit: RECENT_EVENTS_LIMIT
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

    return {
      activeMonitorCount: activeMonitors.length,
      watchedItemCount: watchedItems.length,
      eventsLast24hCount: events24h.length,
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
