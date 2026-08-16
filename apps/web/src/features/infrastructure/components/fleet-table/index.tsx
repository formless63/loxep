import * as React from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import {
  Empty,
  EmptyContent,
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
import { hostingTargetsQuery } from '@/features/infrastructure/api/queries';
import NewHostingTargetDialog from '@/features/infrastructure/components/new-hosting-target-dialog';
import type { HostingTargetDto } from '@/server/infrastructure-functions';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<HostingTargetDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' },
  { id: 'controlSurface', accessor: (row) => row.controlSurface, filterVariant: 'multiSelect' }
];

export default function FleetTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const { data, isPending, isError, error, refetch } = useQuery(hostingTargetsQuery);
  const columns = React.useMemo(() => getColumns(), []);

  const newTargetButton = (
    <Button size='sm' onClick={() => setDialogOpen(true)}>
      <Icons.add />
      New hosting target
    </Button>
  );

  let body: React.ReactNode;
  if (isPending) {
    body = <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  } else if (isError) {
    body = (
      <QueryErrorAlert error={error} title='Failed to load the fleet' onRetry={() => refetch()} />
    );
  } else if (data.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.integrations />
          </EmptyMedia>
          <EmptyTitle>No hosting targets yet</EmptyTitle>
          <EmptyDescription>
            Register a node, tunnel-connected host, or bare server that a domain's records can point
            at.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{newTargetButton}</EmptyContent>
      </Empty>
    );
  } else {
    const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
    body = (
      <FleetDataTable
        rows={rows}
        pageCount={pageCount}
        columns={columns}
        action={newTargetButton}
      />
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {body}
      {dialogOpen && <NewHostingTargetDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
    </div>
  );
}

function FleetDataTable({
  rows,
  pageCount,
  columns,
  action
}: {
  rows: HostingTargetDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
  action: React.ReactNode;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (target) => target.id,
    shallow: true,
    debounceMs: 500
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table}>{action}</DataTableToolbar>
    </DataTable>
  );
}
