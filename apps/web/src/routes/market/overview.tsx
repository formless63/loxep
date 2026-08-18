import * as React from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Area, AreaChart, XAxis } from 'recharts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { StackedStatusBar } from '@/components/ui/stacked-status-bar';
import { Icons, type Icon } from '@/components/icons';
import { MarketPage } from '@/features/market/components/market-page';
import RecentEventsList from '@/features/market/components/recent-events-list';
import { marketOverviewQuery } from '@/features/market/api/queries';
import { marketEventTypeLabel } from '@/features/settings/constants';
import {
  marketEventTypeBarColor,
  marketItemStateBarColor,
  marketItemStateLabel
} from '@/features/market/constants';
import { cn } from '@/lib/utils';
import { formatPercent, formatQuantity, formatScore } from '@/lib/format';
import type {
  MarketOverviewBreakdownEntryDto,
  MarketOverviewDto,
  MarketOverviewTrendBucketDto,
  TopOpportunityDto
} from '@/server/market-functions';

export const Route = createFileRoute('/market/overview')({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(marketOverviewQuery);
  },
  errorComponent: MarketOverviewError,
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

/** A tinted chart-token circle for KPI tiles that have no real series to sparkline (Frontend Standards: no fabricated trend data). */
function StatIcon({ icon: IconComponent, className }: { icon: Icon; className: string }) {
  return (
    <span
      className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', className)}
    >
      <IconComponent className='size-5' />
    </span>
  );
}

function StatCard({
  label,
  value,
  href,
  trend,
  icon,
  sparkline,
  footer
}: {
  label: string;
  value: React.ReactNode;
  href?: RouteTarget;
  trend?: { direction: 'up' | 'down'; label: string };
  icon?: { icon: Icon; className: string };
  sparkline?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const card = (
    <Card className='@container/card h-full'>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className='text-2xl font-semibold tabular-nums'>{value}</CardTitle>
        {trend && (
          <CardAction>
            <Badge variant='outline'>
              {trend.direction === 'up' ? <Icons.trendingUp /> : <Icons.trendingDown />}
              {trend.label}
            </Badge>
          </CardAction>
        )}
        {icon && !trend && (
          <CardAction>
            <StatIcon icon={icon.icon} className={icon.className} />
          </CardAction>
        )}
      </CardHeader>
      {footer && (
        <CardFooter className='flex-col items-start gap-2 text-sm'>
          {sparkline}
          <div className='text-muted-foreground'>{footer}</div>
        </CardFooter>
      )}
    </Card>
  );

  return href ? <FocusableLink to={href}>{card}</FocusableLink> : card;
}

/**
 * Compact per-category distribution strip for a `StatCard` footer — the
 * "watched items by state" / "events by type (24h)" breakdowns, derived
 * in-process from rows the overview query already fetched (loxep-759). Zero
 * segments (an empty breakdown) renders nothing, matching
 * `StackedStatusBar`'s own zero-total behavior.
 */
function BreakdownBar({
  entries,
  labelOf,
  colorOf
}: {
  entries: MarketOverviewBreakdownEntryDto[];
  labelOf: (key: string) => string;
  colorOf: (key: string) => string;
}) {
  if (entries.length === 0) return null;
  return (
    <StackedStatusBar
      segments={entries.map((entry) => ({
        key: entry.key,
        label: labelOf(entry.key),
        count: entry.count,
        color: colorOf(entry.key)
      }))}
    />
  );
}

/** Minimal hourly sparkline embedded in a KPI tile — no axis/tooltip, the number above already carries the value. */
function TileSparkline({
  data,
  config,
  gradientId
}: {
  data: MarketOverviewTrendBucketDto[];
  config: ChartConfig;
  gradientId: string;
}) {
  return (
    <ChartContainer config={config} className='aspect-auto h-8 w-full'>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1='0' y1='0' x2='0' y2='1'>
            <stop offset='5%' stopColor='var(--color-count)' stopOpacity={0.4} />
            <stop offset='95%' stopColor='var(--color-count)' stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <Area
          dataKey='count'
          type='monotone'
          stroke='var(--color-count)'
          fill={`url(#${gradientId})`}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

/**
 * Highest-scoring rule-stamped event gets its own card shape: no fabricated
 * CardAction trend (there is no prior-period score to diff against), and an
 * `Empty` composition — instead of a de-styled `CardTitle` — when no rule has
 * stamped a scored event yet. `EmptyContent`'s primary-action slot is
 * intentionally unused here: the whole tile is already a `<Link>`, and an
 * interactive element cannot nest inside an `<a>`.
 *
 * Its own band (paired with `EventsTrendCard`), not the KPI row — a
 * title/score/item-name card is naturally taller than a numeric tile and
 * previously stretched every sibling in the row to match it.
 */
function TopOpportunityCard({ topOpportunity }: { topOpportunity: TopOpportunityDto | null }) {
  const card = topOpportunity ? (
    <Card className='@container/card h-full'>
      <CardHeader>
        <CardDescription>Top opportunity</CardDescription>
        <CardTitle className='text-2xl font-semibold tabular-nums'>
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

const newListingsTrendChartConfig = {
  count: {
    label: 'New listings',
    color: 'var(--chart-2)'
  }
} satisfies ChartConfig;

/** Compares the trailing vs. leading half of the 24h window — a real, derived signal, not a fabricated one. */
function trendBadge(
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

/** Hourly event-count chart for the trailing 24h. */
function EventsTrendCard({ trend }: { trend: MarketOverviewTrendBucketDto[] }) {
  const hasData = trend.some((bucket) => bucket.count > 0);

  return (
    <Card className='h-full'>
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
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-32 w-full' />
        ))}
      </div>
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        <Skeleton className='h-40 w-full' />
        <Skeleton className='h-40 w-full' />
      </div>
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
          'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4',
          '[&_[data-slot=card]]:bg-gradient-to-t [&_[data-slot=card]]:from-primary/5 [&_[data-slot=card]]:to-card [&_[data-slot=card]]:shadow-xs dark:[&_[data-slot=card]]:bg-card'
        )}
      >
        <StatCard
          label='Active monitors'
          value={formatQuantity(data.activeMonitorCount)}
          icon={{ icon: Icons.radar, className: 'bg-chart-3/15 text-chart-3' }}
          footer='Currently enabled monitor targets'
        />
        <StatCard
          label='Watched items'
          value={formatQuantity(data.watchedItemCount)}
          icon={{ icon: Icons.eye, className: 'bg-chart-4/15 text-chart-4' }}
          footer={
            <div className='flex w-full flex-col gap-1.5'>
              <span>Marketplace items linked to your monitors</span>
              <BreakdownBar
                entries={data.watchedItemStateBreakdown}
                labelOf={marketItemStateLabel}
                colorOf={marketItemStateBarColor}
              />
            </div>
          }
        />
        <StatCard
          label='Events (last 24h)'
          value={formatQuantity(data.eventsLast24hCount)}
          trend={trendBadge(data.eventsTrend)}
          sparkline={
            <TileSparkline
              data={data.eventsTrend}
              config={eventsTrendChartConfig}
              gradientId='stat-events-sparkline'
            />
          }
          footer={
            <div className='flex w-full flex-col gap-1.5'>
              <span>Derived market events, across every item</span>
              <BreakdownBar
                entries={data.eventTypeBreakdown24h}
                labelOf={marketEventTypeLabel}
                colorOf={marketEventTypeBarColor}
              />
            </div>
          }
        />
        <StatCard
          label='New listings (24h)'
          value={formatQuantity(data.newListingCount24h)}
          href='/market/searches'
          trend={trendBadge(data.newListingsTrend)}
          sparkline={
            <TileSparkline
              data={data.newListingsTrend}
              config={newListingsTrendChartConfig}
              gradientId='stat-new-listings-sparkline'
            />
          }
          footer='From search & seller discovery monitors'
        />
      </div>

      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        <TopOpportunityCard topOpportunity={data.topOpportunity} />
        <EventsTrendCard trend={data.eventsTrend} />
      </div>

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

/**
 * Reads the suspense-cached query populated by the route `loader`'s
 * `ensureQueryData` — see Frontend Standards, "Loading" for the pattern this
 * route is the reference implementation of. `<Suspense>` in `MarketOverview`
 * below is defence-in-depth for the (rare) case this mounts without the
 * loader having run first, not the primary loading path.
 */
function OverviewData() {
  const { data } = useSuspenseQuery(marketOverviewQuery);
  return <OverviewContent data={data} />;
}

function MarketOverview() {
  return (
    <MarketPage
      title='Market'
      description='Monitor targets, watched items, and derived market events.'
    >
      <React.Suspense fallback={<OverviewSkeleton />}>
        <OverviewData />
      </React.Suspense>
    </MarketPage>
  );
}

function MarketOverviewError({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <MarketPage
      title='Market'
      description='Monitor targets, watched items, and derived market events.'
    >
      <Alert variant='destructive'>
        <AlertTitle>Market overview unavailable</AlertTitle>
        <AlertDescription className='flex flex-col items-start gap-2'>
          <span>{error instanceof Error ? error.message : 'Unknown error'}</span>
          <Button variant='outline' size='sm' onClick={() => void router.invalidate()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </MarketPage>
  );
}
