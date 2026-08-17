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
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { DataTableFeatures } from '@/lib/table-features';
import type { MarketItemDto, MarketItemsPageDto } from '@/server/market-functions';
import { createColumns } from './columns';

/**
 * Column ids for parsing the URL `sort` param — fixed regardless of the
 * "Monitors" facet's live `meta.options` (`createColumns`' only
 * data-dependent bit), so this doesn't need `monitorOptions` to exist.
 */
const ITEM_COLUMN_IDS = [
  'item',
  'currentState',
  'price',
  'priceTrend',
  'availability',
  'quantity',
  'listingState',
  'lastObserved',
  'monitorTargetId'
];

/**
 * The one column `fetchMarketItems` accepts a sort for (`@loxep/market`'s
 * `WATCHED_ITEM_SORT_KEYS`). Column ids are UI-level identifiers, not all of
 * them literal `MarketItemDto` keys (`lastObserved` is accessor-derived from
 * `latestObservation.observedAt`), so this parses against a loose `id:
 * string` shape rather than `ExtendedColumnSort<MarketItemDto>` — the
 * `ITEM_COLUMN_IDS` whitelist still enforces which ids are accepted.
 */
function marketItemsSortParams(sortStr: string | undefined) {
  const [sort] = parseSortingState<Record<string, unknown>>(sortStr, ITEM_COLUMN_IDS);
  if (sort?.id !== 'lastObserved') return {};
  return {
    sortBy: 'lastObserved' as const,
    sortDir: sort.desc ? ('desc' as const) : ('asc' as const)
  };
}

/**
 * Watched items joined with their latest observation (loxep-62y.4.2). The
 * "Monitors" column doubles as the monitor facet — replacing the hand-rolled
 * `<Select>` — but the actual restriction still happens server-side (a
 * single `monitorTargetId`, `fetchMarketItems`'s only filter param), read
 * straight off the URL rather than through TanStack's client-side filtering
 * (`useDataTable` always sets `manualFiltering: true`). Sorting is likewise
 * server-truthful over the full dataset (loxep-foi.7) — `sort` is read here,
 * before the query fires, and passed through to `fetchMarketItems`.
 */
export default function ItemsTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const serverPage = Math.max(0, page - 1);
  const monitorFilterValue = search.monitorTargetId;
  const monitorTargetId = typeof monitorFilterValue === 'string' ? monitorFilterValue : null;
  const sortParams = marketItemsSortParams(search.sort as string | undefined);

  const { data: monitors } = useQuery(monitorsQuery);
  const { data, isPending, isError, error, refetch } = useQuery(
    marketItemsQuery({ page: serverPage, monitorTargetId, ...sortParams })
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
  columns: ColumnDef<DataTableFeatures, MarketItemDto>[];
}) {
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  const { table } = useDataTable({
    data: data.items,
    columns,
    pageCount,
    getRowId: (item) => item.id,
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
