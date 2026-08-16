import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { dockhandEstateEnvironmentsQuery } from '@/features/infrastructure/api/queries';
import type { DockhandEstateEnvironmentDto } from '@/server/dockhand-estate-functions';
import { dockhandEnvironmentColumns } from './environment-columns';

const CLIENT_COLUMNS: ClientColumnSpec<DockhandEstateEnvironmentDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' }
];

function EnvironmentsTable({
  connectionId,
  environments,
  selectedExternalHostId,
  onViewContainers
}: {
  connectionId: string;
  environments: DockhandEstateEnvironmentDto[];
  selectedExternalHostId: string | null;
  onViewContainers: (environment: DockhandEstateEnvironmentDto) => void;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(
    environments,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const columns = React.useMemo(
    () => dockhandEnvironmentColumns(connectionId, onViewContainers, selectedExternalHostId),
    [connectionId, onViewContainers, selectedExternalHostId]
  );
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (environment) => environment.externalHostId,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Dockhand estate's ENVIRONMENTS section (Estate Browsers Design §3.4) —
 * the whole overview: `listHosts()`, instance-wide, exactly one Dockhand
 * call. Read-only per this bead's own title: no lifecycle control anywhere
 * in this table, and the only action offered is "Adopt as hosting target"
 * for an environment Loxep has not linked yet (a Loxep-own write, no
 * Dockhand call — see `environment-columns.tsx`).
 */
export default function DockhandEnvironmentsSection({
  connectionId,
  selectedExternalHostId,
  onViewContainers
}: {
  connectionId: string;
  selectedExternalHostId: string | null;
  onViewContainers: (environment: DockhandEstateEnvironmentDto) => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery(
    dockhandEstateEnvironmentsQuery(connectionId)
  );

  return (
    <EstateSection
      title='Environments'
      description="Live from Dockhand's listHosts() — every managed host on this instance."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(environments) => environments.length === 0}
      emptyMessage='This Dockhand instance has no registered environments.'
    >
      {(environments) => (
        <EnvironmentsTable
          connectionId={connectionId}
          environments={environments}
          selectedExternalHostId={selectedExternalHostId}
          onViewContainers={onViewContainers}
        />
      )}
    </EstateSection>
  );
}
