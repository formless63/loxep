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
  fetchMonitors,
  fetchOpportunityEvents,
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

export const marketItemsQuery = (params: { page: number; monitorTargetId: string | null }) =>
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

export const itemEventsQuery = (marketplaceItemId: string, page: number) =>
  queryOptions({
    queryKey: ['market', 'items', marketplaceItemId, 'events', page],
    queryFn: () => fetchItemEvents({ data: { marketplaceItemId, page } })
  });

export const searchDashboardQuery = queryOptions({
  queryKey: ['market', 'search-dashboard'],
  queryFn: () => fetchSearchDashboard(),
  refetchInterval: 30_000
});

export const opportunityEventsQuery = (page: number) =>
  queryOptions({
    queryKey: ['market', 'opportunities', page],
    queryFn: () => fetchOpportunityEvents({ data: { page } }),
    refetchInterval: 30_000
  });
