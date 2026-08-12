import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { formatDateTime, formatQuantity } from '@/lib/format';
import type { RawSettingDto } from '@/server/admin-functions';

export const rawColumns: ColumnDef<RawSettingDto>[] = [
  {
    id: 'key',
    accessorKey: 'key',
    header: ({ column }: { column: Column<RawSettingDto, unknown> }) => (
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
    id: 'schemaVersion',
    accessorKey: 'schemaVersion',
    header: ({ column }: { column: Column<RawSettingDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Schema version' />
    ),
    cell: ({ cell }) => (
      <div className='text-right tabular-nums'>{formatQuantity(cell.getValue<number>())}</div>
    )
  },
  {
    id: 'updatedByUserId',
    header: 'Updated by',
    cell: ({ row }) => (
      <span
        className='text-muted-foreground max-w-48 truncate'
        title={row.original.updatedByUserId ?? 'system'}
      >
        {row.original.updatedByUserId ?? 'system'}
      </span>
    )
  },
  {
    id: 'updatedAt',
    accessorKey: 'updatedAt',
    header: ({ column }: { column: Column<RawSettingDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Updated' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>{formatDateTime(cell.getValue<string>())}</span>
    )
  }
];
