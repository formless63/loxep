import { queryOptions } from '@tanstack/react-query';
import {
  fetchAcquisition,
  fetchAcquisitions,
  fetchInventoryItem,
  fetchInventoryItems,
  fetchInventoryLocations,
  fetchInventoryMovements,
  fetchInventoryMovementTrend,
  fetchInventoryProfitability,
  fetchMarketItemAcquisitionLinks,
  fetchShipmentsForOrder
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

/** `/inventory/movements`'s stacked-by-kind trend (loxep-8e2, priority 1) — see `fetchInventoryMovementTrend`'s doc for the 90-day bound. */
export const inventoryMovementTrendQuery = queryOptions({
  queryKey: ['inventory', 'movements', 'trend'],
  queryFn: () => fetchInventoryMovementTrend()
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

/** `/inventory/profitability` (loxep-7fs, A11) — one combined DTO, one round trip. */
export const inventoryProfitabilityQuery = queryOptions({
  queryKey: ['inventory', 'profitability'],
  queryFn: () => fetchInventoryProfitability()
});

/** `/commerce/orders/$id`'s shipments section (loxep-7fs, A14). */
export const shipmentsForOrderQuery = (orderId: string) =>
  queryOptions({
    queryKey: ['inventory', 'shipments', 'order', orderId],
    queryFn: () => fetchShipmentsForOrder({ data: { orderId } })
  });

/** The "we bought one" panel on `/market/items/$itemId`. */
export const marketItemAcquisitionLinksQuery = (marketplaceItemId: string) =>
  queryOptions({
    queryKey: ['inventory', 'market-item-links', marketplaceItemId],
    queryFn: () => fetchMarketItemAcquisitionLinks({ data: { marketplaceItemId } })
  });
