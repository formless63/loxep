import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDateTime, formatMoney } from '@/lib/format';
import type { OrderListItemDto } from '@/server/orders-functions';
import {
  orderPaymentStatusLabel,
  orderPaymentStatusTone,
  orderProviderOptions,
  orderStatusLabel,
  orderStatusOptions,
  orderStatusTone,
  providerLabel
} from '@/features/commerce/constants';

export function createColumns(): ColumnDef<DataTableFeatures, OrderListItemDto>[] {
  return [
    {
      id: 'order',
      accessorKey: 'externalOrderNumber',
      enableSorting: false,
      header: 'Order',
      cell: ({ row }) => (
        <Link
          to='/commerce/orders/$id'
          params={{ id: row.original.id }}
          className='font-medium hover:underline'
        >
          {row.original.externalOrderNumber ?? row.original.externalOrderId}
        </Link>
      )
    },
    {
      id: 'provider',
      accessorKey: 'provider',
      enableSorting: false,
      header: 'Source',
      cell: ({ row }) => (
        <Badge variant={row.original.isManual ? 'outline' : 'secondary'} className='gap-1'>
          {row.original.isManual ? <Icons.user /> : <Icons.integrations />}
          {row.original.isManual ? 'Manual' : providerLabel(row.original.provider)}
        </Badge>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Source',
        variant: 'select' as const,
        options: orderProviderOptions
      }
    },
    {
      id: 'channel',
      accessorKey: 'channel',
      enableSorting: false,
      header: 'Channel',
      cell: ({ cell }) => <span className='text-muted-foreground'>{cell.getValue<string>()}</span>
    },
    {
      id: 'status',
      accessorKey: 'status',
      enableSorting: false,
      header: 'Status',
      cell: ({ cell }) => {
        const status = cell.getValue<string>();
        return <Badge variant={orderStatusTone(status)}>{orderStatusLabel(status)}</Badge>;
      },
      enableColumnFilter: true,
      meta: {
        label: 'Status',
        variant: 'select' as const,
        options: orderStatusOptions
      }
    },
    {
      id: 'paymentStatus',
      accessorKey: 'paymentStatus',
      enableSorting: false,
      header: 'Payment',
      cell: ({ cell }) => {
        const status = cell.getValue<string>();
        return (
          <Badge variant={orderPaymentStatusTone(status)}>{orderPaymentStatusLabel(status)}</Badge>
        );
      }
    },
    {
      id: 'placedAt',
      accessorKey: 'placedAt',
      header: ({ column }: { column: Column<DataTableFeatures, OrderListItemDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Placed' />
      ),
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatDateTime(cell.getValue<string>())}
        </span>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Placed',
        variant: 'dateRange' as const
      }
    },
    {
      id: 'totalAmount',
      accessorKey: 'totalAmount',
      header: ({ column }: { column: Column<DataTableFeatures, OrderListItemDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Total' />
      ),
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.totalAmount, row.original.currency)}
        </div>
      )
    }
  ];
}
