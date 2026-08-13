import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import {
  MANAGED_DOMAIN_STATE_LABELS,
  MANAGED_DOMAIN_STATE_OPTIONS,
  MANAGED_DOMAIN_STATE_TONE
} from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import type { DataTableFeatures } from '@/lib/table-features';
import type { ManagedDomainDto } from '@/server/infrastructure-functions';

export function getColumns(): ColumnDef<DataTableFeatures, ManagedDomainDto>[] {
  return [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<DataTableFeatures, ManagedDomainDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Name' />
      ),
      cell: ({ row }) => (
        <Link
          to='/infrastructure/domains/$name'
          params={{ name: row.original.name }}
          className='font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          {row.original.name}
        </Link>
      ),
      meta: {
        label: 'Name',
        placeholder: 'Search domains...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'state',
      accessorKey: 'state',
      header: ({ column }: { column: Column<DataTableFeatures, ManagedDomainDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='State' />
      ),
      cell: ({ row }) => (
        <ToneBadge tone={MANAGED_DOMAIN_STATE_TONE[row.original.state] ?? 'secondary'}>
          {MANAGED_DOMAIN_STATE_LABELS[row.original.state] ?? row.original.state}
        </ToneBadge>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'State',
        variant: 'multiSelect' as const,
        options: MANAGED_DOMAIN_STATE_OPTIONS
      }
    },
    {
      id: 'target',
      header: 'Hosting target',
      cell: ({ row }) =>
        row.original.apexTargetName ? (
          <span>{row.original.apexTargetName}</span>
        ) : (
          <span className='text-muted-foreground'>DNS only</span>
        )
    },
    {
      id: 'mail',
      header: 'Mail',
      cell: ({ row }) => {
        if (!row.original.mailEnabled) {
          return <span className='text-muted-foreground'>Disabled</span>;
        }
        if (row.original.mailVerified) {
          return (
            <Badge variant='success'>
              <Icons.circleCheck />
              verified
            </Badge>
          );
        }
        if (row.original.mailRegistered) {
          return (
            <Badge variant='warning'>
              <Icons.clock />
              pending
            </Badge>
          );
        }
        return <span className='text-muted-foreground'>Not registered</span>;
      }
    },
    {
      id: 'drift',
      header: 'Drift',
      cell: ({ row }) =>
        row.original.driftDetectedAt ? (
          <Badge variant='destructive'>
            <Icons.alertCircle />
            drifted
          </Badge>
        ) : (
          <span className='text-muted-foreground'>—</span>
        )
    }
  ];
}
