import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { notificationDeliveriesQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { NotificationDeliveryDto } from '@/server/admin-functions';
import { columns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<NotificationDeliveryDto>[] = [
  { id: 'endpointName', accessor: (row) => row.endpointName, filterVariant: 'text' },
  { id: 'status', accessor: (row) => row.status, filterVariant: 'multiSelect' }
];

/**
 * Read-only recent delivery attempts (member-readable metadata only, ADR-0017
 * — never token material). Event detection and delivery stay separate
 * concepts; this surfaces the delivery half of that boundary.
 */
export default function NotificationDeliveriesTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;

  const { data, isPending, isError, error, refetch } = useQuery(notificationDeliveriesQuery);

  let body: React.ReactNode;
  if (isPending) {
    body = <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  } else if (isError) {
    body = (
      <QueryErrorAlert error={error} title='Failed to load deliveries' onRetry={() => refetch()} />
    );
  } else if (data.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.send />
          </EmptyMedia>
          <EmptyTitle>No deliveries yet</EmptyTitle>
          <EmptyDescription>
            Delivery attempts appear here once matched market events are enqueued to an endpoint.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
    body = <DeliveriesDataTable rows={rows} pageCount={pageCount} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Recent deliveries</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function DeliveriesDataTable({
  rows,
  pageCount
}: {
  rows: NotificationDeliveryDto[];
  pageCount: number;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (delivery) => delivery.id,
    shallow: true,
    debounceMs: 500
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
