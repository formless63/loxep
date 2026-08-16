import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { termixEstateHostsQuery } from '@/features/infrastructure/api/queries';
import type { TermixEstateHostDto } from '@/server/termix-estate-functions';
import { termixHostsColumns } from './hosts-columns';

const CLIENT_COLUMNS: ClientColumnSpec<TermixEstateHostDto>[] = [
  { id: 'name', accessor: (row) => row.name ?? row.externalHostId, filterVariant: 'text' }
];

function HostsTable({ hosts }: { hosts: TermixEstateHostDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(hosts, CLIENT_COLUMNS, search, page, perPage);
  const { table } = useDataTable({
    data: rows,
    columns: termixHostsColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Termix estate's HOSTS section (Estate Browsers Design §3.8) —
 * `listHosts()`, instance-wide, cross-referenced against linked hosting
 * targets. Read-only: no action mounts here at all.
 */
export default function TermixHostsSection({ connectionId }: { connectionId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    termixEstateHostsQuery(connectionId)
  );

  return (
    <EstateSection
      title='Hosts'
      description="Live from Termix's listHosts() — every SSH host on the instance."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(hosts) => hosts.length === 0}
      emptyMessage='This instance has no hosts yet.'
    >
      {(hosts) => <HostsTable hosts={hosts} />}
    </EstateSection>
  );
}
