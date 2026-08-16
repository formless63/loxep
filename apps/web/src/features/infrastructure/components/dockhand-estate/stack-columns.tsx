import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import type { DockhandEstateStackDto } from '@/server/dockhand-estate-functions';

/** NO lifecycle column here either — rule 13, same discipline as `container-columns.tsx`. */
export const dockhandEstateStackColumns: ColumnDef<DataTableFeatures, DockhandEstateStackDto>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, DockhandEstateStackDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Stack' />,
    cell: ({ row }) => <span className='font-medium'>{row.original.name}</span>,
    meta: {
      label: 'Stack',
      placeholder: 'Search stacks...',
      variant: 'text' as const,
      icon: Icons.text
    },
    enableColumnFilter: true
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <span className='text-sm'>{row.original.status || 'unknown'}</span>
  },
  {
    id: 'sourceType',
    header: 'Source',
    cell: ({ row }) => (
      <span className='text-muted-foreground font-mono text-xs'>
        {row.original.sourceType ?? '—'}
      </span>
    )
  },
  {
    id: 'containers',
    header: 'Containers',
    cell: ({ row }) => (
      <span className='text-sm'>
        {row.original.runningContainerCount}/{row.original.containerCount} running
      </span>
    )
  }
];
