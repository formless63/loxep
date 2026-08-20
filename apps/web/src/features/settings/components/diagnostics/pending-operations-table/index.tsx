import { useQuery } from '@tanstack/react-query';
import { useTable } from '@tanstack/react-table';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { dataTableFeatures } from '@/lib/table-features';
import { Icons } from '@/components/icons';
import { pendingProviderOperationsQuery } from '@/features/settings/api/diagnostics-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { PendingProviderOperationDto } from '@/server/admin-functions';
import { getColumns } from './columns';

const COLUMNS = getColumns();

/**
 * `provider_operations.status = 'pending'` (loxep-rh0) — `@/server/admin-functions.ts`'s
 * `fetchPendingProviderOperations`'s own doc has the full story: a small,
 * fully-fetched, read-only worklist (no adjudication verb exists on
 * `ProviderOperationsLedger` — `succeed`/`fail` need a redacted response
 * summary a read-back reconciler produces, not something a click can
 * fabricate). `JobsTable` above this on the same `/settings/diagnostics`
 * page already owns the route's URL-synced `page`/`sort`/filter keys via
 * `useDataTable`; per Frontend Standards' "two tables, one route" caveat
 * this secondary table drives `DataTable` off a local `useTable` (with
 * `features: dataTableFeatures`) instead, to avoid colliding on those keys.
 */
export default function PendingOperationsTable() {
  const { data, isPending, isError, error, refetch } = useQuery(pendingProviderOperationsQuery);

  if (isPending) {
    return <DataTableSkeleton columnCount={COLUMNS.length} filterCount={2} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load pending provider operations'
        onRetry={() => refetch()}
      />
    );
  }

  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.circleCheck />
          </EmptyMedia>
          <EmptyTitle>No pending provider operations</EmptyTitle>
          <EmptyDescription>
            Every outbound provider call either completed or was never attempted. A row here would
            mean a create call's outcome at the provider is unconfirmed — a worker crash between the
            call and its result — and needs a human to read the provider back.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <PendingOperationsDataTable rows={data} />;
}

function PendingOperationsDataTable({ rows }: { rows: PendingProviderOperationDto[] }) {
  const table = useTable({
    data: rows,
    columns: COLUMNS,
    features: dataTableFeatures,
    getRowId: (row) => row.idempotencyKey,
    manualPagination: true
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
