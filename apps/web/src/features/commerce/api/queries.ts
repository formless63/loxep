import { queryOptions } from '@tanstack/react-query';
import {
  fetchCatalogItems,
  fetchChannelListing,
  fetchChannelListings,
  fetchListingsForInventoryItem
} from '@/server/commerce-functions';

export interface ListingFilterParams {
  status?: string;
  provider?: string;
  channel?: string;
}

export const channelListingsQuery = (filter: ListingFilterParams) =>
  queryOptions({
    queryKey: ['commerce', 'listings', filter],
    queryFn: () => fetchChannelListings({ data: filter })
  });

export const channelListingQuery = (id: string) =>
  queryOptions({
    queryKey: ['commerce', 'listing', id],
    queryFn: () => fetchChannelListing({ data: { id } })
  });

export const catalogItemsQuery = queryOptions({
  queryKey: ['commerce', 'catalog'],
  queryFn: () => fetchCatalogItems()
});

/** The item-detail panel's read — "the weave": item detail gains a listings panel. */
export const inventoryItemListingsQuery = (inventoryItemId: string) =>
  queryOptions({
    queryKey: ['commerce', 'inventory-item-listings', inventoryItemId],
    queryFn: () => fetchListingsForInventoryItem({ data: { inventoryItemId } })
  });
