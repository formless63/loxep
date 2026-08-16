import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { parseSortingState } from '@/lib/parsers';
import {
  inventoryItemsQuery,
  inventoryLocationsQuery,
  type ItemFilterParams
} from '@/features/inventory/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { sortRows } from '@/features/market/lib/sort-rows';
import type { InventoryItemListItemDto } from '@/server/inventory-functions';
import { createColumns } from './columns';

const COLUMN_IDS = [
  'itemCode',
  'label',
  'status',
  'conditionCode',
  'locationId',
  'quantityOnHand',
  'landedCostAmount',
  'acquiredAt'
];

const DEFAULT_PAGE_SIZE = 10;

/**
 * Stock list — status/location/condition filters read straight from the URL
 * (`DataTableToolbar`'s column filter popovers write there), same as
 * `ExpensesTable`. `fetchInventoryItems` filters server-side and returns the
 * bounded result unpaginated; the table sorts/pages it client-side.
 */
export default function ItemsTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;

  const status = search.status as string | undefined;
  const locationId = search.locationId as string | undefined;
  const conditionCode = search.conditionCode as string | undefined;

  const filter: ItemFilterParams = {
    ...(status ? { status } : {}),
    ...(locationId ? { locationId } : {}),
    ...(conditionCode ? { conditionCode } : {})
  };

  const { data: locations } = useQuery(inventoryLocationsQuery);
  const { data, isPending, isError, error, refetch } = useQuery(inventoryItemsQuery(filter));

  if (isPending || locations === undefined) {
    return <DataTableSkeleton columnCount={8} filterCount={4} />;
  }

  if (isError) {
    return <QueryErrorAlert error={error} title='Could not load stock' onRetry={() => refetch()} />;
  }

  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.product />
          </EmptyMedia>
          <EmptyTitle>No stock yet</EmptyTitle>
          <EmptyDescription>
            Items land here from intake — hand entry today, an ingested purchase or a parsed receipt
            in a later milestone. They all go through the same review queue.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ItemsDataTable
      items={data}
      locationOptions={locations.map((location) => ({
        value: location.id,
        label: `${location.code} — ${location.name}`
      }))}
    />
  );
}

function ItemsDataTable({
  items,
  locationOptions
}: {
  items: InventoryItemListItemDto[];
  locationOptions: { value: string; label: string }[];
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;

  const columns = React.useMemo(() => createColumns(locationOptions), [locationOptions]);

  const sorting = parseSortingState<InventoryItemListItemDto>(sortStr, COLUMN_IDS);
  const sorted = sortRows(items, sorting, {
    itemCode: (row) => row.itemCode,
    quantityOnHand: (row) => Number(row.quantityOnHand),
    landedCostAmount: (row) => Number(row.landedCostAmount),
    acquiredAt: (row) => row.acquiredAt
  });

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((page - 1) * perPage, page * perPage);

  const { table } = useDataTable({
    data: pageRows,
    columns,
    pageCount,
    getRowId: (item) => item.id,
    shallow: true,
    debounceMs: 500,
    initialState: {
      pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE }
    }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
