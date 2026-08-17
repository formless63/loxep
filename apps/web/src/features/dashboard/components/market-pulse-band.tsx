/**
 * Band 2 — Market pulse (loxep-jwm).
 *
 * The same derived-event reads `/market/overview` renders, composed wider:
 * a 24h event-activity area chart beside the scored top opportunity and the
 * biggest price movers. Every tile links to the market surface that owns it.
 */
import { AreaChart, Area, XAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from '@/components/ui/chart';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { formatQuantity, formatScore, formatHourLabel, formatDateTime } from '@/lib/format';
import { scoreIcon, scoreTone } from '@/features/market/constants';
import {
  BAND_GRID_TINT,
  Band,
  FocusableLink,
  PanelCard
} from '@/features/dashboard/components/dashboard-primitives';
import MoversList from '@/features/dashboard/components/movers-list';
import type { DashboardMarketPulseDto, DashboardPriceMoverDto } from '@/server/dashboard-functions';
import type { MarketOverviewTrendBucketDto, TopOpportunityDto } from '@/server/market-functions';

const eventsChartConfig = {
  count: { label: 'Events', color: 'var(--chart-1)' }
} satisfies ChartConfig;

function EventsActivityCard({
  trend,
  total,
  activeMonitorCount,
  watchedItemCount
}: {
  trend: MarketOverviewTrendBucketDto[];
  total: number;
  activeMonitorCount: number;
  watchedItemCount: number;
}) {
  const hasData = trend.some((bucket) => bucket.count > 0);

  return (
    <FocusableLink to='/market/overview' className='h-full'>
      <Card className='@container/card h-full'>
        <CardHeader>
          <CardDescription>Event activity (24h)</CardDescription>
          <CardTitle className='text-2xl font-semibold tabular-nums'>
            {formatQuantity(total)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {hasData ? (
            <ChartContainer config={eventsChartConfig} className='aspect-auto h-40 w-full'>
              <AreaChart data={trend}>
                <defs>
                  <linearGradient id='dashboard-events-fill' x1='0' y1='0' x2='0' y2='1'>
                    <stop offset='5%' stopColor='var(--color-count)' stopOpacity={0.45} />
                    <stop offset='95%' stopColor='var(--color-count)' stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey='bucketStart'
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={40}
                  tickFormatter={formatHourLabel}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => formatDateTime(String(value))}
                    />
                  }
                />
                <Area
                  dataKey='count'
                  type='monotone'
                  stroke='var(--color-count)'
                  fill='url(#dashboard-events-fill)'
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <Empty className='p-0'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.pulse />
                </EmptyMedia>
                <EmptyTitle>No events in the last 24h</EmptyTitle>
                <EmptyDescription>
                  Events are derived interpretations of change between observations — an empty chart
                  here means nothing changed, not that nothing was polled.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <p className='pt-3 text-sm text-muted-foreground'>
            <span className='tabular-nums'>{formatQuantity(activeMonitorCount)}</span> active
            monitors watching{' '}
            <span className='tabular-nums'>{formatQuantity(watchedItemCount)}</span> items.
          </p>
        </CardContent>
      </Card>
    </FocusableLink>
  );
}

function TopOpportunityCard({ topOpportunity }: { topOpportunity: TopOpportunityDto | null }) {
  const ScoreIcon = topOpportunity ? scoreIcon(topOpportunity.score) : Icons.sparkles;

  return (
    <FocusableLink to='/market/opportunities' className='h-full'>
      <Card className='@container/card h-full'>
        <CardHeader>
          <CardDescription>Top opportunity</CardDescription>
          {topOpportunity ? (
            <>
              <CardTitle className='text-2xl font-semibold tabular-nums'>
                {formatScore(topOpportunity.score)}
              </CardTitle>
              <CardDescription className='pt-1'>
                <Badge variant={scoreTone(topOpportunity.score)}>
                  <ScoreIcon />
                  {topOpportunity.ruleName}
                </Badge>
              </CardDescription>
            </>
          ) : null}
        </CardHeader>
        <CardContent>
          {topOpportunity ? (
            <p className='line-clamp-2 text-sm font-medium'>
              {topOpportunity.itemTitle ?? topOpportunity.marketplaceItemId}
            </p>
          ) : (
            /* `EmptyContent`'s action slot is intentionally unused: the whole
               tile is already a link, and an interactive element cannot nest
               inside an `<a>`. Same choice as `/market/overview`. */
            <Empty className='p-0'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.sparkles />
                </EmptyMedia>
                <EmptyTitle>No scored opportunities yet</EmptyTitle>
                <EmptyDescription>
                  No opportunity rule has stamped a scored event among recent activity.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </FocusableLink>
  );
}

function MoversCard({
  movers,
  windowHours
}: {
  movers: DashboardPriceMoverDto[];
  windowHours: number;
}) {
  return (
    <PanelCard
      className='sm:col-span-2'
      title='Biggest movers'
      description={`Largest price changes between the last two priced observations, trailing ${windowHours / 24} days.`}
    >
      <MoversList movers={movers} windowHours={windowHours} />
    </PanelCard>
  );
}

export function MarketPulseBand({ data }: { data: DashboardMarketPulseDto }) {
  return (
    <Band
      title='Market pulse'
      description='Derived events, scored opportunities, and what just moved across every watched item.'
      action={{ label: 'Market overview', to: '/market/overview' }}
    >
      <div
        className={cn(
          'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:grid-rows-2',
          BAND_GRID_TINT
        )}
      >
        <div className='min-w-0 sm:col-span-2 xl:row-span-2'>
          <EventsActivityCard
            trend={data.eventsTrend}
            total={data.eventsLast24hCount}
            activeMonitorCount={data.activeMonitorCount}
            watchedItemCount={data.watchedItemCount}
          />
        </div>
        <div className='min-w-0 sm:col-span-2'>
          <TopOpportunityCard topOpportunity={data.topOpportunity} />
        </div>
        <MoversCard movers={data.movers} windowHours={data.moversWindowHours} />
      </div>
    </Band>
  );
}
