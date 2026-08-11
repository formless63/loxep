import { Link } from '@tanstack/react-router';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { marketEventTypeLabel } from '@/features/settings/constants';
import type { MarketEventSummaryDto } from '@/server/market-functions';

/** Recent market events for the overview page, linking each row to its item. */
export default function RecentEventsList({ events }: { events: MarketEventSummaryDto[] }) {
  if (events.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No recent events</EmptyTitle>
          <EmptyDescription>
            Events are derived interpretations of change between observations — nothing has been
            detected yet.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className='flex flex-col'>
      {events.map((event) => (
        <Link
          key={event.id}
          to='/market/items/$itemId'
          params={{ itemId: event.marketplaceItemId }}
          className='flex flex-wrap items-center gap-2 border-b py-3 last:border-b-0 hover:bg-muted/50'
        >
          <Badge variant='outline'>{marketEventTypeLabel(event.eventType)}</Badge>
          <span className='font-medium'>{event.itemTitle ?? event.marketplaceItemId}</span>
          {event.monitorTargetName && (
            <span className='text-muted-foreground text-xs'>via {event.monitorTargetName}</span>
          )}
          <span className='text-muted-foreground ml-auto text-xs'>
            {format(new Date(event.detectedAt), 'yyyy-MM-dd HH:mm:ss')}
          </span>
        </Link>
      ))}
    </div>
  );
}
