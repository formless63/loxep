import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import type { ConnectionDto, EntityDto } from '@/server/admin-functions';
import {
  connectionsQuery,
  ebayKeysetStatusQuery,
  entitiesQuery
} from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import ConnectionAddDialog from '@/features/settings/components/connection-add-dialog';
import { IntegrationStatusBadges } from '@/features/settings/components/integration-card';
import {
  connectableIntegrationServices,
  type IntegrationService,
  type IntegrationStatusInput
} from '@/features/settings/integrations-catalog';
import { getColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<ConnectionDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' },
  { id: 'status', accessor: (row) => row.status, filterVariant: 'multiSelect' }
];

/**
 * Accounts, grouped by the service they belong to.
 *
 * The grouping and every "Add account" action come from the integrations
 * catalog (`@/features/settings/integrations-catalog`), so `provider` and
 * `kind` are chosen by the system rather than typed, and a service that is
 * not set up yet says so and links to `/settings/integrations` instead of
 * offering a form that would fail.
 */
export default function ConnectionsTable({ isAdmin }: { isAdmin: boolean }) {
  const { data, isPending, isError, error, refetch } = useQuery(connectionsQuery);
  const { data: entities, isPending: entitiesPending } = useQuery(entitiesQuery);
  // Admin-only server function: fetched only when it can succeed, and only
  // used to decide whether adding an eBay account can work at all.
  const { data: ebayKeyset } = useQuery({ ...ebayKeysetStatusQuery, enabled: isAdmin });
  const [addServiceId, setAddServiceId] = React.useState<string | null>(null);

  if (isPending || entitiesPending) {
    return <DataTableSkeleton columnCount={8} filterCount={2} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Failed to load connections' onRetry={() => refetch()} />
    );
  }

  const connections = data;
  const statusInput: IntegrationStatusInput = {
    connections,
    endpoints: [],
    ebayKeyset: ebayKeyset ?? null
  };
  const activeCount = connections.filter((connection) => connection.status === 'active').length;
  // Archived accounts are retired, so they are not part of the "of N" the
  // headline counts; they still appear in their service's table (muted) and
  // in the status filter, so nothing is hidden.
  const liveCount = connections.filter((connection) => connection.status !== 'archived').length;
  const archivedCount = connections.length - liveCount;

  const catalogProviders = new Set(
    connectableIntegrationServices.map((service) => service.accounts?.provider)
  );
  const uncatalogued = connections.filter(
    (connection) => !catalogProviders.has(connection.provider)
  );
  const addService =
    connectableIntegrationServices.find((service) => service.id === addServiceId) ?? null;

  return (
    <div className='flex flex-col gap-8'>
      {connections.length > 0 && (
        <p className='text-sm'>
          <span className='text-primary text-2xl font-semibold tabular-nums'>{activeCount}</span>{' '}
          <span className='text-muted-foreground'>
            of {liveCount} account{liveCount === 1 ? '' : 's'} active
            {archivedCount > 0 ? ` · ${archivedCount} archived` : ''}
          </span>
        </p>
      )}

      {connectableIntegrationServices.map((service) => (
        <ServiceSection
          key={service.id}
          service={service}
          connections={connections.filter(
            (connection) => connection.provider === service.accounts?.provider
          )}
          entities={entities ?? []}
          statusInput={statusInput}
          isAdmin={isAdmin}
          onAddAccount={() => setAddServiceId(service.id)}
        />
      ))}

      {uncatalogued.length > 0 && (
        <section className='flex flex-col gap-3'>
          <h2 className='text-lg font-medium'>Other services</h2>
          <p className='text-muted-foreground text-sm'>
            Accounts recorded for services that are not in the integrations catalog. They can be
            disabled and attributed here, but no guided set-up exists for them.
          </p>
          <ConnectionRows
            connections={uncatalogued}
            entities={entities ?? []}
            isAdmin={isAdmin}
            showService
          />
        </section>
      )}

      {addService !== null && (
        <ConnectionAddDialog
          service={addService}
          open
          onOpenChange={(open) => {
            if (!open) setAddServiceId(null);
          }}
          entities={entities ?? []}
        />
      )}
    </div>
  );
}

/** One service's accounts plus its guarded "Add account" action. */
function ServiceSection({
  service,
  connections,
  entities,
  statusInput,
  isAdmin,
  onAddAccount
}: {
  service: IntegrationService;
  connections: ConnectionDto[];
  entities: EntityDto[];
  statusInput: IntegrationStatusInput;
  isAdmin: boolean;
  onAddAccount: () => void;
}) {
  const blockedReason = service.accounts?.blockedReason(statusInput) ?? null;

  return (
    <section className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-lg font-medium'>{service.name}</h2>
          <IntegrationStatusBadges status={service.status(statusInput)} />
        </div>
        {isAdmin && (
          <div className='flex flex-col items-end gap-1'>
            <Button size='sm' disabled={blockedReason !== null} onClick={onAddAccount}>
              {service.accounts?.addLabel ?? 'Add account'}
            </Button>
            {blockedReason !== null && (
              <p className='text-muted-foreground max-w-xs text-right text-xs'>
                {blockedReason}{' '}
                <Link to='/settings/integrations' className='underline underline-offset-2'>
                  Open integrations
                </Link>
              </p>
            )}
          </div>
        )}
      </div>
      {connections.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No {service.name} accounts</EmptyTitle>
            <EmptyDescription>{service.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ConnectionRows connections={connections} entities={entities} isAdmin={isAdmin} />
      )}
    </section>
  );
}

/** The account table itself — one row per connection. */
function ConnectionRows({
  connections,
  entities,
  isAdmin,
  showService = false
}: {
  connections: ConnectionDto[];
  entities: EntityDto[];
  isAdmin: boolean;
  showService?: boolean;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;

  const columns = React.useMemo(
    () => getColumns(entities, isAdmin, showService),
    [entities, isAdmin, showService]
  );
  const { rows, pageCount } = applyClientTableState(
    connections,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );

  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    shallow: true,
    debounceMs: 500,
    initialState: { columnPinning: { start: [], end: ['actions'] } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
