import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { BooleanStatusBadge } from '@/features/settings/components/status-tone';

export interface CheckRow {
  name: string;
  ok: boolean;
  detail?: string;
}

export const checkColumns: ColumnDef<CheckRow>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: ({ column }: { column: Column<CheckRow, unknown> }) => (
      <DataTableColumnHeader column={column} title='Name' />
    ),
    cell: ({ cell }) => <span className='font-medium'>{cell.getValue<string>()}</span>,
    meta: {
      label: 'Name',
      placeholder: 'Search checks...',
      variant: 'text' as const,
      icon: Icons.text
    },
    enableColumnFilter: true
  },
  {
    id: 'ok',
    accessorKey: 'ok',
    header: ({ column }: { column: Column<CheckRow, unknown> }) => (
      <DataTableColumnHeader column={column} title='Status' />
    ),
    cell: ({ cell }) => (
      <BooleanStatusBadge value={cell.getValue<boolean>()} trueLabel='ok' falseLabel='failing' />
    )
  },
  {
    id: 'detail',
    header: 'Detail',
    cell: ({ row }) => (
      <span className='text-muted-foreground max-w-xl whitespace-normal break-words'>
        {row.original.detail ?? '—'}
      </span>
    )
  }
];
