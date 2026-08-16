import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
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
import { notificationEndpointsQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import NotificationEndpointDialog from '@/features/settings/components/notification-endpoint-dialog';
import type { NotificationEndpointDto } from '@/server/admin-functions';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<NotificationEndpointDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' }
];

export default function NotificationEndpointsTable({ isAdmin }: { isAdmin: boolean }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<NotificationEndpointDto | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery(notificationEndpointsQuery);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (endpoint: NotificationEndpointDto) => {
    setEditing(endpoint);
    setDialogOpen(true);
  };

  const columns = React.useMemo(() => getColumns(isAdmin, openEdit), [isAdmin]);

  let body: React.ReactNode;
  if (isPending) {
    body = <DataTableSkeleton columnCount={columns.length} filterCount={1} />;
  } else if (isError) {
    body = (
      <QueryErrorAlert
        error={error}
        title='Failed to load notification endpoints'
        onRetry={() => refetch()}
      />
    );
  } else if (data.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.notification />
          </EmptyMedia>
          <EmptyTitle>No notification endpoints</EmptyTitle>
          <EmptyDescription>
            Endpoints are the destinations rules deliver to. Register one to start receiving
            notifications — ntfy is the first supported endpoint type.
          </EmptyDescription>
        </EmptyHeader>
        {isAdmin && (
          <EmptyContent>
            <Button size='sm' onClick={openCreate}>
              New endpoint
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  } else {
    const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
    body = (
      <EndpointsDataTable
        rows={rows}
        pageCount={pageCount}
        columns={columns}
        isAdmin={isAdmin}
        onCreate={openCreate}
      />
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {body}
      {dialogOpen && (
        <NotificationEndpointDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          endpoint={editing}
        />
      )}
    </div>
  );
}

function EndpointsDataTable({
  rows,
  pageCount,
  columns,
  isAdmin,
  onCreate
}: {
  rows: NotificationEndpointDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
  isAdmin: boolean;
  onCreate: () => void;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (endpoint) => endpoint.id,
    shallow: true,
    debounceMs: 500,
    initialState: { columnPinning: { start: [], end: ['actions'] } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table}>
        {isAdmin && (
          <Button size='sm' onClick={onCreate}>
            New endpoint
          </Button>
        )}
      </DataTableToolbar>
    </DataTable>
  );
}
