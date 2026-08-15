import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { formatRelativeTime } from '@/lib/format';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { termixHostSessionsQuery } from '@/features/infrastructure/api/queries';
import type { TermixSessionRowDto } from '@/server/infrastructure-functions';
import { termixSessionColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<TermixSessionRowDto>[] = [
  {
    id: 'who',
    accessor: (row) => (row.isOwnSession ? 'you' : (row.sharedByUsername ?? '')),
    filterVariant: 'text'
  }
];

function SessionsTable({ sessions }: { sessions: TermixSessionRowDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(
    sessions,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const { table } = useDataTable({
    data: rows,
    columns: termixSessionColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Termix per-session list (loxep-4ah, owner-approved 2026-08-15 —
 * "the more info the better … this tool is meant to be used by people that
 * trust one another"). This is the fleet design's anti-soup rule earning a
 * dedicated panel the SAME way Dockhand's containers panel does: sessions
 * are subjects Loxep cannot otherwise show, and this owner ruling licenses
 * them explicitly for Termix (loxep-wvm §3.3(a)'s per-session gate, now
 * resolved).
 *
 * A LIVE, request-scoped read — no table, no cache, no cadence, exactly
 * `DockhandContainersPanel`'s discipline. `readAt` is Loxep's own clock,
 * stamped fresh on every render, never a staleness figure. Never persisted:
 * `TermixSessionFact` rows never reach a table anywhere in this codebase.
 *
 * Mounted ONLY when the caller already knows a termix/host companion link
 * exists (see `$name.tsx`) — absent, not an empty table, when it does not.
 */
export default function TermixSessionsPanel({ hostingTargetId }: { hostingTargetId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    termixHostSessionsQuery(hostingTargetId)
  );

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Active sessions</CardTitle>
          <CardDescription>Live from Termix — reading now…</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTableSkeleton columnCount={termixSessionColumns.length} filterCount={1} />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Active sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryErrorAlert
            error={error}
            title='Could not read Termix sessions right now'
            onRetry={() => refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  // No termix/host link resolved for this target — absent, not an empty
  // table implying one exists.
  if (data === null) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Active sessions ({data.sessions.length})</CardTitle>
        <CardDescription>
          Termix, read just now ({formatRelativeTime(data.readAt)}) — never stored, never scheduled.
          Who is logged in, from where, and for how long.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.sessions.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.teams />
              </EmptyMedia>
              <EmptyTitle>No active sessions</EmptyTitle>
              <EmptyDescription>
                Nobody is currently connected to this host through Termix.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SessionsTable sessions={data.sessions} />
        )}
      </CardContent>
    </Card>
  );
}
