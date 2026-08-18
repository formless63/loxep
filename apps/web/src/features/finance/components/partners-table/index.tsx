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
import { partnersQuery } from '@/features/finance/api/partners-queries';
import type { PartnerListItemDto } from '@/server/partners-functions';
import PartnerFormDialog from '@/features/finance/components/partner-form-dialog';
import { createColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<PartnerListItemDto>[] = [
  { id: 'displayName', accessor: (row) => row.displayName, filterVariant: 'text' },
  { id: 'kind', accessor: (row) => row.kind, filterVariant: 'multiSelect' },
  { id: 'status', accessor: (row) => row.status, filterVariant: 'multiSelect' },
  { id: 'createdAt', accessor: (row) => row.createdAt }
];

const DEFAULT_PAGE_SIZE = 10;

export default function PartnersTable() {
  const { data, isPending, isError, error, refetch } = useQuery(partnersQuery);
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const [createOpen, setCreateOpen] = React.useState(false);

  const columns = React.useMemo(() => createColumns(), []);

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={3} />;
  }
  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load trading partners'
        onRetry={() => refetch()}
      />
    );
  }

  if (data.length === 0) {
    return (
      <div className='flex flex-col gap-4'>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.teams />
            </EmptyMedia>
            <EmptyTitle>No trading partners</EmptyTitle>
            <EmptyDescription>
              A trading partner is an outside party Loxep does business with — a customer, vendor,
              or other counterparty holding a role against one of Loxep&rsquo;s economic entities.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size='sm' onClick={() => setCreateOpen(true)}>
              <Icons.add />
              New trading partner
            </Button>
          </EmptyContent>
        </Empty>
        {createOpen && (
          <PartnerFormDialog open={createOpen} onOpenChange={setCreateOpen} partner={null} />
        )}
      </div>
    );
  }

  const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);

  return (
    <PartnersDataTable
      rows={rows}
      pageCount={pageCount}
      columns={columns}
      createOpen={createOpen}
      onCreateOpenChange={setCreateOpen}
    />
  );
}

function PartnersDataTable({
  rows,
  pageCount,
  columns,
  createOpen,
  onCreateOpenChange
}: {
  rows: PartnerListItemDto[];
  pageCount: number;
  columns: ReturnType<typeof createColumns>;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (partner) => partner.id,
    shallow: true,
    debounceMs: 500,
    initialState: {
      pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE },
      columnPinning: { start: [], end: ['actions'] }
    }
  });

  return (
    <div className='flex flex-col gap-4'>
      <DataTable table={table}>
        <DataTableToolbar table={table}>
          <Button size='sm' onClick={() => onCreateOpenChange(true)}>
            <Icons.add />
            New trading partner
          </Button>
        </DataTableToolbar>
      </DataTable>
      {createOpen && (
        <PartnerFormDialog open={createOpen} onOpenChange={onCreateOpenChange} partner={null} />
      )}
    </div>
  );
}
