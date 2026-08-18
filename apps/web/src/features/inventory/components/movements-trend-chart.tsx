import { Area, AreaChart, CartesianGrid, Legend, XAxis, YAxis } from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { inventoryMovementTrendQuery } from '@/features/inventory/api/queries';
import { shapeMovementsTrend } from '@/features/inventory/lib/movement-trend';
import {
  MOVEMENT_TREND_GROUP_VALUES,
  movementTrendGroupLabel
} from '@/features/inventory/constants';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)'
];

const chartConfig = Object.fromEntries(
  MOVEMENT_TREND_GROUP_VALUES.map((group, index) => [
    group,
    { label: movementTrendGroupLabel(group), color: CHART_COLORS[index % CHART_COLORS.length] }
  ])
) satisfies ChartConfig;

/**
 * "Am I receiving faster than selling, and is shrinkage trending up?"
 * (loxep-8e2, priority 1) — a stacked daily area over the last 90 days
 * (`fetchInventoryMovementTrend`'s bound), one series per {@link
 * MOVEMENT_TREND_GROUP_VALUES} group. Own query, own loading/error/empty
 * state — a separate data source from `MovementsTable`'s full ledger, per
 * Frontend Standards' "one boundary per data source."
 */
export default function MovementsTrendChart() {
  const { data, isPending, isError, error, refetch } = useQuery(inventoryMovementTrendQuery);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Movements by kind, last 90 days</CardTitle>
        <CardDescription>
          Received vs. sold vs. shrinkage/disposal, stacked daily — receiving outpacing selling, or
          shrinkage creeping up, shows here first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className='aspect-auto h-64 w-full' />
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load movement trend'
            onRetry={() => refetch()}
          />
        ) : data.length === 0 ? (
          <p className='text-muted-foreground text-sm'>
            No movements recorded in the last 90 days.
          </p>
        ) : (
          <ChartContainer config={chartConfig} className='aspect-auto h-64 w-full'>
            <AreaChart
              accessibilityLayer
              data={shapeMovementsTrend(data).map((bucket) => ({
                day: bucket.day,
                received: Number(bucket.received),
                sold: Number(bucket.sold),
                shrinkage: Number(bucket.shrinkage),
                adjusted: Number(bucket.adjusted),
                reversed: Number(bucket.reversed)
              }))}
            >
              <CartesianGrid vertical={false} strokeDasharray='3 3' />
              <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis tickLine={false} axisLine={false} tickMargin={8} width={48} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Legend />
              {MOVEMENT_TREND_GROUP_VALUES.map((group) => (
                <Area
                  key={group}
                  type='monotone'
                  dataKey={group}
                  stackId='movements'
                  stroke={`var(--color-${group})`}
                  fill={`var(--color-${group})`}
                  fillOpacity={0.4}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
