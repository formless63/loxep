import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDataTable } from '@/hooks/use-data-table';
import { formatDateTime } from '@/lib/format';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { firstAdminBootstrapQuery, usersQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import NewUserDialog from '@/features/settings/components/new-user-dialog';
import ProvisioningCard from '@/features/settings/components/provisioning-card';
import type { UserDto } from '@/server/admin-functions';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<UserDto>[] = [
  { id: 'email', accessor: (row) => `${row.email} ${row.name}`, filterVariant: 'text' },
  { id: 'role', accessor: (row) => row.role, filterVariant: 'multiSelect' },
  { id: 'createdAt', accessor: (row) => row.createdAt }
];

/** First-admin bootstrap marker (ADR-0016) — read-only status badge. */
function BootstrapStatus() {
  const { data, isPending } = useQuery(firstAdminBootstrapQuery);

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className='h-5 w-48' />
        </CardHeader>
        <CardContent>
          <Skeleton className='h-5 w-full max-w-md' />
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>First-admin bootstrap</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-wrap items-center gap-3 text-sm'>
        {data.completed ? (
          <>
            <Badge variant='secondary'>completed</Badge>
            <span className='text-muted-foreground'>
              {data.email ?? 'unknown'}
              {data.completedAt ? ` — ${formatDateTime(data.completedAt)}` : ''}
            </span>
          </>
        ) : (
          <>
            <Badge variant='outline'>pending</Badge>
            <span className='text-muted-foreground'>
              The first sign-in matching LOXEP_BOOTSTRAP_ADMIN_EMAIL receives the admin role.
            </span>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function UsersTable({ currentUserId }: { currentUserId: string }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;

  const [creating, setCreating] = React.useState(false);

  const { data, isPending, isError, error, refetch } = useQuery(usersQuery);
  const columns = React.useMemo(() => getColumns(currentUserId), [currentUserId]);

  let body: React.ReactNode;
  if (isPending) {
    body = <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  } else if (isError) {
    body = <QueryErrorAlert error={error} title='Failed to load users' onRetry={() => refetch()} />;
  } else {
    const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
    body = <UsersDataTable rows={rows} pageCount={pageCount} columns={columns} />;
  }

  return (
    <div className='flex flex-col gap-4'>
      <BootstrapStatus />
      <ProvisioningCard />
      <div className='flex justify-end'>
        <Button onClick={() => setCreating(true)}>New user</Button>
      </div>
      {body}
      <NewUserDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function UsersDataTable({
  rows,
  pageCount,
  columns
}: {
  rows: UserDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    shallow: true,
    debounceMs: 500,
    initialState: { columnPinning: { start: [], end: ['actions'] } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
