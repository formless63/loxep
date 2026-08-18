import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import type { AgingBucketDto } from '@/server/inventory-functions';

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)'
];

/**
 * On-hand cost by days-since-acquired, one series per currency (never
 * summed across currencies — a distinct bar series per currency inside the
 * same bucket is the currency-safe way to chart this, not a single combined
 * total). `Number(...)` here feeds the chart axis only; the decimal string
 * remains the source of truth everywhere else.
 */
export default function InventoryAgingChart({ rows }: { rows: AgingBucketDto[] }) {
  const currencies = [...new Set(rows.map((row) => row.currency))].slice(0, CHART_COLORS.length);
  const buckets = [...new Set(rows.map((row) => row.bucket))];

  const chartConfig = Object.fromEntries(
    currencies.map((currency, index) => [
      currency,
      { label: currency, color: CHART_COLORS[index % CHART_COLORS.length] }
    ])
  ) satisfies ChartConfig;

  const points = buckets.map((bucket) => {
    const point: Record<string, string | number> = { bucket };
    for (const currency of currencies) {
      const match = rows.find((row) => row.bucket === bucket && row.currency === currency);
      point[currency] = match ? Number(match.onHandCostAmount) : 0;
    }
    return point;
  });

  const hasData = rows.some((row) => Number(row.onHandCostAmount) > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Inventory aging</CardTitle>
        <CardDescription>
          On-hand cost bucketed by days since acquired — how much basis has been sitting on the
          shelf, and for how long.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Skeleton className='aspect-video w-full' />
        ) : !hasData ? (
          <p className='text-muted-foreground text-sm'>No on-hand stock to age.</p>
        ) : (
          <ChartContainer config={chartConfig}>
            <BarChart accessibilityLayer data={points}>
              <CartesianGrid vertical={false} strokeDasharray='3 3' />
              <XAxis dataKey='bucket' tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis tickLine={false} axisLine={false} tickMargin={8} width={48} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {currencies.length > 1 && <Legend />}
              {currencies.map((currency) => (
                <Bar
                  key={currency}
                  dataKey={currency}
                  fill={`var(--color-${currency})`}
                  radius={2}
                />
              ))}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
