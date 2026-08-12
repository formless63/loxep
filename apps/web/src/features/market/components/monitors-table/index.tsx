import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
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
import { monitorsQuery } from '@/features/market/api/queries';
import { applyClientSort } from '@/features/market/lib/apply-client-sort';
import MonitorFormDialog from '@/features/market/components/monitor-form-dialog';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { MonitorDto } from '@/server/market-functions';
import { createColumns } from './columns';

const COLUMN_IDS = [
  'name',
  'targetType',
  'connectionName',
  'enabled',
  'intervalSeconds',
  'nextPollAt',
  'consecutiveErrors',
  'backoff',
  'actions'
];

const DEFAULT_PAGE_SIZE = 10;

/**
 * `fetchMonitors` returns every target unbounded (no server pagination), so
 * — unlike the other market tables, which are capped at a fixed server page
 * size — this table can paginate, sort, and filter the FULL set client-side
 * and get it right, not just "right for the currently-fetched page".
 */
export default function MonitorsTable({ isAdmin }: { isAdmin: boolean }) {
  const { data, isPending, isError, error, refetch } = useQuery(monitorsQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MonitorDto | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (monitor: MonitorDto) => {
    setEditing(monitor);
    setDialogOpen(true);
  };

  if (isPending) {
    return <DataTableSkeleton columnCount={isAdmin ? 9 : 8} filterCount={1} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load monitors' onRetry={() => refetch()} />
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {isAdmin && (
        <div className='flex justify-end'>
          <Button size='sm' onClick={openCreate}>
            <Icons.add />
            New monitor
          </Button>
        </div>
      )}

      {data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.settings />
            </EmptyMedia>
            <EmptyTitle>No monitors</EmptyTitle>
            <EmptyDescription>
              Monitors are user/configuration intent — what to poll, on what cadence. Create one to
              start observing an eBay item or watchlist.
            </EmptyDescription>
          </EmptyHeader>
          {isAdmin && (
            <EmptyContent>
              <Button size='sm' onClick={openCreate}>
                <Icons.add />
                New monitor
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <MonitorsDataTable monitors={data} isAdmin={isAdmin} onEdit={openEdit} />
      )}

      {dialogOpen && (
        <MonitorFormDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          monitor={editing}
        />
      )}
    </div>
  );
}

function MonitorsDataTable({
  monitors,
  isAdmin,
  onEdit
}: {
  monitors: MonitorDto[];
  isAdmin: boolean;
  onEdit: (monitor: MonitorDto) => void;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;
  const targetTypeParam = search.targetType as string | undefined;

  const columns = React.useMemo(() => createColumns(onEdit, isAdmin), [onEdit, isAdmin]);

  const targetTypes = targetTypeParam ? targetTypeParam.split(',') : null;
  const filtered = targetTypes
    ? monitors.filter((monitor) => targetTypes.includes(monitor.targetType))
    : monitors;

  const sorting = parseSortingState<MonitorDto>(sortStr, COLUMN_IDS);
  const sorted = applyClientSort(filtered, sorting, {
    name: (row) => row.name,
    intervalSeconds: (row) => row.intervalSeconds,
    nextPollAt: (row) => row.nextPollAt,
    consecutiveErrors: (row) => row.consecutiveErrors
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
      pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE },
      columnPinning: isAdmin ? { right: ['actions'] } : undefined
    }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
