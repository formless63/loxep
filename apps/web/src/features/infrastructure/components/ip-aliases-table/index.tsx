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
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { ipAliasesQuery } from '@/features/infrastructure/api/queries';
import IpAliasDialog from '@/features/infrastructure/components/ip-alias-dialog';
import type { IpAliasDto } from '@/server/infrastructure-functions';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<IpAliasDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' },
  { id: 'source', accessor: (row) => row.source, filterVariant: 'multiSelect' }
];

/**
 * Named dynamic-IP aliases (Pangolin chain design milestone 5, loxep-acj.5):
 * the primitive Pangolin does not have. Loxep's own list, editable here,
 * with the count of `dynamic_ip`-owned rules currently bound to each one —
 * see `proxy-resource-row.tsx`'s badge for where a bound rule links back.
 */
export default function IpAliasesTable({ isAdmin }: { isAdmin: boolean }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<IpAliasDto | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery(ipAliasesQuery);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (alias: IpAliasDto) => {
    setEditing(alias);
    setDialogOpen(true);
  };

  const columns = React.useMemo(() => getColumns(isAdmin, openEdit), [isAdmin]);

  let body: React.ReactNode;
  if (isPending) {
    body = <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  } else if (isError) {
    body = (
      <QueryErrorAlert error={error} title='Failed to load IP aliases' onRetry={() => refetch()} />
    );
  } else if (data.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.integrations />
          </EmptyMedia>
          <EmptyTitle>No IP aliases</EmptyTitle>
          <EmptyDescription>
            An alias is a named dynamic-IP address — the primitive Pangolin itself does not have.
            Reference one from a rule instead of a literal address, and every referencing rule
            updates together when the address changes.
          </EmptyDescription>
        </EmptyHeader>
        {isAdmin && (
          <EmptyContent>
            <Button size='sm' onClick={openCreate}>
              New alias
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  } else {
    const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
    body = (
      <AliasesDataTable
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
        <IpAliasDialog
          key={editing?.name ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          alias={editing}
        />
      )}
    </div>
  );
}

function AliasesDataTable({
  rows,
  pageCount,
  columns,
  isAdmin,
  onCreate
}: {
  rows: IpAliasDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
  isAdmin: boolean;
  onCreate: () => void;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (alias) => alias.name,
    shallow: true,
    debounceMs: 500,
    initialState: { columnPinning: { start: [], end: ['actions'] } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table}>
        {isAdmin && (
          <Button size='sm' onClick={onCreate}>
            New alias
          </Button>
        )}
      </DataTableToolbar>
    </DataTable>
  );
}
