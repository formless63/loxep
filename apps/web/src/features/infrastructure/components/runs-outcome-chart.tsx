import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { reconcileRunsQuery } from '@/features/infrastructure/api/queries';
import {
  RUN_STATUS_KEYS,
  shapeRunsOutcomeTrend
} from '@/features/infrastructure/lib/runs-outcome-trend';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { ReconcileRunDto } from '@/server/infrastructure-functions';

const outcomeChartConfig = {
  succeeded: { label: 'Succeeded', color: 'var(--chart-1)' },
  partial: { label: 'Partial', color: 'var(--chart-2)' },
  failed: { label: 'Failed', color: 'var(--chart-3)' },
  running: { label: 'Running', color: 'var(--chart-4)' }
} satisfies ChartConfig;

const durationChartConfig = {
  avgDurationSeconds: { label: 'Avg duration (s)', color: 'var(--chart-5)' }
} satisfies ChartConfig;

function RunsOutcomeChartSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Runs by outcome</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        <Skeleton className='aspect-auto h-48 w-full' />
        <Skeleton className='aspect-auto h-24 w-full' />
      </CardContent>
    </Card>
  );
}

function RunsOutcomeChartContent({ runs }: { runs: ReconcileRunDto[] }) {
  const trend = React.useMemo(() => shapeRunsOutcomeTrend(runs), [runs]);
  const hasOutcomeData = trend.length > 0;
  const hasDurationData = trend.some((bucket) => bucket.avgDurationSeconds !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Runs by outcome</CardTitle>
        <CardDescription>
          Daily outcome mix and average duration across the last {runs.length} reconcile runs — is
          the reconciler getting worse, and since when?
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {hasOutcomeData ? (
          <ChartContainer config={outcomeChartConfig} className='aspect-auto h-48 w-full'>
            <BarChart data={trend}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {RUN_STATUS_KEYS.map((key) => (
                <Bar key={key} dataKey={key} stackId='outcome' fill={`var(--color-${key})`} />
              ))}
            </BarChart>
          </ChartContainer>
        ) : (
          <p className='text-muted-foreground text-sm'>No reconcile runs yet.</p>
        )}
        {hasDurationData && (
          <ChartContainer config={durationChartConfig} className='aspect-auto h-24 w-full'>
            <LineChart data={trend}>
              <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line
                dataKey='avgDurationSeconds'
                type='monotone'
                stroke='var(--color-avgDurationSeconds)'
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Self-contained card: reads `reconcileRunsQuery` itself (same cache key
 * `RunsTable` already warms), gates its own loading/error state per
 * Frontend Standards' "one boundary per data source" — a `useQuery`
 * independent of the table's own render path.
 */
export default function RunsOutcomeChart() {
  const { data, isPending, isError, error, refetch } = useQuery(reconcileRunsQuery);

  if (isPending) return <RunsOutcomeChartSkeleton />;
  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load run outcomes'
        onRetry={() => refetch()}
      />
    );
  }
  return <RunsOutcomeChartContent runs={data} />;
}
