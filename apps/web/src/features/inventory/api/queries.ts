import { queryOptions } from '@tanstack/react-query';
import {
  fetchAcquisition,
  fetchAcquisitions,
  fetchInventoryItem,
  fetchInventoryItems,
  fetchInventoryLocations,
  fetchInventoryMovements,
  fetchMarketItemAcquisitionLinks
} from '@/server/inventory-functions';

export interface ItemFilterParams {
  status?: string;
  locationId?: string;
  conditionCode?: string;
}

export const inventoryItemsQuery = (filter: ItemFilterParams) =>
  queryOptions({
    queryKey: ['inventory', 'items', filter],
    queryFn: () => fetchInventoryItems({ data: filter })
  });

export const inventoryItemQuery = (id: string) =>
  queryOptions({
    queryKey: ['inventory', 'item', id],
    queryFn: () => fetchInventoryItem({ data: { id } })
  });

export const inventoryLocationsQuery = queryOptions({
  queryKey: ['inventory', 'locations'],
  queryFn: () => fetchInventoryLocations()
});

export interface MovementFilterParams {
  inventoryItemId?: string;
  acquisitionId?: string;
  movementKind?: string;
}

export const inventoryMovementsQuery = (filter: MovementFilterParams) =>
  queryOptions({
    queryKey: ['inventory', 'movements', filter],
    queryFn: () => fetchInventoryMovements({ data: filter })
  });

export interface AcquisitionFilterParams {
  status?: string;
  sourceKind?: string;
  connectionId?: string;
}

export const acquisitionsQuery = (filter: AcquisitionFilterParams) =>
  queryOptions({
    queryKey: ['inventory', 'acquisitions', filter],
    queryFn: () => fetchAcquisitions({ data: filter })
  });

export const acquisitionQuery = (id: string) =>
  queryOptions({
    queryKey: ['inventory', 'acquisition', id],
    queryFn: () => fetchAcquisition({ data: { id } })
  });

/** The "we bought one" panel on `/market/items/$itemId`. */
export const marketItemAcquisitionLinksQuery = (marketplaceItemId: string) =>
  queryOptions({
    queryKey: ['inventory', 'market-item-links', marketplaceItemId],
    queryFn: () => fetchMarketItemAcquisitionLinks({ data: { marketplaceItemId } })
  });
