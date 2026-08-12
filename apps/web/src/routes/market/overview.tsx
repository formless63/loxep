import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Area, AreaChart, XAxis } from 'recharts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { MarketPage } from '@/features/market/components/market-page';
import RecentEventsList from '@/features/market/components/recent-events-list';
import { marketOverviewQuery } from '@/features/market/api/queries';
import { cn } from '@/lib/utils';
import { formatPercent, formatQuantity, formatScore } from '@/lib/format';
import type {
  MarketOverviewDto,
  MarketOverviewTrendBucketDto,
  TopOpportunityDto
} from '@/server/market-functions';

export const Route = createFileRoute('/market/overview')({
  component: MarketOverview
});

type RouteTarget = React.ComponentProps<typeof Link>['to'];

/** Every card in the KPI/nav grids that navigates gets the same visible focus ring. */
function FocusableLink({
  to,
  className,
  children
}: {
  to: RouteTarget;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className
      )}
    >
      {children}
    </Link>
  );
}

function StatCard({
  label,
  value,
  href,
  trend,
  footer
}: {
  label: string;
  value: React.ReactNode;
  href?: RouteTarget;
  trend?: { direction: 'up' | 'down'; label: string };
  footer?: React.ReactNode;
}) {
  const card = (
    <Card className='@container/card h-full'>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className='text-2xl font-semibold tabular-nums @[250px]/card:text-3xl'>
          {value}
        </CardTitle>
        {trend && (
          <CardAction>
            <Badge variant='outline'>
              {trend.direction === 'up' ? <Icons.trendingUp /> : <Icons.trendingDown />}
              {trend.label}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      {footer && (
        <CardFooter className='flex-col items-start gap-1 text-sm'>
          <div className='text-muted-foreground'>{footer}</div>
        </CardFooter>
      )}
    </Card>
  );

  return href ? <FocusableLink to={href}>{card}</FocusableLink> : card;
}

/**
 * Highest-scoring rule-stamped event gets its own card shape: no fabricated
 * CardAction trend (there is no prior-period score to diff against), and an
 * `Empty` composition — instead of a de-styled `CardTitle` — when no rule has
 * stamped a scored event yet. `EmptyContent`'s primary-action slot is
 * intentionally unused here: the whole tile is already a `<Link>`, and an
 * interactive element cannot nest inside an `<a>`.
 */
function TopOpportunityCard({ topOpportunity }: { topOpportunity: TopOpportunityDto | null }) {
  const card = topOpportunity ? (
    <Card className='@container/card h-full'>
      <CardHeader>
        <CardDescription>Top opportunity</CardDescription>
        <CardTitle className='text-2xl font-semibold tabular-nums @[250px]/card:text-3xl'>
          {formatScore(topOpportunity.score)}
        </CardTitle>
      </CardHeader>
      <CardFooter className='flex-col items-start gap-1 text-sm'>
        <p className='line-clamp-1 font-medium'>
          {topOpportunity.itemTitle ?? topOpportunity.marketplaceItemId}
        </p>
        <p className='text-muted-foreground'>{topOpportunity.ruleName}</p>
      </CardFooter>
    </Card>
  ) : (
    <Card className='@container/card h-full'>
      <CardHeader>
        <CardDescription>Top opportunity</CardDescription>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );

  return <FocusableLink to='/market/opportunities'>{card}</FocusableLink>;
}

const eventsTrendChartConfig = {
  count: {
    label: 'Events',
    color: 'var(--chart-1)'
  }
} satisfies ChartConfig;

/** Compares the trailing vs. leading half of the 24h window — a real, derived signal, not a fabricated one. */
function eventsTrendBadge(
  trend: MarketOverviewTrendBucketDto[]
): { direction: 'up' | 'down'; label: string } | undefined {
  if (trend.length < 2) return undefined;
  const midpoint = Math.floor(trend.length / 2);
  const earlier = trend.slice(0, midpoint).reduce((sum, bucket) => sum + bucket.count, 0);
  const recent = trend.slice(midpoint).reduce((sum, bucket) => sum + bucket.count, 0);
  if (earlier === 0 && recent === 0) return undefined;
  const pct = earlier === 0 ? 100 : ((recent - earlier) / earlier) * 100;
  return { direction: pct >= 0 ? 'up' : 'down', label: formatPercent(pct) };
}

/** Hourly event-count sparkline for the trailing 24h — the one chart on this page. */
function EventsTrendCard({ trend }: { trend: MarketOverviewTrendBucketDto[] }) {
  const hasData = trend.some((bucket) => bucket.count > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Event activity (24h)</CardTitle>
        <CardDescription>Hourly-bucketed derived market events, across every item.</CardDescription>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ChartContainer config={eventsTrendChartConfig} className='aspect-auto h-32 w-full'>
            <AreaChart data={trend}>
              <defs>
                <linearGradient id='events-trend-fill' x1='0' y1='0' x2='0' y2='1'>
                  <stop offset='5%' stopColor='var(--color-count)' stopOpacity={0.4} />
                  <stop offset='95%' stopColor='var(--color-count)' stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey='bucketStart'
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={40}
                tickFormatter={(value: string) => format(new Date(value), 'HH:mm')}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => format(new Date(String(value)), 'PPpp')}
                  />
                }
              />
              <Area
                dataKey='count'
                type='monotone'
                stroke='var(--color-count)'
                fill='url(#events-trend-fill)'
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <p className='text-muted-foreground text-sm'>No events in the last 24h.</p>
        )}
      </CardContent>
    </Card>
  );
}

const NAV_CARD_HOVER = 'transition-colors hover:bg-accent/50';

function OverviewSkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5'>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className='h-32 w-full' />
        ))}
      </div>
      <Skeleton className='h-56 w-full' />
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-24 w-full' />
        ))}
      </div>
      <Skeleton className='h-48 w-full' />
    </div>
  );
}

function OverviewContent({ data }: { data: MarketOverviewDto }) {
  return (
    <div className='flex flex-col gap-4'>
      <div
        className={cn(
          'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5',
          '[&_[data-slot=card]]:bg-gradient-to-t [&_[data-slot=card]]:from-primary/5 [&_[data-slot=card]]:to-card [&_[data-slot=card]]:shadow-xs dark:[&_[data-slot=card]]:bg-card'
        )}
      >
        <StatCard
          label='Active monitors'
          value={formatQuantity(data.activeMonitorCount)}
          footer='Currently enabled monitor targets'
        />
        <StatCard
          label='Watched items'
          value={formatQuantity(data.watchedItemCount)}
          footer='Marketplace items linked to your monitors'
        />
        <StatCard
          label='Events (last 24h)'
          value={formatQuantity(data.eventsLast24hCount)}
          trend={eventsTrendBadge(data.eventsTrend)}
          footer='Derived market events, across every item'
        />
        <StatCard
          label='New listings (24h)'
          value={formatQuantity(data.newListingCount24h)}
          href='/market/searches'
          footer='From search & seller discovery monitors'
        />
        <TopOpportunityCard topOpportunity={data.topOpportunity} />
      </div>

      <EventsTrendCard trend={data.eventsTrend} />

      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        <FocusableLink to='/market/monitors'>
          <Card className={NAV_CARD_HOVER}>
            <CardHeader>
              <CardTitle className='text-base'>Monitors</CardTitle>
              <CardDescription>
                What to poll, on what cadence — create, edit, enable/disable eBay item, watchlist,
                search, and seller monitors.
              </CardDescription>
            </CardHeader>
          </Card>
        </FocusableLink>
        <FocusableLink to='/market/items'>
          <Card className={NAV_CARD_HOVER}>
            <CardHeader>
              <CardTitle className='text-base'>Watched items</CardTitle>
              <CardDescription>
                Marketplace items linked to your monitors, joined with their latest observation.
              </CardDescription>
            </CardHeader>
          </Card>
        </FocusableLink>
        <FocusableLink to='/market/searches'>
          <Card className={NAV_CARD_HOVER}>
            <CardHeader>
              <CardTitle className='text-base'>Search &amp; seller monitors</CardTitle>
              <CardDescription>
                Discovered-item counts and recent new-listing activity per discovery monitor.
              </CardDescription>
            </CardHeader>
          </Card>
        </FocusableLink>
        <FocusableLink to='/market/opportunities'>
          <Card className={NAV_CARD_HOVER}>
            <CardHeader>
              <CardTitle className='text-base'>Opportunities</CardTitle>
              <CardDescription>
                Events stamped and scored by an opportunity rule, ranked and linked to their item.
              </CardDescription>
            </CardHeader>
          </Card>
        </FocusableLink>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Recent events</CardTitle>
          <CardDescription>The latest derived market events, across every item.</CardDescription>
        </CardHeader>
        <CardContent>
          <RecentEventsList events={data.recentEvents} />
        </CardContent>
      </Card>
    </div>
  );
}

function MarketOverview() {
  const { data, isPending, isError, error } = useQuery(marketOverviewQuery);

  return (
    <MarketPage
      title='Market'
      description='Monitor targets, watched items, and derived market events.'
    >
      {isPending ? (
        <OverviewSkeleton />
      ) : isError || !data ? (
        <Alert variant='destructive'>
          <AlertTitle>Market overview unavailable</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'Unknown error'}
          </AlertDescription>
        </Alert>
      ) : (
        <OverviewContent data={data} />
      )}
    </MarketPage>
  );
}
