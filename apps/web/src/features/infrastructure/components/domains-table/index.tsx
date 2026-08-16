import * as React from 'react';
import { Link, useSearch } from '@tanstack/react-router';
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
import { managedDomainsQuery } from '@/features/infrastructure/api/queries';
import type { ManagedDomainDto } from '@/server/infrastructure-functions';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<ManagedDomainDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' },
  { id: 'state', accessor: (row) => row.state, filterVariant: 'multiSelect' }
];

export default function DomainsTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;

  const { data, isPending, isError, error, refetch } = useQuery(managedDomainsQuery);
  const columns = React.useMemo(() => getColumns(), []);

  const newDomainButton = (
    <Button size='sm' asChild>
      <Link to='/infrastructure/domains/new'>
        <Icons.add />
        New domain
      </Link>
    </Button>
  );

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  }
  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Failed to load domains' onRetry={() => refetch()} />
    );
  }
  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.search />
          </EmptyMedia>
          <EmptyTitle>No managed domains yet</EmptyTitle>
          <EmptyDescription>
            Declare a domain to have Loxep manage its DNS zone, hosting target, and mail
            registration.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{newDomainButton}</EmptyContent>
      </Empty>
    );
  }

  const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
  return (
    <DomainsDataTable
      rows={rows}
      pageCount={pageCount}
      columns={columns}
      action={newDomainButton}
    />
  );
}

function DomainsDataTable({
  rows,
  pageCount,
  columns,
  action
}: {
  rows: ManagedDomainDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
  action: React.ReactNode;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (domain) => domain.id,
    shallow: true,
    debounceMs: 500
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table}>{action}</DataTableToolbar>
    </DataTable>
  );
}
