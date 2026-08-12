import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { formatDateTime, formatDuration } from '@/lib/format';
import { StatusBadge } from '@/features/market/components/market-page';
import {
  consecutiveErrorsIcon,
  consecutiveErrorsTone,
  monitorTargetTypeLabel,
  monitorTargetTypeOptions
} from '@/features/market/constants';
import type { MonitorDto } from '@/server/market-functions';
import { CellAction } from './cell-action';

function BackoffBadge({ backoffUntil }: { backoffUntil: string | null }) {
  if (backoffUntil === null || new Date(backoffUntil).getTime() <= Date.now()) {
    return <span className='text-muted-foreground'>—</span>;
  }
  return (
    <Badge variant='warning'>
      <Icons.clock />
      backing off until {formatDateTime(backoffUntil)}
    </Badge>
  );
}

/**
 * `isAdmin` gates the row-action column entirely (rather than rendering a
 * disabled action cell) — mirrors the original component's conditional
 * `TableHead`/`TableCell`. `onEdit` opens the shared `MonitorFormDialog`
 * (owned by `index.tsx`, since it manages one dialog for the whole table).
 */
export function createColumns(
  onEdit: (monitor: MonitorDto) => void,
  isAdmin: boolean
): ColumnDef<MonitorDto>[] {
  const columns: ColumnDef<MonitorDto>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<MonitorDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Name' />
      ),
      cell: ({ cell }) => <span className='font-medium'>{cell.getValue<string>()}</span>
    },
    {
      id: 'targetType',
      accessorKey: 'targetType',
      enableSorting: false,
      header: 'Type',
      cell: ({ cell }) => (
        <Badge variant='outline'>{monitorTargetTypeLabel(cell.getValue<string>())}</Badge>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Type',
        variant: 'multiSelect',
        options: monitorTargetTypeOptions
      }
    },
    {
      id: 'connectionName',
      accessorKey: 'connectionName',
      header: 'Connection',
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>{cell.getValue<string | null>() ?? '—'}</span>
      )
    },
    {
      id: 'enabled',
      accessorKey: 'enabled',
      header: 'Enabled',
      cell: ({ cell }) => (
        <StatusBadge ok={cell.getValue<boolean>()} okLabel='enabled' failLabel='disabled' />
      )
    },
    {
      id: 'intervalSeconds',
      accessorKey: 'intervalSeconds',
      header: ({ column }: { column: Column<MonitorDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Base interval' />
      ),
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatDuration(cell.getValue<number>())}
        </span>
      )
    },
    {
      id: 'nextPollAt',
      accessorKey: 'nextPollAt',
      header: ({ column }: { column: Column<MonitorDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Next poll' />
      ),
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>
          {formatDateTime(cell.getValue<string | null>())}
        </span>
      )
    },
    {
      id: 'consecutiveErrors',
      accessorKey: 'consecutiveErrors',
      header: ({ column }: { column: Column<MonitorDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Consecutive errors' />
      ),
      cell: ({ cell }) => {
        const count = cell.getValue<number>();
        const Icon = consecutiveErrorsIcon(count);
        return (
          <div className='flex justify-end'>
            <Badge variant={consecutiveErrorsTone(count)} className='tabular-nums'>
              <Icon />
              {count}
            </Badge>
          </div>
        );
      }
    },
    {
      id: 'backoff',
      accessorKey: 'backoffUntil',
      enableSorting: false,
      header: 'Backoff',
      cell: ({ cell }) => <BackoffBadge backoffUntil={cell.getValue<string | null>()} />
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
