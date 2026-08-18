import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDateTime } from '@/lib/format';
import { ToneBadge } from '@/features/settings/components/status-tone';
import type { UserDto } from '@/server/admin-functions';
import { CellAction } from './cell-action';

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' }
];

/** `currentUserId` is closed over so the actions cell can guard self-demotion. */
export function getColumns(currentUserId: string): ColumnDef<DataTableFeatures, UserDto>[] {
  return [
    {
      id: 'email',
      accessorKey: 'email',
      header: ({ column }: { column: Column<DataTableFeatures, UserDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Email' />
      ),
      cell: ({ row }) => (
        <div className='flex flex-col'>
          <span className='font-medium'>{row.original.email}</span>
          {row.original.name && (
            <span className='text-muted-foreground text-xs'>{row.original.name}</span>
          )}
        </div>
      ),
      meta: {
        label: 'Email',
        placeholder: 'Search email...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'role',
      accessorKey: 'role',
      header: ({ column }: { column: Column<DataTableFeatures, UserDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Role' />
      ),
      cell: ({ row }) => (
        <div className='flex items-center gap-2'>
          <ToneBadge tone={row.original.role.includes('admin') ? 'default' : 'outline'}>
            {row.original.role}
          </ToneBadge>
          {row.original.banned && (
            <ToneBadge
              tone='destructive'
              title={[
                row.original.banReason ?? 'No reason recorded',
                row.original.banExpires
                  ? `Until ${formatDateTime(row.original.banExpires)}`
                  : 'Permanent'
              ].join(' — ')}
            >
              banned
            </ToneBadge>
          )}
        </div>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'role',
        variant: 'multiSelect' as const,
        options: ROLE_OPTIONS
      }
    },
    {
      id: 'createdAt',
      accessorKey: 'createdAt',
      header: ({ column }: { column: Column<DataTableFeatures, UserDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Created' />
      ),
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>{formatDateTime(cell.getValue<string>())}</span>
      )
    },
    {
      id: 'actions',
      cell: ({ row }) => <CellAction data={row.original} currentUserId={currentUserId} />
    }
  ];
}
