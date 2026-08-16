import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { beszelEstateSystemsQuery } from '@/features/infrastructure/api/queries';
import type { BeszelEstateSystemDto } from '@/server/beszel-estate-functions';
import { beszelSystemsColumns } from './systems-columns';
import AttachBeszelSystemDialog from './attach-system-dialog';

const CLIENT_COLUMNS: ClientColumnSpec<BeszelEstateSystemDto>[] = [
  {
    id: 'name',
    accessor: (row) => row.name ?? row.host ?? row.externalSystemId,
    filterVariant: 'text'
  }
];

function SystemsTable({
  systems,
  onAttach
}: {
  systems: BeszelEstateSystemDto[];
  onAttach: (system: BeszelEstateSystemDto) => void;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(systems, CLIENT_COLUMNS, search, page, perPage);
  const { table } = useDataTable({
    data: rows,
    columns: beszelSystemsColumns({ onAttach }),
    pageCount,
    getRowId: (system) => system.externalSystemId,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Beszel estate's SYSTEMS section (Estate Browsers Design §3.5) —
 * `listSystems()`, hub-wide (the adapter already walks every page
 * internally, up to `BESZEL_MAX_LIST_PAGES`), cross-referenced against
 * linked hosting targets. No drill-in: there is no `getSystem`, and there
 * must never be a metric read.
 */
export default function BeszelSystemsSection({ connectionId }: { connectionId: string }) {
  const queryClient = useQueryClient();
  const query = beszelEstateSystemsQuery(connectionId);
  const { data, isPending, isError, error, refetch } = useQuery(query);
  const [attachTarget, setAttachTarget] = React.useState<BeszelEstateSystemDto | null>(null);

  return (
    <EstateSection
      title='Systems'
      description="Live from Beszel's listSystems() — every system on the hub."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(systems) => systems.length === 0}
      emptyMessage='This hub has no systems yet.'
    >
      {(systems) => (
        <>
          <SystemsTable systems={systems} onAttach={setAttachTarget} />
          {attachTarget && attachTarget.externalResourceId !== null && (
            <AttachBeszelSystemDialog
              open={attachTarget !== null}
              onOpenChange={(next) => {
                if (!next) {
                  setAttachTarget(null);
                  void queryClient.invalidateQueries({ queryKey: query.queryKey });
                }
              }}
              system={attachTarget}
            />
          )}
        </>
      )}
    </EstateSection>
  );
}
