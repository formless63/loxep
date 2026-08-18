import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDateTime, formatQuantity } from '@/lib/format';
import { StatusBadge } from '@/features/market/components/market-page';
import type { OpportunityRuleDto } from '@/server/market-functions';
import { CellAction } from './cell-action';

function conditionGroupCount(conditions: OpportunityRuleDto['conditions']): number {
  return Object.keys(conditions ?? {}).length;
}

/**
 * `isAdmin` gates the row-action column entirely, mirroring
 * `monitors-table/columns.tsx`'s own doc for the same reason. `onEdit` opens
 * the shared `RuleFormDialog` (owned by `index.tsx`).
 */
export function createColumns(
  onEdit: (rule: OpportunityRuleDto) => void,
  isAdmin: boolean
): ColumnDef<DataTableFeatures, OpportunityRuleDto>[] {
  const columns: ColumnDef<DataTableFeatures, OpportunityRuleDto>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<DataTableFeatures, OpportunityRuleDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Name' />
      ),
      cell: ({ cell }) => <span className='font-medium'>{cell.getValue<string>()}</span>
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
      id: 'priority',
      accessorKey: 'priority',
      header: ({ column }: { column: Column<DataTableFeatures, OpportunityRuleDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Priority' />
      ),
      cell: ({ cell }) => <div className='text-right tabular-nums'>{cell.getValue<number>()}</div>
    },
    {
      id: 'scoreWeight',
      accessorKey: 'scoreWeight',
      enableSorting: false,
      header: 'Score weight',
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>{cell.getValue<string>()}</span>
      )
    },
    {
      id: 'conditions',
      accessorKey: 'conditions',
      enableSorting: false,
      header: 'Condition groups',
      cell: ({ row }) => (
        <Badge variant='outline'>
          {formatQuantity(conditionGroupCount(row.original.conditions))} declared
        </Badge>
      )
    },
    {
      id: 'updatedAt',
      accessorKey: 'updatedAt',
      header: ({ column }: { column: Column<DataTableFeatures, OpportunityRuleDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Updated' />
      ),
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>{formatDateTime(cell.getValue<string>())}</span>
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
