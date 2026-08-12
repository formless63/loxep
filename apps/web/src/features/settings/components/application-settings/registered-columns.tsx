import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { formatDateTime } from '@/lib/format';
import type { RegisteredSettingDto } from '@/server/admin-functions';

/**
 * Serialized setting value for display. Long values are clipped by the cell
 * (`truncate`) rather than here, so the full serialization stays available as
 * the cell's `title` — table cells are `whitespace-nowrap`, and an unclipped
 * value in a width-constrained cell overflows on top of its neighbours.
 */
function formatValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return '—';
  return serialized;
}

export const registeredColumns: ColumnDef<RegisteredSettingDto>[] = [
  {
    id: 'key',
    accessorKey: 'key',
    header: ({ column }: { column: Column<RegisteredSettingDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Key' />
    ),
    cell: ({ cell }) => (
      <span className='max-w-64 font-mono text-xs break-all whitespace-normal'>
        {cell.getValue<string>()}
      </span>
    ),
    meta: {
      label: 'Key',
      placeholder: 'Search keys...',
      variant: 'text' as const,
      icon: Icons.text
    },
    enableColumnFilter: true
  },
  {
    id: 'description',
    header: 'Description',
    cell: ({ row }) => (
      <span className='text-muted-foreground max-w-md whitespace-normal'>
        {row.original.description}
      </span>
    )
  },
  {
    id: 'value',
    header: 'Value',
    cell: ({ row }) => (
      <span className='max-w-xs truncate font-mono text-xs' title={formatValue(row.original.value)}>
        {formatValue(row.original.value)}
      </span>
    )
  },
  {
    id: 'isSet',
    accessorKey: 'isSet',
    header: ({ column }: { column: Column<RegisteredSettingDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Source' />
    ),
    cell: ({ cell }) => (
      <Badge variant={cell.getValue<boolean>() ? 'secondary' : 'outline'}>
        {cell.getValue<boolean>() ? 'stored' : 'default'}
      </Badge>
    )
  },
  {
    id: 'updatedAt',
    accessorKey: 'updatedAt',
    header: ({ column }: { column: Column<RegisteredSettingDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Updated' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>
        {formatDateTime(cell.getValue<string | null>())}
      </span>
    )
  }
];
