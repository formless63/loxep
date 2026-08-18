import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDate, formatDateTime, formatMoney, formatRelativeTime } from '@/lib/format';
import type { ChannelListingListItemDto } from '@/server/commerce-functions';
import {
  channelListingStatusLabel,
  channelListingStatusOptions,
  channelListingStatusTone,
  manualListingChannelLabel,
  providerLabel
} from '@/features/commerce/constants';

export function createColumns(): ColumnDef<DataTableFeatures, ChannelListingListItemDto>[] {
  return [
    {
      id: 'listingCode',
      accessorKey: 'listingCode',
      header: 'Listing',
      cell: ({ row }) => (
        <Link
          to='/commerce/listings/$id'
          params={{ id: row.original.id }}
          className='font-medium hover:underline'
        >
          {row.original.listingCode}
        </Link>
      )
    },
    {
      id: 'catalogItemName',
      accessorKey: 'catalogItemName',
      enableSorting: false,
      header: 'Item',
      cell: ({ row }) => (
        <div className='flex flex-col'>
          <span>{row.original.listingTitle ?? row.original.catalogItemName}</span>
          <span className='text-muted-foreground text-xs'>{row.original.catalogItemSku}</span>
        </div>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Item',
        placeholder: 'Search title or SKU…',
        variant: 'text' as const
      }
    },
    {
      id: 'provider',
      accessorKey: 'provider',
      enableSorting: false,
      header: 'Provider',
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>{providerLabel(cell.getValue<string>())}</span>
      )
    },
    {
      id: 'channel',
      accessorKey: 'channel',
      enableSorting: false,
      header: 'Channel',
      cell: ({ cell }) => manualListingChannelLabel(cell.getValue<string>())
    },
    {
      id: 'status',
      accessorKey: 'status',
      enableSorting: false,
      header: 'Status',
      cell: ({ cell }) => {
        const status = cell.getValue<string>();
        return (
          <Badge variant={channelListingStatusTone(status)}>
            {channelListingStatusLabel(status)}
          </Badge>
        );
      },
      enableColumnFilter: true,
      meta: {
        label: 'Status',
        variant: 'select' as const,
        options: channelListingStatusOptions
      }
    },
    {
      id: 'price',
      accessorKey: 'price',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, ChannelListingListItemDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Price' />,
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {row.original.price
            ? formatMoney(row.original.price, row.original.currency ?? 'USD')
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
        column: Column<DataTableFeatures, ChannelListingListItemDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Created' />,
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatDate(cell.getValue<string>())}
        </span>
      )
    },
    {
      id: 'lastSyncedAt',
      accessorKey: 'lastSyncedAt',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, ChannelListingListItemDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Synced' />,
      cell: ({ cell }) => {
        const value = cell.getValue<string>();
        return (
          <span className='text-muted-foreground tabular-nums' title={formatDateTime(value)}>
            {formatRelativeTime(value)}
          </span>
        );
      }
    }
  ];
}
