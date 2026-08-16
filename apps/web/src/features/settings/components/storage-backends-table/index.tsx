import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { storageBackendsQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import StorageBackendDialog from '@/features/settings/components/storage-backend-dialog';
import type { StorageBackendDto } from '@/server/admin-functions';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<StorageBackendDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' },
  { id: 'driver', accessor: (row) => row.driver, filterVariant: 'multiSelect' }
];

export default function StorageBackendsTable({ isAdmin }: { isAdmin: boolean }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const { data, isPending, isError, error, refetch } = useQuery(storageBackendsQuery);
  const columns = React.useMemo(() => getColumns(isAdmin), [isAdmin]);

  let body: React.ReactNode;
  if (isPending) {
    body = <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  } else if (isError) {
    body = (
      <QueryErrorAlert
        error={error}
        title='Failed to load storage backends'
        onRetry={() => refetch()}
      />
    );
  } else if (data.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.media />
          </EmptyMedia>
          <EmptyTitle>No storage backends</EmptyTitle>
          <EmptyDescription>
            Register a local-filesystem or S3-compatible backend to store media objects.
          </EmptyDescription>
        </EmptyHeader>
        {isAdmin && (
          <EmptyContent>
            <Button size='sm' onClick={() => setDialogOpen(true)}>
              Register backend
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  } else {
    const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
    body = (
      <StorageBackendsDataTable
        rows={rows}
        pageCount={pageCount}
        columns={columns}
        isAdmin={isAdmin}
        onRegister={() => setDialogOpen(true)}
      />
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {body}

      <Alert>
        <AlertTitle>Backend migration</AlertTitle>
        <AlertDescription>
          Moving objects between backends uses the resumable copy → verify → cutover → cleanup
          workflow at the service level; a migration UI arrives in a later phase.
        </AlertDescription>
      </Alert>

      {dialogOpen && <StorageBackendDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
    </div>
  );
}

function StorageBackendsDataTable({
  rows,
  pageCount,
  columns,
  isAdmin,
  onRegister
}: {
  rows: StorageBackendDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
  isAdmin: boolean;
  onRegister: () => void;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (backend) => backend.id,
    shallow: true,
    debounceMs: 500,
    initialState: { columnPinning: { start: [], end: ['actions'] } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table}>
        {isAdmin && (
          <Button size='sm' onClick={onRegister}>
            Register backend
          </Button>
        )}
      </DataTableToolbar>
    </DataTable>
  );
}
