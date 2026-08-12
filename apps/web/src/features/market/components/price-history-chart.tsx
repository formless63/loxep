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
import { itemPriceHistoryQuery } from '@/features/market/api/queries';

const chartConfig = {
  price: {
    label: 'Last price',
    color: 'var(--chart-1)'
  }
} satisfies ChartConfig;

/**
 * Hourly-bucketed price series (`priceHistory` in `@loxep/market/metrics.ts`).
 * Decimal-string prices are parsed to `number` here only for the chart's Y
 * axis — never for stored/compared amounts. Gaps in the underlying data are
 * absent buckets, not zero-filled, so the line does not connect across them.
 */
export default function PriceHistoryChart({ marketplaceItemId }: { marketplaceItemId: string }) {
  const { data, isPending } = useQuery(itemPriceHistoryQuery(marketplaceItemId));

  const points = (data ?? []).map((bucket) => ({
    bucketStart: bucket.bucketStart,
    price: bucket.lastPrice === null ? null : Number(bucket.lastPrice)
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Price history</CardTitle>
        <CardDescription>Hourly-bucketed last observed price.</CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className='aspect-video w-full' />
        ) : points.length === 0 ? (
          <p className='text-muted-foreground text-sm'>No price observations yet.</p>
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
              <YAxis tickLine={false} axisLine={false} tickMargin={8} width={64} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => format(new Date(String(value)), 'PPpp')}
                  />
                }
              />
              <Line
                dataKey='price'
                type='monotone'
                stroke='var(--color-price)'
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
