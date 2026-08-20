import type { ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDateTime, formatQuantity } from '@/lib/format';
import type { ItemAllocationDto } from '@/server/inventory-functions';
import {
  allocationKindLabel,
  allocationStatusLabel,
  allocationStatusTone
} from '@/features/inventory/constants';

export function getColumns(): ColumnDef<DataTableFeatures, ItemAllocationDto>[] {
  return [
    {
      id: 'allocationKind',
      header: 'Kind',
      cell: ({ row }) => allocationKindLabel(row.original.allocationKind)
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={allocationStatusTone(row.original.status)} className='capitalize'>
          {allocationStatusLabel(row.original.status)}
        </Badge>
      )
    },
    {
      id: 'quantity',
      header: () => <div className='text-right'>Quantity</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatQuantity(Number(row.original.quantity))}
        </div>
      )
    },
    {
      id: 'order',
      header: 'Order',
      cell: ({ row }) => {
        const { orderId, orderExternalNumber } = row.original;
        if (orderId === null) return <span className='text-muted-foreground'>—</span>;
        return (
          <Link to='/commerce/orders/$id' params={{ id: orderId }} className='hover:underline'>
            {orderExternalNumber ?? orderId}
          </Link>
        );
      }
    },
    {
      id: 'allocatedAt',
      header: 'Allocated',
      cell: ({ row }) => (
        <span className='text-muted-foreground text-xs tabular-nums'>
          {formatDateTime(row.original.allocatedAt)}
        </span>
      )
    },
    {
      id: 'expiresAt',
      header: 'Expires',
      cell: ({ row }) => (
        <span className='text-muted-foreground text-xs tabular-nums'>
          {formatDateTime(row.original.expiresAt)}
        </span>
      )
    },
    {
      id: 'resolution',
      header: 'Resolved',
      cell: ({ row }) => {
        const { status, fulfilledAt, releasedAt, releaseReason } = row.original;
        if (status === 'reserved') return <span className='text-muted-foreground'>—</span>;
        if (fulfilledAt !== null) {
          return (
            <span className='text-muted-foreground text-xs tabular-nums'>
              Fulfilled {formatDateTime(fulfilledAt)}
            </span>
          );
        }
        if (releasedAt !== null) {
          return (
            <span
              className='text-muted-foreground text-xs tabular-nums'
              title={releaseReason ?? undefined}
            >
              {allocationStatusLabel(status)} {formatDateTime(releasedAt)}
              {releaseReason ? ` (${releaseReason})` : ''}
            </span>
          );
        }
        return <span className='text-muted-foreground'>—</span>;
      }
    }
  ];
}
