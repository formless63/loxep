import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Icons } from '@/components/icons';
import { itemActivitySummaryQuery } from '@/features/market/api/queries';
import { marketEventTypeLabel } from '@/features/settings/constants';
import { formatDateTime, formatMoney, formatPercent } from '@/lib/format';
import type { MarketItemDetailDto } from '@/server/market-functions';

/** Current-state card: item identity, latest observation, and 7-day activity summary. */
export default function ItemStateCard({ item }: { item: MarketItemDetailDto }) {
  const { data: activity } = useQuery(itemActivitySummaryQuery(item.id));
  const observation = item.latestObservation;

  return (
    <Card>
      <CardHeader>
        <div className='flex flex-wrap items-start justify-between gap-2'>
          <div>
            <CardTitle className='text-xl'>{item.title ?? item.externalItemId}</CardTitle>
            <CardDescription>
              {item.provider}/{item.marketplace} · {item.externalItemId}
            </CardDescription>
          </div>
          <Badge variant='outline'>{item.currentState}</Badge>
        </div>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        <div className='grid grid-cols-2 gap-4 text-sm md:grid-cols-4'>
          <div>
            <CardDescription>Price</CardDescription>
            <CardTitle className='text-base tabular-nums'>
              {formatMoney(observation?.price ?? null, observation?.currency ?? null)}
            </CardTitle>
          </div>
          <div>
            <CardDescription>Availability</CardDescription>
            <CardTitle className='text-base tabular-nums'>
              {observation?.availability ?? '—'}
            </CardTitle>
          </div>
          <div>
            <CardDescription>Quantity available</CardDescription>
            <CardTitle className='text-base tabular-nums'>
              {observation?.quantityAvailable ?? '—'}
            </CardTitle>
          </div>
          <div>
            <CardDescription>Listing state</CardDescription>
            <CardTitle className='text-base tabular-nums'>
              {observation?.listingState ?? '—'}
            </CardTitle>
          </div>
          <div>
            <CardDescription>Last observed</CardDescription>
            <CardTitle className='text-base tabular-nums'>
              {formatDateTime(observation?.observedAt ?? null)}
            </CardTitle>
          </div>
          <div>
            <CardDescription>Condition</CardDescription>
            <CardTitle className='text-base tabular-nums'>{item.conditionCode ?? '—'}</CardTitle>
          </div>
          <div>
            <CardDescription>Listing type</CardDescription>
            <CardTitle className='text-base tabular-nums'>{item.listingType ?? '—'}</CardTitle>
          </div>
          <div>
            <CardDescription>Listing ends</CardDescription>
            <CardTitle className='text-base tabular-nums'>
              {formatDateTime(item.listingEndsAt)}
            </CardTitle>
          </div>
        </div>

        {item.monitors.length > 0 && (
          <div className='flex flex-wrap items-center gap-2 text-sm'>
            <span className='text-muted-foreground'>Linked monitors</span>
            {item.monitors.map((monitor) => (
              <Badge key={monitor.id} variant='outline'>
                {monitor.name}
              </Badge>
            ))}
          </div>
        )}

        {activity && (
          <div className='flex flex-wrap items-center gap-4 border-t pt-4 text-sm'>
            <span className='text-muted-foreground'>Last 7 days</span>
            {Object.entries(activity.eventCounts)
              .filter(([, count]) => count > 0)
              .map(([type, count]) => (
                <div key={type} className='flex items-center gap-1'>
                  <Badge variant='outline'>{marketEventTypeLabel(type)}</Badge>
                  <span>{count}</span>
                </div>
              ))}
            {activity.priceChangePct !== null && (
              <div className='flex items-center gap-1'>
                <span className='text-muted-foreground'>Price change</span>
                <span
                  className={
                    activity.priceChangePct < 0
                      ? 'flex items-center gap-0.5 text-destructive tabular-nums'
                      : activity.priceChangePct > 0
                        ? 'flex items-center gap-0.5 text-success tabular-nums'
                        : 'tabular-nums'
                  }
                >
                  {activity.priceChangePct < 0 ? (
                    <Icons.trendingDown className='size-3.5' />
                  ) : activity.priceChangePct > 0 ? (
                    <Icons.trendingUp className='size-3.5' />
                  ) : null}
                  {formatPercent(activity.priceChangePct)}
                </span>
              </div>
            )}
            <div className='flex items-center gap-1'>
              <span className='text-muted-foreground'>Observations</span>
              <span className='tabular-nums'>{activity.observationCount}</span>
            </div>
          </div>
        )}

        {item.canonicalUrl && (
          <a
            href={item.canonicalUrl}
            target='_blank'
            rel='noreferrer'
            className='inline-flex w-fit items-center gap-1 text-sm text-primary hover:underline'
          >
            View listing
            <Icons.externalLink className='h-3.5 w-3.5' />
          </a>
        )}
      </CardContent>
    </Card>
  );
}
