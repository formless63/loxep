import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { formatDateTime, formatMoney, formatQuantity } from '@/lib/format';
import {
  marketItemStateIcon,
  marketItemStateLabel,
  marketItemStateTone
} from '@/features/market/constants';
import type { MarketItemDto } from '@/server/market-functions';
import type { Option } from '@/types/data-table';

/**
 * Columns are built by a function, not a static array, because the
 * "Monitors" facet's `meta.options` come from the live `fetchMonitors()`
 * list (`../../api/queries.ts`'s `monitorsQuery`) — unlike the donor
 * reference's static `CATEGORY_OPTIONS`/`ROLE_OPTIONS`
 * (`options.tsx`), there is no fixed option set to export ahead of time.
 */
export function createColumns(monitorOptions: Option[]): ColumnDef<MarketItemDto>[] {
  return [
    {
      id: 'item',
      accessorFn: (row) => row.title ?? row.externalItemId,
      header: 'Item',
      cell: ({ row }) => (
        <div className='flex flex-col gap-0.5'>
          <Link
            to='/market/items/$itemId'
            params={{ itemId: row.original.id }}
            className='font-medium hover:underline'
          >
            {row.original.title ?? row.original.externalItemId}
          </Link>
          <span className='text-muted-foreground text-xs'>
            {row.original.provider}/{row.original.marketplace} · {row.original.externalItemId}
          </span>
        </div>
      )
    },
    {
      id: 'currentState',
      accessorKey: 'currentState',
      enableSorting: false,
      header: 'State',
      cell: ({ cell }) => {
        const state = cell.getValue<MarketItemDto['currentState']>();
        const Icon = marketItemStateIcon(state);
        return (
          <Badge variant={marketItemStateTone(state)}>
            <Icon />
            {marketItemStateLabel(state)}
          </Badge>
        );
      }
    },
    {
      id: 'price',
      accessorFn: (row) => row.latestObservation?.price ?? null,
      header: 'Price',
      cell: ({ row }) => (
        <span className='tabular-nums'>
          {formatMoney(
            row.original.latestObservation?.price ?? null,
            row.original.latestObservation?.currency ?? null
          )}
        </span>
      )
    },
    {
      id: 'availability',
      accessorFn: (row) => row.latestObservation?.availability ?? null,
      header: 'Availability',
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>{cell.getValue<string | null>() ?? '—'}</span>
      )
    },
    {
      id: 'quantity',
      accessorFn: (row) => row.latestObservation?.quantityAvailable ?? null,
      header: 'Quantity',
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatQuantity(cell.getValue<number | null>())}
        </span>
      )
    },
    {
      id: 'listingState',
      accessorFn: (row) => row.latestObservation?.listingState ?? null,
      header: 'Listing state',
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>{cell.getValue<string | null>() ?? '—'}</span>
      )
    },
    {
      id: 'lastObserved',
      accessorFn: (row) => row.latestObservation?.observedAt ?? null,
      header: ({ column }: { column: Column<MarketItemDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Last observed' />
      ),
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>
          {formatDateTime(cell.getValue<string | null>())}
        </span>
      )
    },
    {
      id: 'monitorTargetId',
      accessorFn: (row) => row.monitors.map((monitor) => monitor.name).join(', ') || null,
      header: 'Monitors',
      cell: ({ row }) =>
        row.original.monitors.length === 0 ? (
          <span className='text-muted-foreground'>—</span>
        ) : (
          <div className='flex flex-wrap gap-1'>
            {row.original.monitors.map((monitor) => (
              <Badge key={monitor.id} variant='outline'>
                {monitor.name}
              </Badge>
            ))}
          </div>
        ),
      enableColumnFilter: true,
      meta: {
        label: 'Monitor',
        variant: 'select',
        options: monitorOptions
      }
    }
  ];
}
