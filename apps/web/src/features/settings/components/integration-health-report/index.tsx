import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { integrationHealthQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { IntegrationHealthDto } from '@/server/admin-functions';
import { integrationHealthColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<IntegrationHealthDto>[] = [
  { id: 'subjectType', accessor: (row) => row.subjectType, filterVariant: 'multiSelect' },
  { id: 'label', accessor: (row) => row.label, filterVariant: 'text' }
];

/**
 * `integration_health` subjects by status (Phase 8 milestone 1, loxep-ovj.1).
 * This is a shared-foundation ROLLUP, not the live connection/endpoint/
 * backend state — every status carries its own `checkedAt`/`source` so the
 * design's "every status renders its provenance" rule holds even in a
 * settings table. A subject the sweep has not reached yet is simply absent
 * — "nothing configured" must not render like "everything healthy".
 */
export default function IntegrationHealthReport() {
  const { data, isPending, isError, error, refetch } = useQuery(integrationHealthQuery);
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Integration health</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableSkeleton columnCount={integrationHealthColumns.length} filterCount={2} />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Integration health unavailable'
        onRetry={() => refetch()}
      />
    );
  }

  const { rows, pageCount } = applyClientTableState(data, CLIENT_COLUMNS, search, page, perPage);
  return <IntegrationHealthTable rows={rows} pageCount={pageCount} total={data.length} />;
}

function IntegrationHealthTable({
  rows,
  pageCount,
  total
}: {
  rows: IntegrationHealthDto[];
  pageCount: number;
  total: number;
}) {
  const { table } = useDataTable({
    data: rows,
    columns: integrationHealthColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Integration health</CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className='text-muted-foreground text-sm'>
            No subject has been probed yet — the sweep runs every five minutes.
          </p>
        ) : (
          <DataTable table={table}>
            <DataTableToolbar table={table} />
          </DataTable>
        )}
      </CardContent>
    </Card>
  );
}
