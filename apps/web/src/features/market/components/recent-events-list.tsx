import type { Column, ColumnDef } from '@tanstack/react-table';
import { getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { formatTimestampPrecise } from '@/lib/format';
import { marketEventTypeLabel } from '@/features/settings/constants';
import { marketEventTypeIcon, marketEventTypeTone } from '@/features/market/constants';
import type { MarketEventSummaryDto } from '@/server/market-functions';

const columns: ColumnDef<MarketEventSummaryDto>[] = [
  {
    id: 'eventType',
    accessorKey: 'eventType',
    enableSorting: false,
    header: 'Event',
    cell: ({ cell }) => {
      const eventType = cell.getValue<MarketEventSummaryDto['eventType']>();
      const Icon = marketEventTypeIcon(eventType);
      return (
        <Badge variant={marketEventTypeTone(eventType)}>
          <Icon />
          {marketEventTypeLabel(eventType)}
        </Badge>
      );
    }
  },
  {
    id: 'item',
    accessorFn: (row) => row.itemTitle ?? row.marketplaceItemId,
    header: 'Item',
    cell: ({ row }) => (
      <Link
        to='/market/items/$itemId'
        params={{ itemId: row.original.marketplaceItemId }}
        className='font-medium hover:underline'
      >
        {row.original.itemTitle ?? row.original.marketplaceItemId}
      </Link>
    )
  },
  {
    id: 'monitor',
    accessorFn: (row) => row.monitorTargetName ?? '—',
    enableSorting: false,
    header: 'Via monitor',
    cell: ({ cell }) => (
      <span className='text-muted-foreground text-xs'>{cell.getValue<string>()}</span>
    )
  },
  {
    id: 'detectedAt',
    accessorKey: 'detectedAt',
    header: ({ column }: { column: Column<MarketEventSummaryDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Detected' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>
        {formatTimestampPrecise(cell.getValue<string>())}
      </span>
    )
  }
];

/**
 * Recent market events for the overview page, linking each row to its item.
 * `events` is a bounded top-N prop from `fetchMarketOverview`
 * (`RECENT_EVENTS_LIMIT`, `@/server/market-functions`), not a paginated
 * query of its own, so this uses a plain (non-URL-synced) `useReactTable`
 * instance rather than `useDataTable` — there is no page/filter state
 * belonging in the URL for a fixed "last 10" widget embedded in the
 * overview page (owned separately, outside this pass's fence).
 */
export default function RecentEventsList({ events }: { events: MarketEventSummaryDto[] }) {
  const table = useReactTable({
    data: events,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  if (events.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.notification />
          </EmptyMedia>
          <EmptyTitle>No recent events</EmptyTitle>
          <EmptyDescription>
            Events are derived interpretations of change between observations — nothing has been
            detected yet.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <DataTable table={table} />;
}
