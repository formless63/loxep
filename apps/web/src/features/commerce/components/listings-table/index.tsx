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
import { channelListingsQuery, type ListingFilterParams } from '@/features/commerce/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { sortRows } from '@/features/market/lib/sort-rows';
import type { ChannelListingListItemDto } from '@/server/commerce-functions';
import { createColumns } from './columns';

const COLUMN_IDS = ['listingCode', 'status', 'price', 'createdAt'];
const DEFAULT_PAGE_SIZE = 10;

/**
 * Listings list — status filter reads straight from the URL
 * (`DataTableToolbar`'s column filter popovers write there), same as
 * `ItemsTable`. `fetchChannelListings` filters server-side and returns the
 * bounded result unpaginated; the table sorts/pages it client-side.
 */
export default function ListingsTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const status = search.status as string | undefined;

  const filter: ListingFilterParams = status ? { status } : {};
  const { data, isPending, isError, error, refetch } = useQuery(channelListingsQuery(filter));

  if (isPending) {
    return <DataTableSkeleton columnCount={6} filterCount={2} />;
  }
  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load listings' onRetry={() => refetch()} />
    );
  }
  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.billing />
          </EmptyMedia>
          <EmptyTitle>No listings yet</EmptyTitle>
          <EmptyDescription>
            Create a manual listing for an inventory item to list it on Facebook Marketplace,
            Craigslist, or another offline channel.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <ListingsDataTable listings={data} />;
}

function ListingsDataTable({ listings }: { listings: ChannelListingListItemDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;

  const columns = React.useMemo(() => createColumns(), []);
  const sorting = parseSortingState<ChannelListingListItemDto>(sortStr, COLUMN_IDS);
  const sorted = sortRows(listings, sorting, {
    listingCode: (row) => row.listingCode,
    price: (row) => (row.price ? Number(row.price) : 0),
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
