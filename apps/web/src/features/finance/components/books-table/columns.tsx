import type { ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import type { BookListItemDto } from '@/server/books-functions';

/** Fiscal period status → tone, mirroring the dashboard Financial band's mapping. */
const PERIOD_TONE = {
  open: 'success',
  soft_closed: 'warning',
  closed: 'outline',
  locked: 'secondary'
} as const;

function periodTone(status: string) {
  return PERIOD_TONE[status as keyof typeof PERIOD_TONE] ?? 'outline';
}

export function createColumns(): ColumnDef<DataTableFeatures, BookListItemDto>[] {
  return [
    {
      id: 'code',
      accessorKey: 'code',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Code' />,
      cell: ({ row }) => (
        <Link
          to='/finance/books/$id'
          params={{ id: row.original.id }}
          className='font-medium hover:underline'
        >
          {row.original.code}
        </Link>
      )
    },
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Name' />,
      cell: ({ cell }) => <span>{cell.getValue<string>()}</span>,
      enableColumnFilter: true,
      meta: { label: 'Name', placeholder: 'Search name…', variant: 'text' as const }
    },
    {
      id: 'functionalCurrency',
      accessorKey: 'functionalCurrency',
      header: 'Currency',
      cell: ({ cell }) => <Badge variant='outline'>{cell.getValue<string>()}</Badge>
    },
    {
      id: 'activeEntityLinkCount',
      accessorKey: 'activeEntityLinkCount',
      header: () => <div className='text-right'>Entity links</div>,
      cell: ({ cell }) => (
        <div className='text-muted-foreground text-right tabular-nums'>
          {cell.getValue<number>()}
        </div>
      )
    },
    {
      id: 'currentPeriod',
      header: 'Current period',
      cell: ({ row }) => {
        const period = row.original.currentPeriod;
        if (!period) {
          return <span className='text-muted-foreground'>No period covers today</span>;
        }
        return (
          <div className='flex items-center gap-1.5'>
            <Badge variant={periodTone(period.status)}>{period.status.replace('_', ' ')}</Badge>
            <span className='text-muted-foreground text-xs'>{period.code}</span>
          </div>
        );
      }
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: 'Status',
      cell: ({ cell }) => {
        const status = cell.getValue<string>();
        return <Badge variant={status === 'active' ? 'success' : 'outline'}>{status}</Badge>;
      },
      enableColumnFilter: true,
      meta: {
        label: 'Status',
        variant: 'select' as const,
        options: [
          { value: 'active', label: 'Active' },
          { value: 'archived', label: 'Archived' }
        ]
      }
    }
  ];
}
