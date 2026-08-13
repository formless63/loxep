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
import { catalogItemsQuery } from '@/features/commerce/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { sortRows } from '@/features/market/lib/sort-rows';
import type { CatalogItemListItemDto } from '@/server/commerce-functions';
import { createColumns } from './columns';

const COLUMN_IDS = ['sku', 'defaultPrice', 'createdAt'];
const DEFAULT_PAGE_SIZE = 10;

/**
 * Read-only for this milestone: catalog items are minted automatically at
 * listing time (design 4b's "cheap answer" to open question 5), never
 * authored directly.
 */
export default function CatalogTable() {
  const { data, isPending, isError, error, refetch } = useQuery(catalogItemsQuery);

  if (isPending) {
    return <DataTableSkeleton columnCount={5} filterCount={1} />;
  }
  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load catalog' onRetry={() => refetch()} />
    );
  }
  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.product />
          </EmptyMedia>
          <EmptyTitle>No catalog items yet</EmptyTitle>
          <EmptyDescription>
            A catalog item is minted automatically the first time an inventory item is listed.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <CatalogDataTable items={data} />;
}

function CatalogDataTable({ items }: { items: CatalogItemListItemDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;

  const columns = React.useMemo(() => createColumns(), []);
  const sorting = parseSortingState<CatalogItemListItemDto>(sortStr, COLUMN_IDS);
  const sorted = sortRows(items, sorting, {
    sku: (row) => row.sku,
    defaultPrice: (row) => (row.defaultPrice ? Number(row.defaultPrice) : 0),
    createdAt: (row) => row.createdAt
  });

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((page - 1) * perPage, page * perPage);

  const { table } = useDataTable({
    data: pageRows,
    columns,
    pageCount,
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
