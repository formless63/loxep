import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { formatRelativeTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { GatusEstateEndpointDto } from '@/server/gatus-estate-functions';

export function gatusEndpointColumns(
  onViewUptime: (endpoint: GatusEstateEndpointDto) => void,
  selectedKey: string | null
): ColumnDef<DataTableFeatures, GatusEstateEndpointDto>[] {
  return [
    {
      id: 'key',
      accessorKey: 'key',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, GatusEstateEndpointDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Key' />,
      cell: ({ row }) => <span className='font-mono text-sm font-medium'>{row.original.key}</span>,
      meta: {
        label: 'Key',
        placeholder: 'Search endpoints...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'group',
      header: 'Group',
      cell: ({ row }) => (
        <span className='text-muted-foreground text-sm'>{row.original.group ?? '—'}</span>
      )
    },
    {
      id: 'name',
      header: 'Name',
      cell: ({ row }) => <span className='text-sm'>{row.original.name ?? '—'}</span>
    },
    {
      id: 'success',
      header: 'Latest result',
      cell: ({ row }) => {
        const { success, httpStatus } = row.original;
        return (
          <div className='flex items-center gap-1.5'>
            <ToneBadge tone={success === null ? 'outline' : success ? 'success' : 'destructive'}>
              {success === null ? 'no result yet' : success ? 'success' : 'failing'}
            </ToneBadge>
            {httpStatus !== null && (
              <span className='text-muted-foreground text-xs'>HTTP {httpStatus}</span>
            )}
          </div>
        );
      }
    },
    {
      id: 'errorCount',
      header: 'Errors',
      cell: ({ row }) => <span className='text-sm'>{row.original.errorCount}</span>
    },
    {
      id: 'observedAt',
      header: 'Observed',
      cell: ({ row }) =>
        row.original.observedAt === null ? (
          <span className='text-muted-foreground text-sm'>—</span>
        ) : (
          <span className='text-muted-foreground text-sm'>
            Gatus: {formatRelativeTime(row.original.observedAt)}
          </span>
        )
    },
    {
      id: 'loxep',
      header: 'Loxep',
      cell: ({ row }) => {
        const loxep = row.original.loxep;
        if (loxep === null) {
          return <span className='text-muted-foreground text-sm'>Not linked</span>;
        }
        return (
          <Button size='sm' variant='link' className='h-auto p-0' asChild>
            <Link to='/infrastructure/fleet/$name' params={{ name: loxep.hostingTargetName }}>
              <Icons.circleCheck className='mr-1 h-3.5 w-3.5' /> {loxep.hostingTargetName}
            </Link>
          </Button>
        );
      }
    },
    {
      id: 'uptime',
      header: 'Uptime',
      cell: ({ row }) => {
        const isOpen = selectedKey === row.original.key;
        return (
          <Button
            size='sm'
            variant={isOpen ? 'default' : 'outline'}
            onClick={() => onViewUptime(row.original)}
          >
            {isOpen ? 'Hide uptime' : 'View uptime'}
          </Button>
        );
      }
    }
  ];
}
