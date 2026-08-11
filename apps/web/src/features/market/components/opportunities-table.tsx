import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { marketEventTypeLabel } from '@/features/settings/constants';
import { opportunityEventsQuery } from '@/features/market/api/queries';

function formatTimestamp(value: string): string {
  return format(new Date(value), 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Recent rule-stamped events (`market_events` where `rule_id IS NOT NULL`) —
 * loxep-7dp.6's opportunities dashboard, reading `fetchOpportunityEvents`
 * (`@/server/market-functions`). Score comes from `payload.opportunity`,
 * the block `stampEventWithRule` (`@loxep/market/opportunities.ts`) writes.
 */
export default function OpportunitiesTable() {
  const [page, setPage] = React.useState(0);
  const { data, isPending } = useQuery(opportunityEventsQuery(page));

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 25;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  if (events.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No opportunities yet</EmptyTitle>
          <EmptyDescription>
            An event is stamped with a rule (and scored) when it matches an enabled opportunity
            rule&apos;s conditions. Nothing has matched yet.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex items-center justify-end gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={page === 0}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          Previous
        </Button>
        <span className='text-muted-foreground text-sm'>
          Page {page + 1} of {pageCount}
        </span>
        <Button
          size='sm'
          variant='outline'
          disabled={page + 1 >= pageCount}
          onClick={() => setPage((current) => current + 1)}
        >
          Next
        </Button>
      </div>
      <div className='overflow-x-auto'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Reasons</TableHead>
              <TableHead>Detected</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow key={event.id}>
                <TableCell>
                  <div className='flex flex-col gap-0.5'>
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
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant='outline'>{marketEventTypeLabel(event.eventType)}</Badge>
                </TableCell>
                <TableCell className='text-muted-foreground'>{event.ruleName}</TableCell>
                <TableCell className='font-medium'>{event.score.toFixed(4)}</TableCell>
                <TableCell className='text-muted-foreground text-xs'>
                  {event.reasons.length > 0 ? event.reasons.join(', ') : '—'}
                </TableCell>
                <TableCell className='text-muted-foreground'>
                  {formatTimestamp(event.detectedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
