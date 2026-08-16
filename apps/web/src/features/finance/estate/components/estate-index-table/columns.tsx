import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import {
  CONNECTION_STATUS_LABELS,
  PROVIDER_WRITE_POLICY_TIER_LABELS
} from '@/features/settings/constants';
import { integrationServiceForProvider } from '@/features/settings/integrations-catalog';
import { lastActivityTimestamp } from '@/features/settings/components/connections-table/columns';
import { formatRelativeTime } from '@/lib/format';
import { estateHref } from '@/features/estate/provider-registry';
import type { DataTableFeatures } from '@/lib/table-features';
import type { ConnectionDto } from '@/server/admin-functions';
import type { ConnectionStatus, ProviderWritePolicyTier } from '@loxep/domain';

/**
 * `/finance/estate`'s index columns (Rule N2) — the `/finance` sibling of
 * `features/infrastructure/components/estate-index-table/columns.tsx`, same
 * shape exactly: one row per finance-category connection, whether or not its
 * provider has a shipped estate page yet.
 */
const CONNECTION_STATUS_TONE = {
  active: 'success',
  disabled: 'warning',
  error: 'destructive',
  archived: 'outline'
} as const satisfies Record<ConnectionStatus, Tone>;

const WRITE_POLICY_TIER_TONE = {
  read_only: 'outline',
  additive: 'success',
  access_affecting: 'warning',
  lockout_class: 'destructive'
} as const satisfies Record<ProviderWritePolicyTier, Tone>;

export function getFinanceEstateIndexColumns({
  writePolicies
}: {
  writePolicies: Record<string, ProviderWritePolicyTier>;
}): ColumnDef<DataTableFeatures, ConnectionDto>[] {
  return [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<DataTableFeatures, ConnectionDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Connection' />
      ),
      cell: ({ cell }) => <span className='font-medium'>{cell.getValue<string>()}</span>,
      meta: {
        label: 'Connection',
        placeholder: 'Search connections...',
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
        const service = integrationServiceForProvider(row.original.provider);
        return <span>{service?.name ?? row.original.provider}</span>;
      },
      enableColumnFilter: true,
      meta: { label: 'Provider', variant: 'multiSelect' as const }
    },
    {
      id: 'health',
      accessorFn: (row) => lastActivityTimestamp(row) ?? '',
      header: 'Health',
      cell: ({ row }) => {
        const connection = row.original;
        const at = lastActivityTimestamp(connection);
        return (
          <div className='flex flex-col gap-0.5'>
            <ToneBadge tone={CONNECTION_STATUS_TONE[connection.status]}>
              {CONNECTION_STATUS_LABELS[connection.status]}
            </ToneBadge>
            {at !== null && (
              <span className='text-muted-foreground text-xs'>
                {at === connection.lastErrorAt ? 'Last error' : 'Last success'}{' '}
                {formatRelativeTime(at)}
              </span>
            )}
          </div>
        );
      },
      meta: { label: 'Health' }
    },
    {
      id: 'writePolicy',
      accessorFn: (row) => writePolicies[row.id] ?? 'read_only',
      header: 'Write policy',
      cell: ({ row }) => {
        const tier = writePolicies[row.original.id] ?? 'read_only';
        return (
          <ToneBadge tone={WRITE_POLICY_TIER_TONE[tier]}>
            {PROVIDER_WRITE_POLICY_TIER_LABELS[tier]}
          </ToneBadge>
        );
      },
      meta: { label: 'Write policy' }
    },
    {
      id: 'open',
      accessorFn: () => null,
      header: 'Estate page',
      cell: ({ row }) => {
        const link = estateHref(row.original.provider, row.original.id);
        if (link === null) {
          return <span className='text-muted-foreground text-sm'>Not built yet</span>;
        }
        return (
          <Button size='sm' variant='outline' asChild>
            <Link to={link.to} params={link.params}>
              Open <Icons.arrowRight className='h-4 w-4' />
            </Link>
          </Button>
        );
      },
      meta: { label: 'Estate page' }
    }
  ];
}
