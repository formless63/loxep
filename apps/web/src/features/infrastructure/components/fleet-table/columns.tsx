import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import {
  CONTROL_SURFACE_LABELS,
  CONTROL_SURFACE_OPTIONS
} from '@/features/infrastructure/constants';
import type { DataTableFeatures } from '@/lib/table-features';
import type { HostingTargetDto } from '@/server/infrastructure-functions';

export function getColumns(): ColumnDef<DataTableFeatures, HostingTargetDto>[] {
  return [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<DataTableFeatures, HostingTargetDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Name' />
      ),
      cell: ({ row }) => (
        <Link
          to='/infrastructure/fleet/$name'
          params={{ name: row.original.name }}
          className='font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          {row.original.name}
        </Link>
      ),
      meta: {
        label: 'Name',
        placeholder: 'Search fleet...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'controlSurface',
      accessorKey: 'controlSurface',
      header: ({ column }: { column: Column<DataTableFeatures, HostingTargetDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Control surface' />
      ),
      cell: ({ row }) => (
        <Badge variant='outline'>
          {CONTROL_SURFACE_LABELS[row.original.controlSurface] ?? row.original.controlSurface}
        </Badge>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Control surface',
        variant: 'multiSelect' as const,
        options: CONTROL_SURFACE_OPTIONS
      }
    },
    {
      id: 'address',
      header: 'Address',
      cell: ({ row }) => (
        <span className='text-muted-foreground font-mono text-sm'>
          {row.original.addressV4 ??
            row.original.addressV6 ??
            row.original.frontedByTargetName ??
            '—'}
        </span>
      )
    },
    {
      id: 'domains',
      header: 'Domains',
      cell: ({ row }) => <span className='tabular-nums'>{row.original.domainCount}</span>
    },
    {
      id: 'tokens',
      header: 'DNS tokens',
      cell: ({ row }) => <span className='tabular-nums'>{row.original.tokenCount}</span>
    }
  ];
}
