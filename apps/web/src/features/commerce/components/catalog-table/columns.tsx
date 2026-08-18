import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDate, formatMoney } from '@/lib/format';
import type { CatalogItemListItemDto } from '@/server/commerce-functions';
import { CellAction } from './cell-action';

export function createColumns(
  onEdit: (item: CatalogItemListItemDto) => void
): ColumnDef<DataTableFeatures, CatalogItemListItemDto>[] {
  return [
    {
      id: 'sku',
      accessorKey: 'sku',
      header: 'SKU',
      cell: ({ cell }) => <span className='font-medium'>{cell.getValue<string>()}</span>,
      enableColumnFilter: true,
      meta: { label: 'SKU', placeholder: 'Search SKU…', variant: 'text' as const }
    },
    {
      id: 'name',
      accessorKey: 'name',
      enableSorting: false,
      header: 'Name',
      cell: ({ cell }) => <span className='text-muted-foreground'>{cell.getValue<string>()}</span>
    },
    {
      id: 'kind',
      accessorKey: 'kind',
      enableSorting: false,
      header: 'Kind',
      cell: ({ cell }) => <Badge variant='outline'>{cell.getValue<string>()}</Badge>
    },
    {
      id: 'status',
      accessorKey: 'status',
      enableSorting: false,
      header: 'Status',
      cell: ({ cell }) => <Badge variant='secondary'>{cell.getValue<string>()}</Badge>
    },
    {
      id: 'defaultPrice',
      accessorKey: 'defaultPrice',
      header: 'Default price',
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {row.original.defaultPrice
            ? formatMoney(row.original.defaultPrice, row.original.defaultCurrency ?? 'USD')
            : '—'}
        </div>
      )
    },
    {
      id: 'createdAt',
      accessorKey: 'createdAt',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, CatalogItemListItemDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Created' />,
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatDate(cell.getValue<string>())}
        </span>
      )
    },
    {
      id: 'actions',
      cell: ({ row }) => <CellAction data={row.original} onEdit={onEdit} />
    }
  ];
}
