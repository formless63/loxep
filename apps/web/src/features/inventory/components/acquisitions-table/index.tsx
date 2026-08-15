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
import { acquisitionsQuery, type AcquisitionFilterParams } from '@/features/inventory/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { sortRows } from '@/features/market/lib/sort-rows';
import type { AcquisitionListItemDto } from '@/server/inventory-functions';
import { columns, columnIds } from './columns';

const DEFAULT_PAGE_SIZE = 10;

/** Acquisitions (lots) list — status/source filters, same URL-synced pattern as `ItemsTable`. */
export default function AcquisitionsTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const status = search.status as string | undefined;
  const sourceKind = search.sourceKind as string | undefined;
  const connectionId = search.connectionId as string | undefined;

  const filter: AcquisitionFilterParams = {
    ...(status ? { status } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(connectionId ? { connectionId } : {})
  };

  const { data, isPending, isError, error, refetch } = useQuery(acquisitionsQuery(filter));

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load acquisitions'
        onRetry={() => refetch()}
      />
    );
  }

  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.billing />
          </EmptyMedia>
          <EmptyTitle>No acquisitions yet</EmptyTitle>
          <EmptyDescription>
            A lot is a purchase, however it arrived — an auction box, an estate sale, a marketplace
            "I bought this". Its cost is entered as components and allocated across whatever turns
            up inside.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <AcquisitionsDataTable acquisitions={data} />;
}

function AcquisitionsDataTable({ acquisitions }: { acquisitions: AcquisitionListItemDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;

  const sorting = parseSortingState<AcquisitionListItemDto>(sortStr, columnIds);
  const sorted = sortRows(acquisitions, sorting, {
    referenceCode: (row) => row.referenceCode,
    itemCount: (row) => row.itemCount,
    acquiredAt: (row) => row.acquiredAt
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
