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
import { ordersQuery, type OrderFilterParams } from '@/features/commerce/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { sortRows } from '@/features/market/lib/sort-rows';
import type { OrderListItemDto } from '@/server/orders-functions';
import { createColumns } from './columns';

const COLUMN_IDS = [
  'order',
  'provider',
  'channel',
  'status',
  'paymentStatus',
  'placedAt',
  'totalAmount'
];
const DEFAULT_PAGE_SIZE = 10;

/**
 * `placedAt`'s `dateRange` filter writes `"<fromMs>,<toMs>"` into the URL
 * (`useDataTable`'s array-filter serialization) — parsed here rather than
 * relying on TanStack Table's own filtering, because `manualFiltering: true`
 * (URL-synced state) means the table never applies it itself; the caller
 * owns narrowing `data` to match, same as `provider`/`status` below.
 */
function filterByPlacedAtRange(
  rows: OrderListItemDto[],
  param: string | undefined
): OrderListItemDto[] {
  if (!param) return rows;
  const [fromRaw, toRaw] = param.split(',');
  const from = fromRaw ? Number(fromRaw) : undefined;
  const to = toRaw ? Number(toRaw) : undefined;
  const hasFrom = from !== undefined && !Number.isNaN(from);
  const hasTo = to !== undefined && !Number.isNaN(to);
  if (!hasFrom && !hasTo) return rows;
  return rows.filter((row) => {
    const placedAtMs = new Date(row.placedAt).getTime();
    if (hasFrom && placedAtMs < (from as number)) return false;
    if (hasTo && placedAtMs > (to as number)) return false;
    return true;
  });
}

/**
 * Orders list — `provider`/`status` filter server-side (`fetchOrders`
 * pushes them into the query, same as `ListingsTable`'s `status`); `fetchOrders`
 * returns every non-duplicate row unbounded (schema design's own volume
 * estimate: hundreds to thousands per month, not millions), so the date
 * range filter, sort, and pagination below are honest client-side work over
 * the complete result, not a "current page only" shortcut (Frontend
 * Standards, "Tables").
 */
export default function OrdersTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const provider = search.provider as string | undefined;
  const status = search.status as string | undefined;

  const filter: OrderFilterParams = {};
  if (provider) filter.provider = provider;
  if (status) filter.status = status;
  const { data, isPending, isError, error, refetch } = useQuery(ordersQuery(filter));

  if (isPending) {
    return <DataTableSkeleton columnCount={7} filterCount={3} />;
  }
  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load orders' onRetry={() => refetch()} />
    );
  }
  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.orders />
          </EmptyMedia>
          <EmptyTitle>No orders yet</EmptyTitle>
          <EmptyDescription>
            Connector-synced orders appear here once a connection's order sync runs, and a manual
            sale appears here as soon as it is recorded from a listing.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <OrdersDataTable orders={data} />;
}

function OrdersDataTable({ orders }: { orders: OrderListItemDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;
  const placedAtParam = search.placedAt as string | undefined;

  const columns = React.useMemo(() => createColumns(), []);
  const filtered = filterByPlacedAtRange(orders, placedAtParam);
  const sorting = parseSortingState<OrderListItemDto>(sortStr, COLUMN_IDS);
  const sorted = sortRows(filtered, sorting, {
    placedAt: (row) => row.placedAt,
    totalAmount: (row) => Number(row.totalAmount)
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
