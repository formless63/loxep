import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { monitorsQuery, searchDashboardQuery } from '@/features/market/api/queries';
import { monitorTargetTypeLabel } from '@/features/market/constants';
import type { MonitorDto } from '@/server/market-functions';

function formatTimestamp(value: string | null): string {
  return value ? format(new Date(value), 'yyyy-MM-dd HH:mm') : '—';
}

/**
 * Per-monitor discovery stats — reuses `fetchMonitors` (the same data
 * `/market/monitors` shows) filtered to `ebay_search`/`ebay_seller`, joined
 * with `fetchSearchDashboard`'s per-monitor discovered-item counts and
 * recent `new_listing` activity (loxep-7dp.6).
 */
function DiscoveryMonitorsTable({ monitors }: { monitors: MonitorDto[] }) {
  const { data, isPending } = useQuery(searchDashboardQuery);
  const statsByMonitor = new Map(
    (data?.monitorStats ?? []).map((row) => [row.monitorTargetId, row])
  );

  if (isPending) {
    return <Skeleton className='h-48 w-full' />;
  }

  if (monitors.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No search or seller monitors</EmptyTitle>
          <EmptyDescription>
            Create an eBay search or seller monitor from /market/monitors to start discovering new
            listings.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className='overflow-x-auto'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Discovered items</TableHead>
            <TableHead>New listings (24h)</TableHead>
            <TableHead>Last new listing</TableHead>
            <TableHead>Next poll</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {monitors.map((monitor) => {
            const stats = statsByMonitor.get(monitor.id);
            return (
              <TableRow key={monitor.id}>
                <TableCell className='font-medium'>{monitor.name}</TableCell>
                <TableCell>
                  <Badge variant='outline'>{monitorTargetTypeLabel(monitor.targetType)}</Badge>
                </TableCell>
                <TableCell className='text-muted-foreground'>
                  {stats?.discoveredItemCount ?? 0}
                </TableCell>
                <TableCell className='text-muted-foreground'>
                  {stats?.newListingCount24h ?? 0}
                </TableCell>
                <TableCell className='text-muted-foreground'>
                  {formatTimestamp(stats?.lastNewListingAt ?? null)}
                </TableCell>
                <TableCell className='text-muted-foreground'>
                  {formatTimestamp(monitor.nextPollAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function RecentNewListings() {
  const { data, isPending } = useQuery(searchDashboardQuery);
  const events = data?.recentNewListings ?? [];

  if (isPending) {
    return <Skeleton className='h-48 w-full' />;
  }

  if (events.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No new listings yet</EmptyTitle>
          <EmptyDescription>
            `new_listing` events fire when a search or seller monitor discovers an item Loxep has
            never seen before.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className='flex flex-col'>
      {events.map((event) => (
        <div
          key={event.id}
          className='flex flex-wrap items-center gap-2 border-b py-3 last:border-b-0'
        >
          <Link
            to='/market/items/$itemId'
            params={{ itemId: event.marketplaceItemId }}
            className='font-medium hover:underline'
          >
            {event.itemTitle ?? event.marketplaceItemId}
          </Link>
          {event.itemCanonicalUrl && (
            <a
              href={event.itemCanonicalUrl}
              target='_blank'
              rel='noreferrer'
              className='text-muted-foreground text-xs hover:underline'
            >
              View on eBay ↗
            </a>
          )}
          {event.monitorTargetName && (
            <span className='text-muted-foreground text-xs'>via {event.monitorTargetName}</span>
          )}
          <span className='text-muted-foreground ml-auto text-xs'>
            {formatTimestamp(event.detectedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

const DISCOVERY_TARGET_TYPES = new Set(['ebay_search', 'ebay_seller']);

export default function SearchDashboard() {
  const { data: allMonitors, isPending } = useQuery(monitorsQuery);
  const discoveryMonitors = (allMonitors ?? []).filter((monitor) =>
    DISCOVERY_TARGET_TYPES.has(monitor.targetType)
  );

  return (
    <div className='flex flex-col gap-6'>
      <div className='flex flex-col gap-2'>
        <h2 className='text-lg font-semibold'>Search and seller monitors</h2>
        {isPending ? (
          <Skeleton className='h-48 w-full' />
        ) : (
          <DiscoveryMonitorsTable monitors={discoveryMonitors} />
        )}
      </div>
      <div className='flex flex-col gap-2'>
        <h2 className='text-lg font-semibold'>Recent new listings</h2>
        <RecentNewListings />
      </div>
    </div>
  );
}
