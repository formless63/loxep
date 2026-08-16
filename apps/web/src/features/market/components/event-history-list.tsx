import type { Column, ColumnDef } from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatTimestampPrecise } from '@/lib/format';
import { parseSortingState } from '@/lib/parsers';
import { itemEventsQuery } from '@/features/market/api/queries';
import { marketEventTypeIcon, marketEventTypeTone } from '@/features/market/constants';
import { marketEventTypeLabel } from '@/features/settings/constants';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { MarketEventDto, MarketEventsPageDto } from '@/server/market-functions';

/**
 * Renders a `market_events.payload` object as a compact key/value spec
 * sheet — legitimately a plain `<Table>` (not `DataTable`), per Frontend
 * Standards' "Non-data uses of `<Table>`": there is nothing here a user
 * sorts, filters, or pages.
 */
function PayloadDeltas({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) return <span className='text-muted-foreground text-xs'>—</span>;
  return (
    <Table className='text-xs'>
      <TableBody>
        {entries.map(([key, value]) => (
          <TableRow key={key} className='hover:bg-transparent'>
            <TableCell className='text-muted-foreground py-1 pr-2 font-medium'>{key}</TableCell>
            <TableCell className='py-1'>{value === null ? 'null' : String(value)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const columns: ColumnDef<DataTableFeatures, MarketEventDto>[] = [
  {
    id: 'eventType',
    accessorKey: 'eventType',
    enableSorting: false,
    header: 'Event',
    cell: ({ cell }) => {
      const eventType = cell.getValue<MarketEventDto['eventType']>();
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
    id: 'rule',
    accessorFn: (row) => row.ruleName ?? row.ruleId ?? null,
    enableSorting: false,
    header: 'Rule',
    cell: ({ cell }) => {
      const value = cell.getValue<string | null>();
      return value ? (
        <Badge variant='secondary'>rule: {value}</Badge>
      ) : (
        <span className='text-muted-foreground'>—</span>
      );
    }
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
    header: ({ column }: { column: Column<DataTableFeatures, MarketEventDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Detected' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>
        {formatTimestampPrecise(cell.getValue<string>())}
      </span>
    )
  },
  {
    id: 'payload',
    accessorKey: 'payload',
    enableSorting: false,
    header: 'Changes',
    cell: ({ cell }) => <PayloadDeltas payload={cell.getValue<Record<string, unknown>>()} />
  }
];

const columnIds = columns.map((c) => c.id).filter(Boolean) as string[];

/**
 * Event history for one item: type, detected-at, payload deltas, rule badge
 * (loxep-62y.4.3). `detectedAt` is the only sortable column
 * (`@loxep/market`'s `ITEM_EVENTS_SORT_KEYS`); `sort` is read from the URL
 * here, before the query fires, so ordering is server-truthful over the
 * full per-item event history (loxep-foi.7).
 */
export default function EventHistoryList({ marketplaceItemId }: { marketplaceItemId: string }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const serverPage = Math.max(0, page - 1);
  const [sort] = parseSortingState<MarketEventDto>(search.sort as string | undefined, columnIds);
  const sortDir = sort?.id === 'detectedAt' ? (sort.desc ? 'desc' : 'asc') : undefined;

  const { data, isPending, isError, error, refetch } = useQuery(
    itemEventsQuery(marketplaceItemId, serverPage, sortDir)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Event history</CardTitle>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <DataTableSkeleton columnCount={columns.length} filterCount={0} />
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load event history'
            onRetry={() => refetch()}
          />
        ) : data.total === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.clock />
              </EmptyMedia>
              <EmptyTitle>No events yet</EmptyTitle>
              <EmptyDescription>
                Events are derived interpretations of change between observations — they appear once
                this item has been observed more than once.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <EventHistoryDataTable data={data} />
        )}
      </CardContent>
    </Card>
  );
}

function EventHistoryDataTable({ data }: { data: MarketEventsPageDto }) {
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  const { table } = useDataTable({
    data: data.events,
    columns,
    pageCount,
    getRowId: (event) => event.id,
    shallow: true,
    debounceMs: 500,
    initialState: { pagination: { pageIndex: 0, pageSize: data.pageSize } }
  });

  return <DataTable table={table} />;
}
