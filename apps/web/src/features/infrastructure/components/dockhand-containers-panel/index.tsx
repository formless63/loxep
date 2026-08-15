import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { useDataTable } from '@/hooks/use-data-table';
import { formatRelativeTime } from '@/lib/format';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { dockhandHostViewQuery } from '@/features/infrastructure/api/queries';
import type { DockhandContainerDto, DockhandStackDto } from '@/server/infrastructure-functions';
import { dockhandContainerColumns } from './container-columns';
import { dockhandStackColumns } from './stack-columns';

const CONTAINER_CLIENT_COLUMNS: ClientColumnSpec<DockhandContainerDto>[] = [
  { id: 'name', accessor: (row) => row.name ?? row.externalContainerId, filterVariant: 'text' }
];
const STACK_CLIENT_COLUMNS: ClientColumnSpec<DockhandStackDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' }
];

function ContainersTable({ containers }: { containers: DockhandContainerDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(
    containers,
    CONTAINER_CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const { table } = useDataTable({
    data: rows,
    columns: dockhandContainerColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

function StacksTable({ stacks }: { stacks: DockhandStackDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(
    stacks,
    STACK_CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const { table } = useDataTable({
    data: rows,
    columns: dockhandStackColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The ONE dedicated tool-specific panel the fleet design's anti-soup rule
 * licenses (hb7 §3.2 rule 1) — Dockhand's containers and stacks are a list
 * of subjects Loxep cannot otherwise show. A LIVE, request-scoped read: no
 * table, no cache, no cadence (hb7 §3.3) — `readAt` is Loxep's own clock,
 * stamped fresh on every render, never a staleness figure. Rule-13's UI
 * clause holds structurally: `DockhandContainerDto`/`DockhandStackDto`
 * carry no lifecycle field, and nothing here renders a control that could
 * imply one — no Restart button, disabled or otherwise.
 *
 * Mounted ONLY when the caller already knows a dockhand/environment
 * companion link exists (see `$name.tsx`) — this component itself renders
 * nothing extra for the "no link" case; that absence is the caller's job,
 * per hb7 §3.2 rule 3 ("absent, not green, not empty").
 */
export default function DockhandContainersPanel({ hostingTargetId }: { hostingTargetId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    dockhandHostViewQuery(hostingTargetId)
  );

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Containers</CardTitle>
          <CardDescription>Live from Dockhand — reading now…</CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-4'>
          <DataTableSkeleton columnCount={dockhandContainerColumns.length} filterCount={1} />
          <DataTableSkeleton columnCount={dockhandStackColumns.length} filterCount={1} />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Containers</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryErrorAlert
            error={error}
            title='Could not read Dockhand right now'
            onRetry={() => refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  // The link this component was mounted for turned out to have no resolvable
  // Dockhand environment id (the discovery write-through hasn't landed, or
  // the link predates it) — absent, not an empty table implying one exists.
  if (data === null) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Containers</CardTitle>
        <CardDescription>
          Dockhand, read just now ({formatRelativeTime(data.readAt)}) — never stored, never
          scheduled.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        <div>
          <p className='mb-2 text-sm font-medium'>Containers ({data.containers.length})</p>
          <ContainersTable containers={data.containers} />
        </div>
        <div>
          <p className='mb-2 text-sm font-medium'>Stacks ({data.stacks.length})</p>
          <StacksTable stacks={data.stacks} />
        </div>
      </CardContent>
    </Card>
  );
}
