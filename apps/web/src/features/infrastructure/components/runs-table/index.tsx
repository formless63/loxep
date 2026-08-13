import * as React from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { reconcileRunsQuery } from '@/features/infrastructure/api/queries';
import type { ReconcileRunDto } from '@/server/infrastructure-functions';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<ReconcileRunDto>[] = [
  { id: 'kind', accessor: (row) => row.kind, filterVariant: 'text' },
  { id: 'status', accessor: (row) => row.status, filterVariant: 'multiSelect' }
];

export default function RunsTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 25;

  const { data, isPending, isError, error, refetch } = useQuery(reconcileRunsQuery);
  const columns = React.useMemo(() => getColumns(), []);

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  }
  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Failed to load reconcile runs'
        onRetry={() => refetch()}
      />
    );
  }
  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.clock />
          </EmptyMedia>
          <EmptyTitle>No reconcile runs yet</EmptyTitle>
          <EmptyDescription>
            Runs appear once a domain provisions, an operator triggers a sync, or a sweep executes.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
  return <RunsDataTable rows={rows} pageCount={pageCount} columns={columns} />;
}

function RunsDataTable({
  rows,
  pageCount,
  columns
}: {
  rows: ReconcileRunDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
