import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { formatMoney } from '@/lib/format';
import { orderFeeTrendsQuery } from '@/features/commerce/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import {
  FEE_TREND_CATEGORIES,
  feeTrendCategoryLabel,
  shapeFeeTrendByPeriod,
  type FeeTrendCategory
} from '@/features/commerce/lib/fee-trend';

const feeTrendChartConfig = {
  marketplace_final_value: {
    label: feeTrendCategoryLabel('marketplace_final_value'),
    color: 'var(--chart-1)'
  },
  marketplace_insertion: {
    label: feeTrendCategoryLabel('marketplace_insertion'),
    color: 'var(--chart-2)'
  },
  promoted_listing_ad: {
    label: feeTrendCategoryLabel('promoted_listing_ad'),
    color: 'var(--chart-3)'
  },
  payment_processing: {
    label: feeTrendCategoryLabel('payment_processing'),
    color: 'var(--chart-4)'
  },
  other: { label: feeTrendCategoryLabel('other'), color: 'var(--chart-5)' }
} satisfies ChartConfig;

const CHART_HEIGHT_CLASS = 'aspect-auto h-64 w-full';
type FeeTrendTooltipFormatter = NonNullable<
  React.ComponentProps<typeof ChartTooltipContent>['formatter']
>;

const formatFeeTrendTooltipValue: FeeTrendTooltipFormatter = (value, name, item) => {
  const category = name as FeeTrendCategory;
  const currency =
    typeof item.payload?.currency === 'string' ? item.payload.currency : 'unknown currency';

  return (
    <div className='flex w-full items-center justify-between gap-3'>
      <span className='flex items-center gap-1.5 text-muted-foreground'>
        <span
          className='size-2.5 shrink-0 rounded-[2px]'
          style={{ backgroundColor: `var(--color-${category})` }}
        />
        {feeTrendChartConfig[category]?.label ?? name}
      </span>
      <span className='font-mono font-medium text-foreground tabular-nums'>
        {formatMoney(String(value), currency)}
      </span>
    </div>
  );
};

function FeeTrendChartSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Seller-charged fees by type</CardTitle>
      </CardHeader>
      <CardContent>
        <Skeleton className='h-64 w-full' />
      </CardContent>
    </Card>
  );
}

function periodLabel(period: string): string {
  const [year, month] = period.split('-');
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function FeeTrendChartContent({
  rows
}: {
  rows: { feeType: string; currency: string; amount: string; chargedAt: string }[];
}) {
  const shape = React.useMemo(() => {
    const result = shapeFeeTrendByPeriod(rows);
    return {
      ...result,
      points: result.points.map((point) => ({ ...point, currency: result.currency }))
    };
  }, [rows]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-base'>
          <Icons.trendingUp className='size-4' /> Seller-charged fees by type
        </CardTitle>
        <CardDescription>
          Last 90 days of <code className='text-[0.7rem]'>order_fees</code> (seller-charged only —
          buyer surcharges are already inside order totals and are never a cost to the seller). Did
          eBay&rsquo;s rate change, and what is promoted-listing spend costing?
        </CardDescription>
      </CardHeader>
      <CardContent>
        {shape.points.length === 0 ? (
          <p className='text-muted-foreground text-sm'>
            No seller-charged fees in the last 90 days.
          </p>
        ) : (
          <>
            <ChartContainer config={feeTrendChartConfig} className={CHART_HEIGHT_CLASS}>
              <LineChart data={shape.points}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey='period'
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={periodLabel}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={56}
                  tickFormatter={(value: number) => formatMoney(String(value), shape.currency)}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => periodLabel(String(value))}
                      formatter={formatFeeTrendTooltipValue}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {FEE_TREND_CATEGORIES.map((category) => (
                  <Line
                    key={category}
                    dataKey={category}
                    type='monotone'
                    stroke={`var(--color-${category})`}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ChartContainer>
            {shape.excludedCurrencyRowCount > 0 && (
              <p className='text-muted-foreground mt-2 text-xs'>
                {shape.excludedCurrencyRowCount} fee row(s) in a different currency than{' '}
                {shape.currency} were excluded from this chart rather than blended into one
                fabricated total.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Self-contained card (loxep-8e2 item 3): reads `orderFeeTrendsQuery` itself,
 * gating its own loading/error state per Frontend Standards' "one boundary
 * per data source" — independent of every other card on `/commerce/overview`.
 */
export default function FeeTrendChart() {
  const { data, isPending, isError, error, refetch } = useQuery(orderFeeTrendsQuery);

  if (isPending) return <FeeTrendChartSkeleton />;
  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load fee trends' onRetry={() => refetch()} />
    );
  }
  return <FeeTrendChartContent rows={data} />;
}
