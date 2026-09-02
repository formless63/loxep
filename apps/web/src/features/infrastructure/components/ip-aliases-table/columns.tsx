import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { BooleanStatusBadge } from '@/features/settings/components/status-tone';
import {
  IP_ALIAS_SOURCE_LABELS,
  IP_ALIAS_SOURCE_OPTIONS
} from '@/features/infrastructure/constants';
import { formatRelativeTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { IpAliasDto } from '@/server/infrastructure-functions';
import { CellAction } from './cell-action';

export function getColumns(
  isAdmin: boolean,
  onEdit: (alias: IpAliasDto) => void
): ColumnDef<DataTableFeatures, IpAliasDto>[] {
  const columns: ColumnDef<DataTableFeatures, IpAliasDto>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<DataTableFeatures, IpAliasDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Name' />
      ),
      cell: ({ cell }) => <span className='font-mono font-medium'>{cell.getValue<string>()}</span>,
      meta: {
        label: 'Name',
        placeholder: 'Search aliases...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'address',
      accessorKey: 'address',
      header: ({ column }: { column: Column<DataTableFeatures, IpAliasDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Current address' />
      ),
      cell: ({ row }) => (
        <div className='flex flex-col'>
          <span className='font-mono'>{row.original.address}</span>
          {row.original.previousAddress !== null && (
            <span className='text-muted-foreground font-mono text-xs'>
              was {row.original.previousAddress}
            </span>
          )}
        </div>
      )
    },
    {
      id: 'source',
      accessorKey: 'source',
      header: ({ column }: { column: Column<DataTableFeatures, IpAliasDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Source' />
      ),
      cell: ({ row }) => (
        <Badge variant='outline'>
          {IP_ALIAS_SOURCE_LABELS[row.original.source] ?? row.original.source}
        </Badge>
      ),
      enableColumnFilter: true,
      meta: { label: 'Source', variant: 'multiSelect' as const, options: IP_ALIAS_SOURCE_OPTIONS }
    },
    {
      id: 'autoApply',
      accessorKey: 'autoApply',
      header: 'Auto-apply',
      cell: ({ cell }) => (
        <BooleanStatusBadge
          value={cell.getValue<boolean>()}
          trueLabel='on'
          falseLabel='off'
          falseTone='secondary'
        />
      )
    },
    {
      id: 'boundRulesCount',
      accessorKey: 'boundRulesCount',
      header: ({ column }: { column: Column<DataTableFeatures, IpAliasDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Bound rules' />
      ),
      cell: ({ row }) => (
        <span className='tabular-nums'>
          {row.original.boundRulesCount === 0 ? (
            <span className='text-muted-foreground'>none</span>
          ) : (
            row.original.boundRulesCount
          )}
        </span>
      )
    },
    {
      id: 'confirmedAt',
      accessorKey: 'confirmedAt',
      header: ({ column }: { column: Column<DataTableFeatures, IpAliasDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Last changed' />
      ),
      cell: ({ row }) => {
        // `confirmedAt` (an operator edit) and `observedAt` (a detector run)
        // are two different clocks — the design's own distinction. Whichever
        // is more recent is "last changed" for a glance-level column; both
        // remain visible on the edit dialog.
        const latest = [row.original.confirmedAt, row.original.observedAt]
          .filter((value): value is string => value !== null)
          .toSorted()
          .at(-1);
        return <span className='text-muted-foreground'>{formatRelativeTime(latest ?? null)}</span>;
      }
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
