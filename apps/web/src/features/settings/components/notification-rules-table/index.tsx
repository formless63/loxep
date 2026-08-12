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
import {
  monitorTargetOptionsQuery,
  notificationEndpointsQuery,
  notificationRulesQuery
} from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import NotificationRuleDialog from '@/features/settings/components/notification-rule-dialog';
import type { NotificationRuleDto } from '@/server/admin-functions';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<NotificationRuleDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' },
  {
    id: 'marketEventType',
    accessor: (row) => row.marketEventType ?? '',
    filterVariant: 'multiSelect'
  }
];

export default function NotificationRulesTable({ isAdmin }: { isAdmin: boolean }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<NotificationRuleDto | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery(notificationRulesQuery);
  const {
    data: endpoints,
    isPending: endpointsPending,
    isError: endpointsError,
    error: endpointsErrorValue,
    refetch: refetchEndpoints
  } = useQuery(notificationEndpointsQuery);
  const { data: monitorTargets, isPending: monitorTargetsPending } =
    useQuery(monitorTargetOptionsQuery);

  const endpointList = endpoints ?? [];
  const monitorTargetList = monitorTargets ?? [];
  const endpointNameById = new Map(endpointList.map((endpoint) => [endpoint.id, endpoint.name]));
  const monitorNameById = new Map(monitorTargetList.map((target) => [target.id, target.name]));

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (rule: NotificationRuleDto) => {
    setEditing(rule);
    setDialogOpen(true);
  };

  // Small admin list — recomputed each render rather than memoized, since
  // `endpointNameById`/`monitorNameById` are themselves fresh every render.
  const columns = getColumns(isAdmin, endpointNameById, monitorNameById, openEdit);

  let body: React.ReactNode;
  if (isPending || endpointsPending || monitorTargetsPending) {
    body = <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  } else if (isError) {
    body = (
      <QueryErrorAlert
        error={error}
        title='Failed to load notification rules'
        onRetry={() => refetch()}
      />
    );
  } else if (endpointsError) {
    body = (
      <QueryErrorAlert
        error={endpointsErrorValue}
        title='Failed to load notification endpoints'
        onRetry={() => refetchEndpoints()}
      />
    );
  } else if (data.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.checks />
          </EmptyMedia>
          <EmptyTitle>No notification rules</EmptyTitle>
          <EmptyDescription>
            Rules match a market event type and/or monitor target ("any" when unset) and route
            matching events to one endpoint.
          </EmptyDescription>
        </EmptyHeader>
        {isAdmin && (
          <EmptyContent>
            <Button size='sm' onClick={openCreate} disabled={endpointList.length === 0}>
              New rule
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  } else {
    const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
    body = (
      <RulesDataTable
        rows={rows}
        pageCount={pageCount}
        columns={columns}
        isAdmin={isAdmin}
        canCreate={endpointList.length > 0}
        onCreate={openCreate}
      />
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {isAdmin && endpointList.length === 0 && (
        <p className='text-muted-foreground text-sm'>
          Register a notification endpoint first — rules route to an endpoint.
        </p>
      )}
      {body}
      {dialogOpen && (
        <NotificationRuleDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          rule={editing}
          endpoints={endpointList}
          monitorTargets={monitorTargetList}
        />
      )}
    </div>
  );
}

function RulesDataTable({
  rows,
  pageCount,
  columns,
  isAdmin,
  canCreate,
  onCreate
}: {
  rows: NotificationRuleDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
  isAdmin: boolean;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    shallow: true,
    debounceMs: 500,
    initialState: { columnPinning: { right: ['actions'] } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table}>
        {isAdmin && (
          <Button size='sm' onClick={onCreate} disabled={!canCreate}>
            New rule
          </Button>
        )}
      </DataTableToolbar>
    </DataTable>
  );
}
