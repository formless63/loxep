import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { useDataTable } from '@/hooks/use-data-table';
import { formatDuration } from '@/lib/format';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { healthReportQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { BooleanStatusBadge } from '@/features/settings/components/status-tone';
import { checkColumns, type CheckRow } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<CheckRow>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' }
];

function CheckTable({
  title,
  entries
}: {
  title: string;
  entries: [string, { ok: boolean; detail?: string }][];
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;

  const rows: CheckRow[] = entries.map(([name, result]) => ({
    name,
    ok: result.ok,
    detail: result.detail
  }));
  const { rows: pageRows, pageCount } = applyClientTableState(
    rows,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );

  const { table } = useDataTable({
    data: pageRows,
    columns: checkColumns,
    pageCount,
    getRowId: (row) => row.name,
    shallow: true,
    debounceMs: 500
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className='text-muted-foreground text-sm'>None reported.</p>
        ) : (
          <DataTable table={table}>
            <DataTableToolbar table={table} />
          </DataTable>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Readiness/health detail (ADR-0018): overall status, mode, uptime, and the
 * per-component/per-check results including DB, migrations, worker, and job
 * queue statistics carried in the check detail strings.
 */
export default function HealthReport() {
  const { data, isPending, isError, error, refetch } = useQuery(healthReportQuery);

  if (isPending) {
    return (
      <div className='flex flex-col gap-4'>
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Runtime</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-wrap items-center gap-6 text-sm'>
            <Skeleton className='h-6 w-20' />
            <Skeleton className='h-6 w-24' />
            <Skeleton className='h-6 w-28' />
          </CardContent>
        </Card>
        <DataTableSkeleton columnCount={checkColumns.length} filterCount={1} />
        <DataTableSkeleton columnCount={checkColumns.length} filterCount={1} />
      </div>
    );
  }

  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Health report unavailable' onRetry={() => refetch()} />
    );
  }

  const isDev = data.mode === 'dev';
  const components = Object.entries(data.components);
  const checks = Object.entries(data.checks);

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Runtime</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-wrap items-center gap-6 text-sm'>
          <div className='flex items-center gap-2'>
            <span className='text-muted-foreground'>Status</span>
            <BooleanStatusBadge value={data.status === 'ok'} trueLabel='ok' falseLabel='unready' />
          </div>
          <div className='flex items-center gap-2'>
            <span className='text-muted-foreground'>Mode</span>
            <Badge variant='outline'>{data.mode}</Badge>
          </div>
          <div className='flex items-center gap-2'>
            <span className='text-muted-foreground'>Uptime</span>
            <span className='tabular-nums'>
              {data.uptimeSeconds === null ? '—' : formatDuration(data.uptimeSeconds)}
            </span>
          </div>
        </CardContent>
      </Card>

      {isDev && (
        <Alert>
          <AlertTitle>Dev mode</AlertTitle>
          <AlertDescription>
            No runtime state is available under the vite dev server — component and dependency
            checks report only when the app runs via the Loxep entrypoint (bin/loxep).
          </AlertDescription>
        </Alert>
      )}

      <CheckTable title='Components' entries={components} />
      <CheckTable title='Dependency checks' entries={checks} />
    </div>
  );
}
