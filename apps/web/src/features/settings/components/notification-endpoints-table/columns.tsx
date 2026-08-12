import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { BooleanStatusBadge } from '@/features/settings/components/status-tone';
import type { NotificationEndpointDto } from '@/server/admin-functions';
import { CellAction } from './cell-action';

export function getColumns(
  isAdmin: boolean,
  onEdit: (endpoint: NotificationEndpointDto) => void
): ColumnDef<NotificationEndpointDto>[] {
  const columns: ColumnDef<NotificationEndpointDto>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<NotificationEndpointDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Name' />
      ),
      cell: ({ cell }) => <span className='font-medium'>{cell.getValue<string>()}</span>,
      meta: {
        label: 'Name',
        placeholder: 'Search endpoints...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'baseUrl',
      header: 'Base URL',
      cell: ({ row }) => (
        <span className='text-muted-foreground max-w-xs truncate'>
          {row.original.config.baseUrl}
        </span>
      )
    },
    {
      id: 'topic',
      header: 'Topic',
      cell: ({ row }) => <span className='text-muted-foreground'>{row.original.config.topic}</span>
    },
    {
      id: 'enabled',
      accessorKey: 'enabled',
      header: ({ column }: { column: Column<NotificationEndpointDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Enabled' />
      ),
      cell: ({ cell }) => (
        <BooleanStatusBadge
          value={cell.getValue<boolean>()}
          trueLabel='enabled'
          falseLabel='disabled'
          falseTone='warning'
        />
      )
    },
    {
      id: 'token',
      header: 'Token',
      cell: ({ row }) =>
        row.original.hasToken ? (
          <Badge variant='outline'>token set</Badge>
        ) : (
          <span className='text-muted-foreground'>none</span>
        )
    }
  ];

  if (isAdmin) {
    columns.push({
      id: 'actions',
      cell: ({ row }) => <CellAction data={row.original} onEdit={onEdit} />
    });
  }

  return columns;
}
