import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDateTime } from '@/lib/format';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import { CONNECTION_STATUS_LABELS } from '@/features/settings/constants';
import { integrationServiceForProvider } from '@/features/settings/integrations-catalog';
import { EbayCredentialStatus } from '@/features/settings/components/ebay-connection-actions';
import type { ConnectionDto, EntityDto } from '@/server/admin-functions';
import type { ConnectionStatus, ProviderWritePolicyTier } from '@loxep/domain';
import { AttributionCell } from './attribution-cell';
import { CellAction } from './cell-action';
import { OrderSyncStatusCell, supportsOrderSync } from './order-sync-cell';
import { PurchaseSyncStatusCell, supportsPurchaseSync } from './purchase-sync-cell';
import { TAILSCALE_PROVIDER, TailscaleCredentialExpiryCell } from './tailscale-expiry-cell';
import { TERMIX_PROVIDER, TermixAuthStatusCell } from './termix-auth-status-cell';
import { WritePolicyCell, writePolicySortKey } from './write-policy-cell';

const EBAY_PROVIDER = 'ebay';

/**
 * `disabled` is operator-caused, not a failure — it renders `warning`, never
 * the same alarm red as `error` (a genuine connection failure). `archived` is
 * a neutral terminal state and renders `outline` for the same reason: an
 * operator state is never alarm red.
 */
const CONNECTION_STATUS_TONE = {
  active: 'success',
  disabled: 'warning',
  error: 'destructive',
  archived: 'outline'
} as const satisfies Record<ConnectionStatus, Tone>;

const CONNECTION_STATUS_OPTIONS = (Object.keys(CONNECTION_STATUS_LABELS) as ConnectionStatus[]).map(
  (value) => ({ value, label: CONNECTION_STATUS_LABELS[value] })
);

/**
 * Explanatory text for both the toolbar's "why is Add account disabled"
 * caption and the provider badge's flag tooltip — kept as one string
 * (loxep-dgg, carried over from the pre-unification per-section layout by
 * loxep-4t7) so the two surfaces never drift apart.
 */
export const PROVIDER_DISABLED_EXPLANATION =
  'This integration is disabled in this installation’s catalog. Existing accounts keep syncing unchanged; enable it again from the Integrations page to add another.';

/**
 * Read-only credential-state dispatch for the unified table's "Credential
 * state" column (loxep-4t7) — one column now stands in for what used to be
 * per-service tables that never had to disambiguate providers within a
 * single column. This is composition, not new logic: every branch calls an
 * existing, already-reviewed cell component unchanged (`EbayCredentialStatus`,
 * `TailscaleCredentialExpiryCell`, `TermixAuthStatusCell`); only the generic
 * fallback (plain credential-type badges) lives here, exactly as it did in
 * the pre-unification `columns.tsx`. Etsy has no dedicated per-connection
 * cell of its own (unlike eBay) so it falls through to that same generic
 * fallback today, matching current behaviour rather than inventing a new
 * component this bead was not scoped to build.
 */
function CredentialStateCell({ connection }: { connection: ConnectionDto }) {
  if (connection.provider === EBAY_PROVIDER) {
    return <EbayCredentialStatus connection={connection} />;
  }
  if (connection.provider === TAILSCALE_PROVIDER) {
    return <TailscaleCredentialExpiryCell connection={connection} />;
  }
  if (connection.provider === TERMIX_PROVIDER) {
    return <TermixAuthStatusCell connection={connection} />;
  }
  if (connection.credentials.length === 0) {
    return <span className='text-muted-foreground'>none</span>;
  }
  return (
    <div className='flex flex-wrap gap-1'>
      {connection.credentials.map((credential) => (
        <Badge key={credential.credentialType} variant='outline'>
          {credential.credentialType} v{credential.currentVersion}
        </Badge>
      ))}
    </div>
  );
}

/** Sort/toggle key for the credential-state column — a stable string per branch, not display text. */
function credentialStateSortKey(connection: ConnectionDto): string {
  if (
    connection.provider === EBAY_PROVIDER ||
    connection.provider === TAILSCALE_PROVIDER ||
    connection.provider === TERMIX_PROVIDER
  ) {
    return connection.provider;
  }
  return connection.credentials.length === 0 ? 'none' : 'present';
}

/**
 * Merged "Sync" column (loxep-4t7): what used to be two full-width columns
 * (Order sync, Purchase sync) — needed because eBay is the only provider
 * with both concepts at once — is now one column with a labelled sub-row per
 * concept. The outer collapse to a single em-dash for a provider with
 * NEITHER concept (every infrastructure/notification provider) only calls
 * the existing, unmodified `supportsOrderSync`/`supportsPurchaseSync`
 * predicates; once either applies, the actual state rendering is entirely
 * `OrderSyncStatusCell`/`PurchaseSyncStatusCell` unchanged — including their
 * own "not applicable" em-dash for the concept that row doesn't have (a
 * WooCommerce row's Purchases sub-row, for instance). Nothing here
 * re-derives eligibility or health; it only decides whether to show the
 * two-line layout at all.
 */
function SyncSummaryCell({ connection }: { connection: ConnectionDto }) {
  if (!supportsOrderSync(connection) && !supportsPurchaseSync(connection)) {
    return <span className='text-muted-foreground'>—</span>;
  }
  return (
    <div className='flex flex-col items-start gap-1'>
      <div className='flex items-center gap-1.5'>
        <span className='text-muted-foreground text-xs'>Orders</span>
        {/* `data-testid` scoped to only the reused cell's own output (not
            this label) so `.toHaveText('—')`-style assertions still match
            the exact glyph OrderSyncStatusCell renders — see
            `apps/web/e2e/connections.spec.ts`. */}
        <span data-testid='order-sync-status'>
          <OrderSyncStatusCell connection={connection} />
        </span>
      </div>
      <div className='flex items-center gap-1.5'>
        <span className='text-muted-foreground text-xs'>Purchases</span>
        <span data-testid='purchase-sync-status'>
          <PurchaseSyncStatusCell connection={connection} />
        </span>
      </div>
    </div>
  );
}

/** Sort/toggle key for the sync column: on beats off, applicable beats not. */
function syncSummarySortKey(connection: ConnectionDto): string {
  const orderOn = connection.orderSync?.enabled ?? false;
  const purchaseOn = connection.purchaseSync?.enabled ?? false;
  if (orderOn || purchaseOn) return '0';
  if (supportsOrderSync(connection) || supportsPurchaseSync(connection)) return '1';
  return '2';
}

/**
 * The more recent of `lastSuccessAt`/`lastErrorAt`, or `null` when neither has
 * happened yet. Exported so the table container's client-side sort spec
 * (`applyClientTableState`) can order by the same value this column renders.
 */
export function lastActivityTimestamp(connection: ConnectionDto): string | null {
  const { lastSuccessAt, lastErrorAt } = connection;
  if (lastSuccessAt === null) return lastErrorAt;
  if (lastErrorAt === null) return lastSuccessAt;
  return new Date(lastErrorAt).getTime() > new Date(lastSuccessAt).getTime()
    ? lastErrorAt
    : lastSuccessAt;
}

/**
 * Merged "Last activity" column (loxep-4t7): replaces the previous two
 * columns (Last success, Last error) with the single most-recent event,
 * toned to match — `success` when the latest thing that happened was a
 * success, `destructive` when it was an error — with the other timestamp (if
 * any) in the tooltip so neither fact is lost, only de-prioritised.
 */
function LastActivityCell({ connection }: { connection: ConnectionDto }) {
  const at = lastActivityTimestamp(connection);
  if (at === null) {
    return <span className='text-muted-foreground'>—</span>;
  }
  const latestIsError = at === connection.lastErrorAt;
  const title = latestIsError
    ? connection.lastSuccessAt
      ? `Last successful sync ${formatDateTime(connection.lastSuccessAt)}`
      : 'No successful sync recorded yet'
    : connection.lastErrorAt
      ? `Last error ${formatDateTime(connection.lastErrorAt)}${
          connection.lastErrorCode ? ` (${connection.lastErrorCode})` : ''
        }`
      : undefined;
  return (
    <ToneBadge tone={latestIsError ? 'destructive' : 'success'} title={title}>
      {latestIsError
        ? `Error${connection.lastErrorCode ? ` · ${connection.lastErrorCode}` : ''}`
        : 'Success'}
      {' · '}
      {formatDateTime(at)}
    </ToneBadge>
  );
}

export function getColumns({
  entities,
  isAdmin,
  disabledProviders,
  providerOptions,
  writePolicies
}: {
  entities: EntityDto[];
  isAdmin: boolean;
  /** Providers whose catalog entry is disabled (loxep-dgg) — flags their badge, never hides their row. */
  disabledProviders: Set<string>;
  /**
   * Filter-chip options for the Provider column — computed by the container,
   * which is the thing that already knows which providers are "visible"
   * (loxep-dgg parity: a disabled provider with zero connections offers
   * neither an add-action nor a filter chip, see `index.tsx`).
   */
  providerOptions: { label: string; value: string }[];
  /** The whole `infrastructure.provider_write_policy` map (Pangolin chain design M3) — a connection absent from it is `'read_only'`. */
  writePolicies: Record<string, ProviderWritePolicyTier>;
}): ColumnDef<DataTableFeatures, ConnectionDto>[] {
  const columns: ColumnDef<DataTableFeatures, ConnectionDto>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<DataTableFeatures, ConnectionDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Account' />
      ),
      // Archived rows read as retired, not broken: the name goes muted while
      // the status badge (tone `outline`) carries the state itself.
      cell: ({ row, cell }) => (
        <span
          className={
            row.original.status === 'archived' ? 'text-muted-foreground font-medium' : 'font-medium'
          }
        >
          {cell.getValue<string>()}
        </span>
      ),
      meta: {
        label: 'Account',
        placeholder: 'Search accounts...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'provider',
      accessorKey: 'provider',
      header: ({ column }: { column: Column<DataTableFeatures, ConnectionDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Provider' />
      ),
      cell: ({ row }) => {
        const provider = row.original.provider;
        const service = integrationServiceForProvider(provider);
        const flagged = disabledProviders.has(provider);
        return (
          <div className='flex flex-wrap items-center gap-1.5'>
            <Badge variant='secondary'>{service?.name ?? provider}</Badge>
            {flagged && (
              <ToneBadge tone='warning' title={PROVIDER_DISABLED_EXPLANATION}>
                Disabled here
              </ToneBadge>
            )}
          </div>
        );
      },
      enableColumnFilter: true,
      meta: {
        label: 'Provider',
        icon: Icons.integrations,
        variant: 'multiSelect' as const,
        options: providerOptions
      }
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: ({ column }: { column: Column<DataTableFeatures, ConnectionDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Status' />
      ),
      cell: ({ cell }) => {
        const status = cell.getValue<ConnectionStatus>();
        return (
          <ToneBadge tone={CONNECTION_STATUS_TONE[status]}>
            {CONNECTION_STATUS_LABELS[status]}
          </ToneBadge>
        );
      },
      enableColumnFilter: true,
      meta: { label: 'Status', variant: 'multiSelect' as const, options: CONNECTION_STATUS_OPTIONS }
    },
    {
      id: 'entity',
      accessorFn: (row) => row.economicEntityId ?? '',
      header: 'Entity',
      cell: ({ row }) => (
        <AttributionCell connection={row.original} entities={entities} isAdmin={isAdmin} />
      ),
      meta: { label: 'Entity' }
    },
    {
      id: 'credentialState',
      accessorFn: (row) => credentialStateSortKey(row),
      header: 'Credential state',
      cell: ({ row }) => <CredentialStateCell connection={row.original} />,
      meta: { label: 'Credential state' }
    },
    {
      id: 'writePolicy',
      accessorFn: (row) => writePolicySortKey(writePolicies, row),
      header: 'Write policy',
      cell: ({ row }) => (
        <WritePolicyCell connection={row.original} policies={writePolicies} isAdmin={isAdmin} />
      ),
      meta: { label: 'Write policy' }
    },
    {
      id: 'syncHealth',
      accessorFn: (row) => syncSummarySortKey(row),
      header: 'Sync',
      cell: ({ row }) => <SyncSummaryCell connection={row.original} />,
      meta: { label: 'Sync' }
    },
    {
      id: 'lastActivity',
      accessorFn: (row) => lastActivityTimestamp(row) ?? '',
      header: ({ column }: { column: Column<DataTableFeatures, ConnectionDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Last activity' />
      ),
      cell: ({ row }) => <LastActivityCell connection={row.original} />,
      meta: { label: 'Last activity' }
    }
  ];

  if (isAdmin) {
    columns.push({
      id: 'actions',
      accessorFn: () => null,
      header: 'Actions',
      cell: ({ row }) => <CellAction data={row.original} />,
      meta: { label: 'Actions' }
    });
  }

  return columns;
}
