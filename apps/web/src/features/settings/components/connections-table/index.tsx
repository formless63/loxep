import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import type { ConnectionDto } from '@/server/admin-functions';
import {
  connectionsQuery,
  ebayKeysetStatusQuery,
  entitiesQuery,
  etsyKeysetStatusQuery,
  integrationsEnabledQuery
} from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import ConnectionAddDialog from '@/features/settings/components/connection-add-dialog';
import {
  connectableIntegrationServices,
  isIntegrationEnabled,
  type IntegrationEnabledMap,
  type IntegrationService,
  type IntegrationStatusInput
} from '@/features/settings/integrations-catalog';
import { AddConnectionMenu } from './add-connection-toolbar';
import { getColumns, lastActivityTimestamp } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<ConnectionDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' },
  { id: 'provider', accessor: (row) => row.provider, filterVariant: 'multiSelect' },
  { id: 'status', accessor: (row) => row.status, filterVariant: 'multiSelect' },
  { id: 'lastActivity', accessor: (row) => lastActivityTimestamp(row) ?? '' }
];

/**
 * One unified table across every connection (loxep-4t7), replacing the
 * per-provider tables the page used to stack vertically — with 14+
 * providers that was a horizontal-scroll slog reading as ten near-identical
 * widgets rather than one surface.
 *
 * Grouping is gone; PROVIDER is now just a column (badge + filter chip). The
 * integrations catalog (`@/features/settings/integrations-catalog`) still
 * decides what "Add connection" offers and what the Provider filter's chip
 * list contains, so `provider`/`kind` remain system-supplied facts an
 * operator never types, and a service that isn't set up yet still says so
 * rather than offering a form that would fail.
 *
 * loxep-dgg parity, without sections to hide: a disabled provider (the
 * `integrations.enabled` setting) with zero connections contributes neither
 * an "Add connection" menu item nor a Provider filter chip — see
 * `visibleServices` below, which both derive from. A disabled provider that
 * DOES have connections keeps them fully visible and functional in the
 * table (never silently halted to tidy a grid); it keeps its filter chip
 * too, and its rows carry a "Disabled here" flag in the Provider cell so the
 * state is legible without a separate section header to hang it on.
 */
export default function ConnectionsTable({ isAdmin }: { isAdmin: boolean }) {
  const { data, isPending, isError, error, refetch } = useQuery(connectionsQuery);
  const { data: entities, isPending: entitiesPending } = useQuery(entitiesQuery);
  // Admin-only server function: fetched only when it can succeed, and only
  // used to decide whether adding an eBay account can work at all.
  const { data: ebayKeyset } = useQuery({ ...ebayKeysetStatusQuery, enabled: isAdmin });
  // Admin-only server function: same reasoning as ebayKeyset above, for
  // whether adding an Etsy shop can work at all.
  const { data: etsyKeyset } = useQuery({ ...etsyKeysetStatusQuery, enabled: isAdmin });
  // Member-readable (loxep-dgg): filters which services offer "Add account"
  // and flags existing connections of a disabled provider. Missing/loading
  // reads as the empty map, i.e. everything enabled — the same
  // absence-means-visible default the setting itself ships with.
  const { data: enabledMap } = useQuery(integrationsEnabledQuery);
  const catalogEnabledMap: IntegrationEnabledMap = enabledMap ?? {};
  const [addServiceId, setAddServiceId] = React.useState<string | null>(null);
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;

  if (isPending || entitiesPending) {
    return <DataTableSkeleton columnCount={8} filterCount={3} />;
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
    ebayKeyset: ebayKeyset ?? null,
    etsyKeyset: etsyKeyset ?? null
  };
  const activeCount = connections.filter((connection) => connection.status === 'active').length;
  // Archived accounts are retired, so they are not part of the "of N" the
  // headline counts; they still appear in the table (muted) and in the
  // status filter, so nothing is hidden.
  const liveCount = connections.filter((connection) => connection.status !== 'archived').length;
  const archivedCount = connections.length - liveCount;

  // A disabled provider (loxep-dgg) is hidden from "connection-add options"
  // and the provider filter entirely when it has no existing accounts —
  // that's exactly what hiding it means. When it DOES have existing
  // accounts, it stays "visible": its rows keep showing (and syncing)
  // exactly as before, its filter chip stays offered, and its "Add
  // connection" menu item stays present but blocked (see
  // AddConnectionMenu), mirroring the existing `blockedReason` UI other
  // unmet prerequisites already use.
  const visibleServices = connectableIntegrationServices.filter((service) => {
    if (isIntegrationEnabled(catalogEnabledMap, service.id)) return true;
    return connections.some((connection) => connection.provider === service.accounts?.provider);
  });

  const disabledProviders = new Set(
    visibleServices
      .filter((service) => !isIntegrationEnabled(catalogEnabledMap, service.id))
      .map((service) => service.accounts?.provider)
      .filter((provider): provider is string => provider !== undefined)
  );

  const catalogProviders = new Set(
    connectableIntegrationServices.map((service) => service.accounts?.provider)
  );
  const uncataloguedProviders = Array.from(
    new Set(
      connections
        .filter((connection) => !catalogProviders.has(connection.provider))
        .map((connection) => connection.provider)
    )
  );

  const providerOptions = [
    ...visibleServices.map((service) => ({
      value: service.accounts?.provider ?? service.id,
      label: disabledProviders.has(service.accounts?.provider ?? '')
        ? `${service.name} (disabled)`
        : service.name
    })),
    ...uncataloguedProviders.map((provider) => ({ value: provider, label: provider }))
  ];

  // Defense in depth alongside AddConnectionMenu's own disabled item: even
  // if `addServiceId` somehow named a disabled-here service, the dialog
  // itself never opens for it.
  const addService =
    visibleServices.find(
      (service) =>
        service.id === addServiceId && isIntegrationEnabled(catalogEnabledMap, service.id)
    ) ?? null;

  const columns = getColumns({
    entities: entities ?? [],
    isAdmin,
    disabledProviders,
    providerOptions
  });

  const { rows, pageCount } = applyClientTableState(
    connections,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );

  return (
    <ConnectionsDataTable
      rows={rows}
      pageCount={pageCount}
      columns={columns}
      total={connections.length}
      activeCount={activeCount}
      liveCount={liveCount}
      archivedCount={archivedCount}
      isAdmin={isAdmin}
      visibleServices={visibleServices}
      statusInput={statusInput}
      catalogEnabledMap={catalogEnabledMap}
      onAddService={setAddServiceId}
    >
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
    </ConnectionsDataTable>
  );
}

/**
 * The table itself, split out only so `useDataTable` (which reads/writes URL
 * search state on every render) is called with `columns`/`rows` that are
 * already fully resolved, matching the shape `useDataTable` callers use
 * elsewhere in the codebase.
 */
function ConnectionsDataTable({
  rows,
  pageCount,
  columns,
  total,
  activeCount,
  liveCount,
  archivedCount,
  isAdmin,
  visibleServices,
  statusInput,
  catalogEnabledMap,
  onAddService,
  children
}: {
  rows: ConnectionDto[];
  pageCount: number;
  columns: ReturnType<typeof getColumns>;
  total: number;
  activeCount: number;
  liveCount: number;
  archivedCount: number;
  isAdmin: boolean;
  visibleServices: IntegrationService[];
  statusInput: IntegrationStatusInput;
  catalogEnabledMap: IntegrationEnabledMap;
  onAddService: (serviceId: string) => void;
  children?: React.ReactNode;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    shallow: true,
    debounceMs: 500,
    initialState: {
      columnPinning: { start: [], end: ['actions'] },
      // Chosen so the table needs no horizontal scroll at a 1440px viewport
      // (verified with a Playwright scrollWidth/clientWidth check, loxep-4t7)
      // — Entity and Credential state stay one toggle away in the View menu.
      columnVisibility: { entity: false, credentialState: false }
    }
  });

  return (
    <div className='flex flex-col gap-4'>
      {total > 0 && (
        <p className='text-sm'>
          <span className='text-primary text-2xl font-semibold tabular-nums'>{activeCount}</span>{' '}
          <span className='text-muted-foreground'>
            of {liveCount} account{liveCount === 1 ? '' : 's'} active
            {archivedCount > 0 ? ` · ${archivedCount} archived` : ''}
          </span>
        </p>
      )}
      <DataTable table={table}>
        <DataTableToolbar table={table}>
          {isAdmin && (
            <AddConnectionMenu
              services={visibleServices}
              statusInput={statusInput}
              enabledMap={catalogEnabledMap}
              onSelect={onAddService}
            />
          )}
        </DataTableToolbar>
      </DataTable>
      {children}
    </div>
  );
}
