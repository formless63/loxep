import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { itemEventsQuery } from '@/features/market/api/queries';
import { marketEventTypeLabel } from '@/features/settings/constants';
import type { MarketEventDto } from '@/server/market-functions';

/** Renders a `market_events.payload` object as compact `key: from → to` deltas. */
function PayloadDeltas({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) return null;
  return (
    <dl className='flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'>
      {entries.map(([key, value]) => (
        <div key={key} className='flex gap-1'>
          <dt className='font-medium'>{key}:</dt>
          <dd>{value === null ? 'null' : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function EventRow({ event }: { event: MarketEventDto }) {
  return (
    <div className='flex flex-col gap-1 border-b py-3 last:border-b-0'>
      <div className='flex flex-wrap items-center gap-2'>
        <Badge variant='outline'>{marketEventTypeLabel(event.eventType)}</Badge>
        <span className='text-muted-foreground text-sm'>
          {format(new Date(event.detectedAt), 'yyyy-MM-dd HH:mm:ss')}
        </span>
        {event.ruleId && <Badge variant='secondary'>rule: {event.ruleName ?? event.ruleId}</Badge>}
        {event.monitorTargetName && (
          <span className='text-muted-foreground text-xs'>via {event.monitorTargetName}</span>
        )}
      </div>
      <PayloadDeltas payload={event.payload} />
    </div>
  );
}

/** Event history for one item: type, detected-at, payload deltas, rule badge (loxep-62y.4.3). */
export default function EventHistoryList({ marketplaceItemId }: { marketplaceItemId: string }) {
  const [page, setPage] = React.useState(0);
  const { data, isPending } = useQuery(itemEventsQuery(marketplaceItemId, page));

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 25;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Card>
      <CardHeader>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <CardTitle className='text-base'>Event history</CardTitle>
          {total > 0 && (
            <div className='flex items-center gap-2'>
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
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className='h-48 w-full' />
        ) : events.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No events yet</EmptyTitle>
              <EmptyDescription>
                Events are derived interpretations of change between observations — they appear once
                this item has been observed more than once.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className='flex flex-col'>
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
