import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { termixEstateSessionsQuery } from '@/features/infrastructure/api/queries';
import { termixSessionColumns } from '@/features/infrastructure/components/termix-sessions-panel/columns';
import type { TermixSessionRowDto } from '@/server/infrastructure-functions';

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
    // The EXACT same column set the per-host fleet-detail panel already
    // renders (`termix-sessions-panel/columns.tsx`) — the wvm design's own
    // who/where/age shapes, applied instance-wide instead of filtered to one
    // host (Rule P12 — mount, do not re-implement a parallel render).
    columns: termixSessionColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Termix estate's SESSIONS section — instance-wide, per the owner's 5b
 * ruling (2026-08-16); see `termix-estate-functions.ts`'s module doc for the
 * full history. `sharedByUsername` renders VERBATIM, exactly as the per-host
 * panel already does — this is the SAME live `listSessions()` read that
 * panel makes, filtered here to nothing (every host) instead of one.
 */
export default function TermixSessionsSection({ connectionId }: { connectionId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    termixEstateSessionsQuery(connectionId)
  );

  return (
    <EstateSection
      title='Active sessions'
      description="Live from Termix's listSessions() — every session on the instance. Who is logged in, from where, and for how long."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(result) => result.sessions.length === 0}
      emptyMessage='Nobody is currently connected to this instance through Termix.'
    >
      {(result) => (
        <div className='flex flex-col gap-2'>
          {result.truncated && (
            <p className='text-muted-foreground text-xs'>
              Showing the first 200 sessions — the live list reported more.
            </p>
          )}
          <SessionsTable sessions={result.sessions} />
        </div>
      )}
    </EstateSection>
  );
}
