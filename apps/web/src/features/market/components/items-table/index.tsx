import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
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
import { marketItemsQuery, monitorsQuery } from '@/features/market/api/queries';
import { applyClientSort } from '@/features/market/lib/apply-client-sort';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { MarketItemDto, MarketItemsPageDto } from '@/server/market-functions';
import { createColumns } from './columns';

/**
 * Watched items joined with their latest observation (loxep-62y.4.2). The
 * "Monitors" column doubles as the monitor facet — replacing the hand-rolled
 * `<Select>` — but the actual restriction still happens server-side (a
 * single `monitorTargetId`, `fetchMarketItems`'s only filter param), read
 * straight off the URL rather than through TanStack's client-side filtering
 * (`useDataTable` always sets `manualFiltering: true`).
 */
export default function ItemsTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const serverPage = Math.max(0, page - 1);
  const monitorFilterValue = search.monitorTargetId;
  const monitorTargetId = typeof monitorFilterValue === 'string' ? monitorFilterValue : null;

  const { data: monitors } = useQuery(monitorsQuery);
  const { data, isPending, isError, error, refetch } = useQuery(
    marketItemsQuery({ page: serverPage, monitorTargetId })
  );

  const monitorOptions = React.useMemo(
    () => (monitors ?? []).map((monitor) => ({ value: monitor.id, label: monitor.name })),
    [monitors]
  );
  const columns = React.useMemo(() => createColumns(monitorOptions), [monitorOptions]);

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={1} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load watched items'
        onRetry={() => refetch()}
      />
    );
  }

  if (data.total === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.product />
          </EmptyMedia>
          <EmptyTitle>No watched items</EmptyTitle>
          <EmptyDescription>
            Items appear here once live polling records observations for a monitor. Until then — or
            with the selected monitor filter — this list is empty.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <ItemsDataTable data={data} columns={columns} />;
}

function ItemsDataTable({
  data,
  columns
}: {
  data: MarketItemsPageDto;
  columns: ColumnDef<MarketItemDto>[];
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const sortStr = search.sort as string | undefined;
  const columnIds = React.useMemo(
    () => columns.map((column) => column.id).filter(Boolean) as string[],
    [columns]
  );
  const sorting = parseSortingState<MarketItemDto>(sortStr, columnIds);

  const sorted = applyClientSort(data.items, sorting, {
    lastObserved: (row) => row.latestObservation?.observedAt ?? null
  });

  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  const { table } = useDataTable({
    data: sorted,
    columns,
    pageCount,
    shallow: true,
    debounceMs: 500,
    initialState: { pagination: { pageIndex: 0, pageSize: data.pageSize } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
