import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatQuantity } from '@/lib/format';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import type { PostingRuleListItemDto } from '@/server/posting-functions';

const STATUS_TONE = {
  active: 'success',
  draft: 'outline',
  disabled: 'warning'
} as const satisfies Record<string, Tone>;

function statusTone(status: string): Tone {
  return STATUS_TONE[status as keyof typeof STATUS_TONE] ?? 'outline';
}

export function getColumns(
  onView: (rule: PostingRuleListItemDto) => void
): ColumnDef<DataTableFeatures, PostingRuleListItemDto>[] {
  return [
    {
      id: 'code',
      accessorKey: 'code',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Rule' />,
      cell: ({ row }) => (
        <div className='flex flex-col'>
          <span className='font-mono text-xs'>{row.original.code}</span>
          <span className='text-sm'>{row.original.name}</span>
        </div>
      )
    },
    {
      id: 'sourceFactType',
      accessorKey: 'sourceFactType',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Fact type' />,
      cell: ({ row }) => <Badge variant='outline'>{row.original.sourceFactType}</Badge>,
      enableColumnFilter: true,
      meta: { label: 'Fact type', variant: 'multiSelect' }
    },
    {
      id: 'bookLabel',
      accessorKey: 'bookLabel',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Book' />,
      cell: ({ row }) => (
        <span className='text-muted-foreground text-sm'>{row.original.bookLabel}</span>
      )
    },
    {
      id: 'priority',
      accessorKey: 'priority',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Priority' />,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>{formatQuantity(row.original.priority)}</div>
      )
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Status' />,
      cell: ({ row }) => (
        <ToneBadge tone={statusTone(row.original.status)} className='capitalize'>
          {row.original.status}
        </ToneBadge>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Status',
        variant: 'multiSelect',
        options: [
          { value: 'active', label: 'Active' },
          { value: 'draft', label: 'Draft' },
          { value: 'disabled', label: 'Disabled' }
        ]
      }
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <div className='flex justify-end'>
          <Button size='sm' variant='outline' onClick={() => onView(row.original)}>
            View criteria
          </Button>
        </div>
      )
    }
  ];
}
