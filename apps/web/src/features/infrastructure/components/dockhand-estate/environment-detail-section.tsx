import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { dockhandEstateEnvironmentDetailQuery } from '@/features/infrastructure/api/queries';
import type {
  DockhandEstateContainerDto,
  DockhandEstateStackDto
} from '@/server/dockhand-estate-functions';
import { dockhandEstateContainerColumns } from './container-columns';
import { dockhandEstateStackColumns } from './stack-columns';

const CONTAINER_CLIENT_COLUMNS: ClientColumnSpec<DockhandEstateContainerDto>[] = [
  { id: 'name', accessor: (row) => row.name ?? row.externalContainerId, filterVariant: 'text' }
];
const STACK_CLIENT_COLUMNS: ClientColumnSpec<DockhandEstateStackDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' }
];

function ContainersTable({ containers }: { containers: DockhandEstateContainerDto[] }) {
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
    columns: dockhandEstateContainerColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

function StacksTable({ stacks }: { stacks: DockhandEstateStackDto[] }) {
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
    columns: dockhandEstateStackColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Dockhand estate's per-environment DRILL-IN (Rule P6) — `listContainers`
 * + `listStacks`, TWO calls, fired only once an operator expands one
 * environment's row. Exactly what the shipped per-host `DockhandContainersPanel`
 * already makes, but read by `externalHostId` directly (see
 * `dockhand-estate-functions.ts`'s module doc for why this is NOT that
 * panel's own query) — so it also works for an environment Loxep has not
 * attached to any hosting target yet. No lifecycle control anywhere: rule
 * 13, absolute — see `container-columns.tsx`/`stack-columns.tsx`.
 */
export default function DockhandEnvironmentDetailSection({
  connectionId,
  externalHostId,
  environmentName
}: {
  connectionId: string;
  externalHostId: string;
  environmentName: string;
}) {
  const { data, isPending, isError, error, refetch } = useQuery(
    dockhandEstateEnvironmentDetailQuery(connectionId, externalHostId)
  );

  return (
    <EstateSection
      title={`Containers & stacks — ${environmentName}`}
      description="Live from Dockhand's listContainers()/listStacks() for this environment."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(value) => value.containers.length === 0 && value.stacks.length === 0}
      emptyMessage='This environment has no containers or stacks.'
    >
      {(value) => (
        <div className='flex flex-col gap-4'>
          <div>
            <p className='mb-2 text-sm font-medium'>Containers ({value.containers.length})</p>
            <ContainersTable containers={value.containers} />
          </div>
          <div>
            <p className='mb-2 text-sm font-medium'>Stacks ({value.stacks.length})</p>
            <StacksTable stacks={value.stacks} />
          </div>
        </div>
      )}
    </EstateSection>
  );
}
