import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { CartesianGrid, Line, LineChart, ReferenceDot, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import {
  itemAvailabilityHistoryQuery,
  itemRestockSelloutQuery
} from '@/features/market/api/queries';

const chartConfig = {
  quantity: {
    label: 'Quantity available',
    color: 'var(--chart-2)'
  }
} satisfies ChartConfig;

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/**
 * Availability/quantity timeline: `availabilityHistory` bucketed chart plus
 * `restockSellout`'s derived in-stock/out-of-stock summary
 * (`@loxep/market/metrics.ts`).
 */
export default function AvailabilityTimeline({ marketplaceItemId }: { marketplaceItemId: string }) {
  const { data: history, isPending: historyPending } = useQuery(
    itemAvailabilityHistoryQuery(marketplaceItemId)
  );
  const { data: restockSellout, isPending: restockPending } = useQuery(
    itemRestockSelloutQuery(marketplaceItemId)
  );

  const points = (history ?? []).map((bucket) => ({
    bucketStart: bucket.bucketStart,
    quantity: bucket.lastQuantityAvailable,
    wentUnavailable: bucket.wentUnavailable
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Availability & quantity</CardTitle>
        <CardDescription>
          Hourly-bucketed availability, with restock/sellout history.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {!restockPending && restockSellout && (
          <div className='flex flex-wrap items-center gap-4 text-sm'>
            <div className='flex items-center gap-2'>
              <span className='text-muted-foreground'>Current</span>
              <Badge variant={restockSellout.currentState === 'in_stock' ? 'secondary' : 'outline'}>
                {restockSellout.currentState}
              </Badge>
            </div>
            <div className='flex items-center gap-2'>
              <span className='text-muted-foreground'>Sellouts</span>
              <span>{restockSellout.selloutCount}</span>
            </div>
            <div className='flex items-center gap-2'>
              <span className='text-muted-foreground'>Restocks</span>
              <span>{restockSellout.restockCount}</span>
            </div>
            <div className='flex items-center gap-2'>
              <span className='text-muted-foreground'>Avg out-of-stock</span>
              <span>{formatSeconds(restockSellout.avgOutOfStockSeconds)}</span>
            </div>
            <div className='flex items-center gap-2'>
              <span className='text-muted-foreground'>Avg in-stock</span>
              <span>{formatSeconds(restockSellout.avgInStockSeconds)}</span>
            </div>
          </div>
        )}

        {historyPending ? (
          <Skeleton className='aspect-video w-full' />
        ) : points.length === 0 ? (
          <p className='text-muted-foreground text-sm'>No availability observations yet.</p>
        ) : (
          <ChartContainer config={chartConfig}>
            <LineChart accessibilityLayer data={points}>
              <CartesianGrid vertical={false} strokeDasharray='3 3' />
              <XAxis
                dataKey='bucketStart'
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value: string) => format(new Date(value), 'MM/dd HH:mm')}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={48}
                allowDecimals={false}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => format(new Date(String(value)), 'PPpp')}
                  />
                }
              />
              <Line
                dataKey='quantity'
                type='stepAfter'
                stroke='var(--color-quantity)'
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
              {points
                .filter((point) => point.wentUnavailable)
                .map((point) => (
                  <ReferenceDot
                    key={point.bucketStart}
                    x={point.bucketStart}
                    y={point.quantity ?? 0}
                    r={5}
                    fill='var(--destructive)'
                    stroke='var(--background)'
                    strokeWidth={2}
                  />
                ))}
            </LineChart>
          </ChartContainer>
        )}
        {points.some((point) => point.wentUnavailable) && (
          <p className='flex items-center gap-1.5 text-muted-foreground text-xs'>
            <span
              aria-hidden='true'
              className='inline-block size-2 shrink-0 rounded-full bg-destructive'
            />
            Marked points are hourly buckets in which the item went unavailable (sellout).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
