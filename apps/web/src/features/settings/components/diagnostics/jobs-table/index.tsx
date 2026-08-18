import { useQuery } from '@tanstack/react-query';
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
import { useDataTable } from '@/hooks/use-data-table';
import { Icons } from '@/components/icons';
import { jobDiagnosticsQuery } from '@/features/settings/api/diagnostics-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { JobDiagnosticRowDto } from '@/server/diagnostics-functions';
import { getColumns } from './columns';

const COLUMNS = getColumns();

/**
 * Failed + stuck-pending jobs, straight from `graphile_worker.jobs`
 * (`@/server/diagnostics-functions`). `pageCount: 1` — the whole
 * (server-capped) result set is fetched in one call and sorted/filtered
 * client-side, the same pattern `books-table`/`entities-table` use for a
 * small, fully-fetched dataset (Frontend Standards' "unbounded fetch"
 * exception).
 */
export default function JobsTable() {
  const { data, isPending, isError, error, refetch } = useQuery(jobDiagnosticsQuery);

  if (isPending) {
    return <DataTableSkeleton columnCount={COLUMNS.length} filterCount={2} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load job diagnostics'
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
          <EmptyTitle>No failed or stuck jobs</EmptyTitle>
          <EmptyDescription>
            Every job that has run recently either completed or is still within its retry budget.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <JobsDataTable rows={data} />;
}

function JobsDataTable({ rows }: { rows: JobDiagnosticRowDto[] }) {
  const { table } = useDataTable({
    data: rows,
    columns: COLUMNS,
    pageCount: 1,
    getRowId: (row) => row.id,
    shallow: true,
    initialState: { columnPinning: { start: [], end: ['actions'] } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
