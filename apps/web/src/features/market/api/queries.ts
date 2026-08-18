import { queryOptions } from '@tanstack/react-query';
import {
  fetchEbayConnectionOptions,
  fetchItemActivitySummary,
  fetchItemAvailabilityHistory,
  fetchItemEvents,
  fetchItemPriceHistory,
  fetchItemRestockSellout,
  fetchMarketItem,
  fetchMarketItems,
  fetchMarketOverview,
  fetchMonitorDefaults,
  fetchMonitors,
  fetchOpportunityEvents,
  fetchOpportunityRules,
  fetchSearchDashboard
} from '@/server/market-functions';

export const marketOverviewQuery = queryOptions({
  queryKey: ['market', 'overview'],
  queryFn: () => fetchMarketOverview(),
  refetchInterval: 30_000
});

export const monitorsQuery = queryOptions({
  queryKey: ['market', 'monitors'],
  queryFn: () => fetchMonitors(),
  refetchInterval: 30_000
});

export const ebayConnectionOptionsQuery = queryOptions({
  queryKey: ['market', 'ebay-connection-options'],
  queryFn: () => fetchEbayConnectionOptions()
});

/** Installation-wide monitor cadence baseline (loxep-62y.2.7). */
export const monitorDefaultsQuery = queryOptions({
  queryKey: ['market', 'monitor-defaults'],
  queryFn: () => fetchMonitorDefaults()
});

export interface MarketItemsQueryParams {
  page: number;
  monitorTargetId: string | null;
  /** Whitelisted against `@loxep/market`'s `WATCHED_ITEM_SORT_KEYS` — only `lastObserved` sorts today. */
  sortBy?: 'lastObserved';
  sortDir?: 'asc' | 'desc';
}

export const marketItemsQuery = (params: MarketItemsQueryParams) =>
  queryOptions({
    queryKey: ['market', 'items', params],
    queryFn: () => fetchMarketItems({ data: params })
  });

export const marketItemQuery = (itemId: string) =>
  queryOptions({
    queryKey: ['market', 'items', itemId],
    queryFn: () => fetchMarketItem({ data: { id: itemId } })
  });

export const itemPriceHistoryQuery = (marketplaceItemId: string) =>
  queryOptions({
    queryKey: ['market', 'items', marketplaceItemId, 'price-history'],
    queryFn: () => fetchItemPriceHistory({ data: { marketplaceItemId } })
  });

export const itemAvailabilityHistoryQuery = (marketplaceItemId: string) =>
  queryOptions({
    queryKey: ['market', 'items', marketplaceItemId, 'availability-history'],
    queryFn: () => fetchItemAvailabilityHistory({ data: { marketplaceItemId } })
  });

export const itemRestockSelloutQuery = (marketplaceItemId: string) =>
  queryOptions({
    queryKey: ['market', 'items', marketplaceItemId, 'restock-sellout'],
    queryFn: () => fetchItemRestockSellout({ data: { marketplaceItemId } })
  });

export const itemActivitySummaryQuery = (marketplaceItemId: string) =>
  queryOptions({
    queryKey: ['market', 'items', marketplaceItemId, 'activity-summary'],
    queryFn: () => fetchItemActivitySummary({ data: { marketplaceItemId } })
  });

export const itemEventsQuery = (
  marketplaceItemId: string,
  page: number,
  sortDir?: 'asc' | 'desc'
) =>
  queryOptions({
    queryKey: ['market', 'items', marketplaceItemId, 'events', page, sortDir ?? null],
    queryFn: () =>
      fetchItemEvents({
        data: {
          marketplaceItemId,
          page,
          ...(sortDir !== undefined ? { sortBy: 'detectedAt' as const, sortDir } : {})
        }
      })
  });

export const searchDashboardQuery = queryOptions({
  queryKey: ['market', 'search-dashboard'],
  queryFn: () => fetchSearchDashboard(),
  refetchInterval: 30_000
});

export interface OpportunityEventsQueryParams {
  page: number;
  /** Whitelisted against `@loxep/market`'s `OPPORTUNITY_EVENTS_SORT_KEYS`. */
  sortBy?: 'detectedAt' | 'score' | 'rule';
  sortDir?: 'asc' | 'desc';
  /** Epoch-ms half-open local-day bounds; both or neither. */
  detectedAtFrom?: number;
  detectedAtTo?: number;
}

export const opportunityEventsQuery = (params: OpportunityEventsQueryParams) =>
  queryOptions({
    queryKey: ['market', 'opportunities', params],
    queryFn: () => fetchOpportunityEvents({ data: params }),
    refetchInterval: 30_000
  });

/** `/market/rules` (loxep-7fs, A16) — the only way to author scoring rules. */
export const opportunityRulesQuery = queryOptions({
  queryKey: ['market', 'rules'],
  queryFn: () => fetchOpportunityRules()
});
