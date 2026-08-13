import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDateTime, formatQuantity } from '@/lib/format';
import type { InventoryMovementListItemDto } from '@/server/inventory-functions';
import { movementIsInbound, movementKindLabel } from '@/features/inventory/constants';

export const columns: ColumnDef<DataTableFeatures, InventoryMovementListItemDto>[] = [
  {
    id: 'itemCode',
    accessorKey: 'itemCode',
    enableSorting: false,
    header: 'Item',
    cell: ({ row }) => (
      <Link
        to='/inventory/stock/$id'
        params={{ id: row.original.inventoryItemId }}
        className='font-medium hover:underline'
      >
        {row.original.itemCode}
      </Link>
    )
  },
  {
    id: 'movementKind',
    accessorKey: 'movementKind',
    enableSorting: false,
    header: 'Kind',
    cell: ({ cell }) => {
      const kind = cell.getValue<string>();
      return (
        <Badge variant={movementIsInbound(kind) ? 'success' : 'outline'}>
          {movementKindLabel(kind)}
        </Badge>
      );
    }
  },
  {
    id: 'quantity',
    accessorKey: 'quantity',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, InventoryMovementListItemDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Quantity' />,
    cell: ({ cell }) => (
      <div className='text-right tabular-nums'>
        {formatQuantity(Number(cell.getValue<string>()))}
      </div>
    )
  },
  {
    id: 'locationCode',
    accessorKey: 'locationCode',
    enableSorting: false,
    header: 'Location',
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>{cell.getValue<string | null>() ?? '—'}</span>
    )
  },
  {
    id: 'reasonCode',
    accessorKey: 'reasonCode',
    enableSorting: false,
    header: 'Reason',
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>{cell.getValue<string | null>() ?? '—'}</span>
    )
  },
  {
    id: 'occurredAt',
    accessorKey: 'occurredAt',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, InventoryMovementListItemDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Occurred' />,
    cell: ({ cell }) => (
      <span className='text-muted-foreground tabular-nums'>
        {formatDateTime(cell.getValue<string>())}
      </span>
    )
  }
];

export const columnIds = columns.map((column) => column.id).filter(Boolean) as string[];
