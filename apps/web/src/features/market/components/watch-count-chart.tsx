import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { itemAvailabilityHistoryQuery } from '@/features/market/api/queries';

const chartConfig = {
  watchCount: {
    label: 'Watch count',
    color: 'var(--chart-3)'
  }
} satisfies ChartConfig;

/**
 * Hourly-bucketed `watch_count` trend (loxep-48v) — "is demand building on
 * this listing?" Reads the SAME `itemAvailabilityHistoryQuery` the
 * availability timeline uses (`availabilityHistory` in
 * `@loxep/market/metrics.ts` now also carries `lastWatchCount`), so this
 * component adds a chart without adding a network round trip: TanStack
 * Query dedupes the identical query key when both components mount on the
 * item detail page. Gaps in the underlying data are absent buckets, not
 * zero-filled, so the line does not connect across them.
 */
export default function WatchCountChart({ marketplaceItemId }: { marketplaceItemId: string }) {
  const { data, isPending } = useQuery(itemAvailabilityHistoryQuery(marketplaceItemId));

  const points = (data ?? []).map((bucket) => ({
    bucketStart: bucket.bucketStart,
    watchCount: bucket.lastWatchCount
  }));
  const hasData = points.some((point) => point.watchCount !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Watch count</CardTitle>
        <CardDescription>Hourly-bucketed watcher count — is demand building?</CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className='aspect-video w-full' />
        ) : !hasData ? (
          <p className='text-muted-foreground text-sm'>No watch-count observations yet.</p>
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
                dataKey='watchCount'
                type='monotone'
                stroke='var(--color-watchCount)'
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
