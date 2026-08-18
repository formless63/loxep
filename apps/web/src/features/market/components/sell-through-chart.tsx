import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
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
  unitsSold: {
    label: 'Units sold',
    color: 'var(--chart-4)'
  }
} satisfies ChartConfig;

/**
 * Hourly-bucketed sell-through velocity (loxep-48v) — "how fast is the
 * seller actually moving units?" `quantity_sold` is the provider's RAW
 * CUMULATIVE total-sold-to-date counter (eBay's `estimatedSoldQuantity`),
 * so this chart deliberately does NOT plot that raw value — a rising
 * cumulative line answers "how many total," a different question. It plots
 * `unitsSold`, the server-computed per-bucket DELTA
 * (`@loxep/market`'s `deriveSellThroughDeltas`, applied in
 * `fetchItemAvailabilityHistory`): units moved during each bucket, never
 * negative (a downward counter reset re-baselines instead of producing a
 * negative bar), and null (rendered as a gap, not a zero bar) wherever no
 * honest delta could be computed — the first known reading, an unobserved
 * bucket, or immediately after a reset.
 *
 * A bar chart (not a line) because this is a discrete per-bucket quantity,
 * not a continuous measurement — matching `bar-graph.tsx`'s pattern for
 * this shape of data. Reads the SAME `itemAvailabilityHistoryQuery` as
 * `availability-timeline.tsx`/`watch-count-chart.tsx`, so no extra network
 * round trip.
 */
export default function SellThroughChart({ marketplaceItemId }: { marketplaceItemId: string }) {
  const { data, isPending } = useQuery(itemAvailabilityHistoryQuery(marketplaceItemId));

  const points = (data ?? []).map((bucket) => ({
    bucketStart: bucket.bucketStart,
    unitsSold: bucket.unitsSold
  }));
  const hasData = points.some((point) => point.unitsSold !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Sell-through velocity</CardTitle>
        <CardDescription>
          Units sold per hourly bucket (delta of the cumulative sold count) — how fast the seller is
          moving units.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className='aspect-video w-full' />
        ) : !hasData ? (
          <p className='text-muted-foreground text-sm'>No sell-through data yet.</p>
        ) : (
          <ChartContainer config={chartConfig}>
            <BarChart accessibilityLayer data={points}>
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
              <Bar dataKey='unitsSold' fill='var(--color-unitsSold)' radius={2} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
