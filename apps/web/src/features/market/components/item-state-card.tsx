import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Icons } from '@/components/icons';
import { itemActivitySummaryQuery } from '@/features/market/api/queries';
import { marketEventTypeLabel } from '@/features/settings/constants';
import type { MarketItemDetailDto } from '@/server/market-functions';

function formatTimestamp(value: string | null): string {
  return value ? format(new Date(value), 'yyyy-MM-dd HH:mm') : '—';
}

function formatPrice(price: string | null, currency: string | null): string {
  if (price === null) return '—';
  return currency ? `${price} ${currency}` : price;
}

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
            <p className='text-muted-foreground'>Price</p>
            <p className='font-medium'>
              {formatPrice(observation?.price ?? null, observation?.currency ?? null)}
            </p>
          </div>
          <div>
            <p className='text-muted-foreground'>Availability</p>
            <p className='font-medium'>{observation?.availability ?? '—'}</p>
          </div>
          <div>
            <p className='text-muted-foreground'>Quantity available</p>
            <p className='font-medium'>{observation?.quantityAvailable ?? '—'}</p>
          </div>
          <div>
            <p className='text-muted-foreground'>Listing state</p>
            <p className='font-medium'>{observation?.listingState ?? '—'}</p>
          </div>
          <div>
            <p className='text-muted-foreground'>Last observed</p>
            <p className='font-medium'>{formatTimestamp(observation?.observedAt ?? null)}</p>
          </div>
          <div>
            <p className='text-muted-foreground'>Condition</p>
            <p className='font-medium'>{item.conditionCode ?? '—'}</p>
          </div>
          <div>
            <p className='text-muted-foreground'>Listing type</p>
            <p className='font-medium'>{item.listingType ?? '—'}</p>
          </div>
          <div>
            <p className='text-muted-foreground'>Listing ends</p>
            <p className='font-medium'>{formatTimestamp(item.listingEndsAt)}</p>
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
                <span>{activity.priceChangePct.toFixed(2)}%</span>
              </div>
            )}
            <div className='flex items-center gap-1'>
              <span className='text-muted-foreground'>Observations</span>
              <span>{activity.observationCount}</span>
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
