import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { formatDateTime } from '@/lib/format';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import { CONNECTION_STATUS_LABELS } from '@/features/settings/constants';
import { integrationServiceForProvider } from '@/features/settings/integrations-catalog';
import { EbayCredentialStatus } from '@/features/settings/components/ebay-connection-actions';
import type { ConnectionDto, EntityDto } from '@/server/admin-functions';
import type { ConnectionStatus } from '@loxep/domain';
import { AttributionCell } from './attribution-cell';
import { CellAction } from './cell-action';

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

export function getColumns(
  entities: EntityDto[],
  isAdmin: boolean,
  showService: boolean
): ColumnDef<ConnectionDto>[] {
  const columns: ColumnDef<ConnectionDto>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<ConnectionDto, unknown> }) => (
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
    }
  ];

  if (showService) {
    columns.push({
      id: 'service',
      header: 'Service',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>
          {integrationServiceForProvider(row.original.provider)?.name ?? row.original.provider}
        </span>
      )
    });
  }

  columns.push(
    {
      id: 'status',
      accessorKey: 'status',
      header: ({ column }: { column: Column<ConnectionDto, unknown> }) => (
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
      meta: { label: 'status', variant: 'multiSelect' as const, options: CONNECTION_STATUS_OPTIONS }
    },
    {
      id: 'entity',
      header: 'Entity',
      cell: ({ row }) => (
        <AttributionCell connection={row.original} entities={entities} isAdmin={isAdmin} />
      )
    },
    {
      id: 'credentials',
      header: 'Credentials',
      cell: ({ row }) =>
        row.original.provider === EBAY_PROVIDER ? (
          <EbayCredentialStatus connection={row.original} />
        ) : row.original.credentials.length === 0 ? (
          <span className='text-muted-foreground'>none</span>
        ) : (
          <div className='flex flex-wrap gap-1'>
            {row.original.credentials.map((credential) => (
              <Badge key={credential.credentialType} variant='outline'>
                {credential.credentialType} v{credential.currentVersion}
              </Badge>
            ))}
          </div>
        )
    },
    {
      id: 'lastSuccessAt',
      accessorKey: 'lastSuccessAt',
      header: ({ column }: { column: Column<ConnectionDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Last success' />
      ),
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>
          {formatDateTime(cell.getValue<string | null>())}
        </span>
      )
    },
    {
      id: 'lastErrorAt',
      header: 'Last error',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>
          {row.original.lastErrorAt
            ? `${formatDateTime(row.original.lastErrorAt)} (${row.original.lastErrorCode ?? 'unknown'})`
            : '—'}
        </span>
      )
    }
  );

  if (isAdmin) {
    columns.push({
      id: 'actions',
      cell: ({ row }) => <CellAction data={row.original} />
    });
  }

  return columns;
}
