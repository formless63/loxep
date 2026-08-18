import * as React from 'react';
import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDateTime, formatQuantity } from '@/lib/format';
import type { InventoryMovementListItemDto } from '@/server/inventory-functions';
import { movementIsInbound, movementKindLabel } from '@/features/inventory/constants';
import { ReverseMovementDialog } from '@/features/inventory/components/movement-dialogs';

/**
 * A8 (loxep-wx3) — "Reverse", the only correction path for an append-only
 * ledger row. Self-contained (owns its own confirm-dialog state), matching
 * `items-table/columns.tsx`'s `CompleteReviewCell` precedent for a row
 * action that needs no state lifted to the table wrapper.
 */
function ReverseActionCell({ movement }: { movement: InventoryMovementListItemDto }) {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <>
      <Button
        variant='ghost'
        size='icon'
        className='size-8'
        aria-label={`Reverse movement ${movement.id}`}
        onClick={() => setConfirming(true)}
      >
        <Icons.undo />
      </Button>
      <ReverseMovementDialog open={confirming} onOpenChange={setConfirming} movement={movement} />
    </>
  );
}

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
    id: 'source',
    enableSorting: false,
    header: 'Source',
    // Provenance the row actually carries (loxep-1zg): only `acquisitionId`
    // links out (the other FKs — order line, allocation, shipment, reversed
    // movement — have no independently browsable detail page yet), so those
    // render as a labeled, titled identifier instead of a fabricated link.
    cell: ({ row }) => {
      const movement = row.original;
      if (movement.acquisitionId) {
        return (
          <Link
            to='/inventory/acquisitions/$id'
            params={{ id: movement.acquisitionId }}
            className='text-xs hover:underline'
          >
            lot
          </Link>
        );
      }
      if (movement.orderLineId) {
        return (
          <span
            className='text-muted-foreground text-xs'
            title={`order_line_id ${movement.orderLineId}`}
          >
            order line
          </span>
        );
      }
      if (movement.shipmentId) {
        return (
          <span
            className='text-muted-foreground text-xs'
            title={`shipment_id ${movement.shipmentId}`}
          >
            shipment
          </span>
        );
      }
      if (movement.reversesMovementId) {
        return (
          <span
            className='text-muted-foreground text-xs'
            title={`reverses movement ${movement.reversesMovementId}`}
          >
            reversal
          </span>
        );
      }
      return <span className='text-muted-foreground'>—</span>;
    }
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
  },
  {
    id: 'actions',
    enableSorting: false,
    header: '',
    cell: ({ row }) => <ReverseActionCell movement={row.original} />
  }
];

export const columnIds = columns.map((column) => column.id).filter(Boolean) as string[];
