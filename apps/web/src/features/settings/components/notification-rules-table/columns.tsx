import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { BooleanStatusBadge } from '@/features/settings/components/status-tone';
import { marketEventTypeLabel, marketEventTypeOptions } from '@/features/settings/constants';
import type { DataTableFeatures } from '@/lib/table-features';
import type { NotificationRuleDto } from '@/server/admin-functions';
import { CellAction } from './cell-action';

export function getColumns(
  isAdmin: boolean,
  endpointNameById: Map<string, string>,
  monitorNameById: Map<string, string>,
  onEdit: (rule: NotificationRuleDto) => void
): ColumnDef<DataTableFeatures, NotificationRuleDto>[] {
  const columns: ColumnDef<DataTableFeatures, NotificationRuleDto>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<DataTableFeatures, NotificationRuleDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Name' />
      ),
      cell: ({ cell }) => <span className='font-medium'>{cell.getValue<string>()}</span>,
      meta: {
        label: 'Name',
        placeholder: 'Search rules...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'marketEventType',
      accessorKey: 'marketEventType',
      header: ({ column }: { column: Column<DataTableFeatures, NotificationRuleDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Event type' />
      ),
      cell: ({ row }) =>
        row.original.marketEventType ? (
          <Badge variant='outline'>{marketEventTypeLabel(row.original.marketEventType)}</Badge>
        ) : (
          <span className='text-muted-foreground'>any</span>
        ),
      enableColumnFilter: true,
      meta: {
        label: 'event type',
        variant: 'multiSelect' as const,
        options: marketEventTypeOptions
      }
    },
    {
      id: 'monitorTargetId',
      header: 'Monitor',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>
          {row.original.monitorTargetId
            ? (monitorNameById.get(row.original.monitorTargetId) ?? 'unknown')
            : 'any'}
        </span>
      )
    },
    {
      id: 'endpointId',
      header: 'Endpoint',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>
          {endpointNameById.get(row.original.endpointId) ?? 'unknown'}
        </span>
      )
    },
    {
      id: 'enabled',
      accessorKey: 'enabled',
      header: ({ column }: { column: Column<DataTableFeatures, NotificationRuleDto, unknown> }) => (
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
