import * as React from 'react';
import type { Column, ColumnDef } from '@tanstack/react-table';
import {
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { formatDateTime, formatQuantity, formatTimestampPrecise } from '@/lib/format';
import { parseSortingState } from '@/lib/parsers';
import { monitorsQuery, searchDashboardQuery } from '@/features/market/api/queries';
import { applyClientSort } from '@/features/market/lib/apply-client-sort';
import { marketEventTypeTone, monitorTargetTypeLabel } from '@/features/market/constants';
import type {
  DiscoveryMonitorStatsDto,
  MonitorDto,
  NewListingEventDto
} from '@/server/market-functions';

const DEFAULT_PAGE_SIZE = 10;

interface DiscoveryMonitorRow {
  monitor: MonitorDto;
  stats: DiscoveryMonitorStatsDto | null;
}

const discoveryColumns: ColumnDef<DiscoveryMonitorRow>[] = [
  {
    id: 'name',
    accessorFn: (row) => row.monitor.name,
    header: ({ column }: { column: Column<DiscoveryMonitorRow, unknown> }) => (
      <DataTableColumnHeader column={column} title='Name' />
    ),
    cell: ({ row }) => <span className='font-medium'>{row.original.monitor.name}</span>
  },
  {
    id: 'type',
    accessorFn: (row) => row.monitor.targetType,
    enableSorting: false,
    header: 'Type',
    cell: ({ row }) => (
      <Badge variant='outline'>{monitorTargetTypeLabel(row.original.monitor.targetType)}</Badge>
    )
  },
  {
    id: 'discoveredItemCount',
    accessorFn: (row) => row.stats?.discoveredItemCount ?? 0,
    header: ({ column }: { column: Column<DiscoveryMonitorRow, unknown> }) => (
      <DataTableColumnHeader column={column} title='Discovered items' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground tabular-nums'>
        {formatQuantity(cell.getValue<number>())}
      </span>
    )
  },
  {
    id: 'newListingCount24h',
    accessorFn: (row) => row.stats?.newListingCount24h ?? 0,
    header: ({ column }: { column: Column<DiscoveryMonitorRow, unknown> }) => (
      <DataTableColumnHeader column={column} title='New listings (24h)' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground tabular-nums'>
        {formatQuantity(cell.getValue<number>())}
      </span>
    )
  },
  {
    id: 'lastNewListingAt',
    accessorFn: (row) => row.stats?.lastNewListingAt ?? null,
    header: ({ column }: { column: Column<DiscoveryMonitorRow, unknown> }) => (
      <DataTableColumnHeader column={column} title='Last new listing' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>
        {formatDateTime(cell.getValue<string | null>())}
      </span>
    )
  },
  {
    id: 'nextPollAt',
    accessorFn: (row) => row.monitor.nextPollAt,
    header: ({ column }: { column: Column<DiscoveryMonitorRow, unknown> }) => (
      <DataTableColumnHeader column={column} title='Next poll' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>
        {formatDateTime(cell.getValue<string | null>())}
      </span>
    )
  }
];

const DISCOVERY_COLUMN_IDS = discoveryColumns.map((c) => c.id).filter(Boolean) as string[];

/**
 * Per-monitor discovery stats — reuses `fetchMonitors` (the same data
 * `/market/monitors` shows) filtered to `ebay_search`/`ebay_seller`, joined
 * with `fetchSearchDashboard`'s per-monitor discovered-item counts and
 * recent `new_listing` activity (loxep-7dp.6). Both are fetched in full (no
 * server pagination), so — like `monitors-table` — this table paginates and
 * sorts the complete joined set client-side, correctly (not just "correctly
 * for the current server page").
 */
function DiscoveryMonitorsTable({ rows }: { rows: DiscoveryMonitorRow[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;

  const sorting = parseSortingState<DiscoveryMonitorRow>(sortStr, DISCOVERY_COLUMN_IDS);
  const sorted = applyClientSort(rows, sorting, {
    name: (row) => row.monitor.name,
    discoveredItemCount: (row) => row.stats?.discoveredItemCount ?? 0,
    newListingCount24h: (row) => row.stats?.newListingCount24h ?? 0,
    lastNewListingAt: (row) => row.stats?.lastNewListingAt ?? null,
    nextPollAt: (row) => row.monitor.nextPollAt
  });

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((page - 1) * perPage, page * perPage);

  const { table } = useDataTable({
    data: pageRows,
    columns: discoveryColumns,
    pageCount,
    shallow: true,
    debounceMs: 500,
    initialState: { pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}

const recentListingsColumns: ColumnDef<NewListingEventDto>[] = [
  {
    id: 'item',
    accessorFn: (row) => row.itemTitle ?? row.marketplaceItemId,
    header: 'Item',
    cell: ({ row }) => (
      <div className='flex flex-col gap-0.5'>
        <div className='flex items-center gap-2'>
          <Badge variant={marketEventTypeTone('new_listing')}>
            <Icons.sparkles />
            New
          </Badge>
          <Link
            to='/market/items/$itemId'
            params={{ itemId: row.original.marketplaceItemId }}
            className='font-medium hover:underline'
          >
            {row.original.itemTitle ?? row.original.marketplaceItemId}
          </Link>
        </div>
        {row.original.itemCanonicalUrl && (
          <a
            href={row.original.itemCanonicalUrl}
            target='_blank'
            rel='noreferrer'
            className='text-muted-foreground text-xs hover:underline'
          >
            View on eBay ↗
          </a>
        )}
      </div>
    )
  },
  {
    id: 'monitor',
    accessorFn: (row) => row.monitorTargetName ?? '—',
    enableSorting: false,
    header: 'Via monitor',
    cell: ({ cell }) => <span className='text-muted-foreground'>{cell.getValue<string>()}</span>
  },
  {
    id: 'detectedAt',
    accessorKey: 'detectedAt',
    header: ({ column }: { column: Column<NewListingEventDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Detected' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>
        {formatTimestampPrecise(cell.getValue<string>())}
      </span>
    )
  }
];

/**
 * `fetchSearchDashboard` returns at most `RECENT_NEW_LISTINGS_LIMIT` (25)
 * rows and takes no `page` parameter — the whole result set is already in
 * memory, so pagination/sorting here is genuinely correct over the full
 * set, not just the current page. Pagination/sort state is local
 * (`useReactTable`, not `useDataTable`) rather than URL-synced: this table
 * shares `/market/searches` with `DiscoveryMonitorsTable` above, and
 * `useDataTable` reads/writes fixed `page`/`perPage`/`sort` search-param
 * names (`@/hooks/use-data-table.ts`) with no per-table prefix, so two
 * URL-synced tables on one route would collide, each one's paging
 * clobbering the other's. `DiscoveryMonitorsTable` — the primary table on
 * this route — keeps the URL-synced behavior; this one degrades to
 * component-local state instead of colliding with it.
 */
function RecentNewListingsTable({ events }: { events: NewListingEventDto[] }) {
  const table = useReactTable({
    data: events,
    columns: recentListingsColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE } }
  });

  return <DataTable table={table} />;
}

/**
 * Both sections below read `monitorsQuery` and `searchDashboardQuery`
 * jointly at THIS level (one pending/error gate), rather than each section
 * running its own `useQuery` — the original component nested an outer
 * `monitorsQuery` gate around an inner `searchDashboardQuery` gate, so a
 * cold load showed skeleton → skeleton → table (Frontend Standards, "Never
 * nest loading gates").
 */
export default function SearchDashboard() {
  const monitorsResult = useQuery(monitorsQuery);
  const statsResult = useQuery(searchDashboardQuery);

  const isPending = monitorsResult.isPending || statsResult.isPending;
  const isError = monitorsResult.isError || statsResult.isError;
  const error = monitorsResult.error ?? statsResult.error;
  const retry = () => {
    void monitorsResult.refetch();
    void statsResult.refetch();
  };

  const discoveryRows = React.useMemo<DiscoveryMonitorRow[]>(() => {
    if (!monitorsResult.data || !statsResult.data) return [];
    const statsByMonitor = new Map(
      statsResult.data.monitorStats.map((row) => [row.monitorTargetId, row])
    );
    return monitorsResult.data
      .filter(
        (monitor) => monitor.targetType === 'ebay_search' || monitor.targetType === 'ebay_seller'
      )
      .map((monitor) => ({ monitor, stats: statsByMonitor.get(monitor.id) ?? null }));
  }, [monitorsResult.data, statsResult.data]);

  return (
    <div className='flex flex-col gap-6'>
      <div className='flex flex-col gap-2'>
        <h2 className='text-lg font-semibold'>Search and seller monitors</h2>
        {isPending ? (
          <DataTableSkeleton columnCount={6} filterCount={0} />
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load discovery monitors'
            onRetry={retry}
          />
        ) : discoveryRows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.search />
              </EmptyMedia>
              <EmptyTitle>No search or seller monitors</EmptyTitle>
              <EmptyDescription>
                Create an eBay search or seller monitor from /market/monitors to start discovering
                new listings.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DiscoveryMonitorsTable rows={discoveryRows} />
        )}
      </div>
      <div className='flex flex-col gap-2'>
        <h2 className='text-lg font-semibold'>Recent new listings</h2>
        {isPending ? (
          <DataTableSkeleton columnCount={3} filterCount={0} />
        ) : isError ? (
          <QueryErrorAlert error={error} title='Could not load recent listings' onRetry={retry} />
        ) : statsResult.data && statsResult.data.recentNewListings.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.sparkles />
              </EmptyMedia>
              <EmptyTitle>No new listings yet</EmptyTitle>
              <EmptyDescription>
                `new_listing` events fire when a search or seller monitor discovers an item Loxep
                has never seen before.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <RecentNewListingsTable events={statsResult.data?.recentNewListings ?? []} />
        )}
      </div>
    </div>
  );
}
