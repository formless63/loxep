/**
 * Biggest price movers — the last two priced observations per watched item,
 * ranked by absolute change (`biggestPriceMovers`, `@loxep/market`).
 *
 * A fixed top-five widget embedded in the dashboard, not a paginated table:
 * it follows `RecentEventsList`'s precedent exactly — a plain `useTable`
 * instance with `manualPagination` rather than `useDataTable`, because there
 * is no page/sort/filter state that belongs in the URL for a bounded top-N
 * list. It is still a `DataTable`, never bare `<Table>` markup.
 */
import type { Column, ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
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
import { dataTableFeatures, type DataTableFeatures } from '@/lib/table-features';
import { formatMoney, formatPercent, formatRelativeTime, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { priceMoveClassName, priceMoveIcon } from '@/features/dashboard/constants';
import type { DashboardPriceMoverDto } from '@/server/dashboard-functions';

const columns: ColumnDef<DataTableFeatures, DashboardPriceMoverDto>[] = [
  {
    id: 'item',
    accessorFn: (row) => row.title ?? row.marketplaceItemId,
    header: 'Item',
    cell: ({ row }) => (
      <Link
        to='/market/items/$itemId'
        params={{ itemId: row.original.marketplaceItemId }}
        className='line-clamp-1 font-medium hover:underline'
      >
        {row.original.title ?? row.original.marketplaceItemId}
      </Link>
    )
  },
  {
    id: 'price',
    accessorKey: 'latestPrice',
    enableSorting: false,
    header: () => <div className='text-right'>Price</div>,
    cell: ({ row }) => (
      <div className='text-right tabular-nums'>
        <span className='font-medium'>
          {formatMoney(row.original.latestPrice, row.original.currency)}
        </span>
        <span className='block text-xs text-muted-foreground line-through'>
          {formatMoney(row.original.previousPrice, row.original.currency)}
        </span>
      </div>
    )
  },
  {
    id: 'priceChangePct',
    accessorKey: 'priceChangePct',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, DashboardPriceMoverDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Move' />,
    cell: ({ row }) => {
      const pct = row.original.priceChangePct;
      const MoveIcon = priceMoveIcon(pct);
      return (
        <Badge
          variant='ghost'
          className={cn('tabular-nums', priceMoveClassName(pct))}
          title={`From ${row.original.previousPrice} to ${row.original.latestPrice}`}
        >
          <MoveIcon />
          {formatPercent(pct)}
        </Badge>
      );
    }
  },
  {
    id: 'observedAt',
    accessorKey: 'observedAt',
    enableSorting: false,
    header: 'Seen',
    cell: ({ cell }) => {
      const value = cell.getValue<string>();
      return (
        <span className='text-xs text-muted-foreground' title={formatDateTime(value)}>
          {formatRelativeTime(value)}
        </span>
      );
    }
  }
];

export default function MoversList({
  movers,
  windowHours
}: {
  movers: DashboardPriceMoverDto[];
  windowHours: number;
}) {
  // No `initialState.sorting`: the rows arrive already ranked by ABSOLUTE
  // percent change, which is what "biggest movers" means. Seeding a signed
  // descending sort would push a −60% crash below a +2% drift and quietly
  // undo the server's ranking. The column stays sortable for a reader who
  // does want the signed order.
  const table = useTable({
    data: movers,
    columns,
    features: dataTableFeatures,
    manualPagination: true
  });

  if (movers.length === 0) {
    return (
      <Empty className='p-0'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.adjustments />
          </EmptyMedia>
          <EmptyTitle>No price moves yet</EmptyTitle>
          <EmptyDescription>
            A move needs two priced observations of the same item within the last {windowHours / 24}{' '}
            days. Nothing watched has changed price in that window.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <DataTable table={table} />;
}
