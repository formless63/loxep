import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { MarketPage } from '@/features/market/components/market-page';
import RecentEventsList from '@/features/market/components/recent-events-list';
import { marketOverviewQuery } from '@/features/market/api/queries';

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardDescription>{label}</CardDescription>
        <CardTitle className='text-3xl'>{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

export const Route = createFileRoute('/market/overview')({
  component: MarketOverview
});

function MarketOverview() {
  const { data, isPending } = useQuery(marketOverviewQuery);

  return (
    <MarketPage
      title='Market'
      description='Monitor targets, watched items, and derived market events.'
    >
      <div className='flex flex-col gap-4'>
        {isPending ? (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
            <Skeleton className='h-24 w-full' />
            <Skeleton className='h-24 w-full' />
            <Skeleton className='h-24 w-full' />
          </div>
        ) : (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
            <StatCard label='Active monitors' value={data?.activeMonitorCount ?? 0} />
            <StatCard label='Watched items' value={data?.watchedItemCount ?? 0} />
            <StatCard label='Events (last 24h)' value={data?.eventsLast24hCount ?? 0} />
          </div>
        )}

        {isPending ? (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
            <Skeleton className='h-24 w-full' />
            <Skeleton className='h-24 w-full' />
          </div>
        ) : (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
            <Link to='/market/searches'>
              <Card className='h-full transition-colors hover:bg-muted/50'>
                <CardHeader className='pb-2'>
                  <CardDescription>New listings (24h)</CardDescription>
                  <CardTitle className='text-3xl'>{data?.newListingCount24h ?? 0}</CardTitle>
                </CardHeader>
              </Card>
            </Link>
            <Link to='/market/opportunities'>
              <Card className='h-full transition-colors hover:bg-muted/50'>
                <CardHeader className='pb-2'>
                  <CardDescription>Top opportunity</CardDescription>
                  {data?.topOpportunity ? (
                    <>
                      <CardTitle className='text-3xl'>
                        {data.topOpportunity.score.toFixed(2)}
                      </CardTitle>
                      <p className='text-muted-foreground truncate text-sm'>
                        {data.topOpportunity.itemTitle ?? data.topOpportunity.marketplaceItemId} —{' '}
                        {data.topOpportunity.ruleName}
                      </p>
                    </>
                  ) : (
                    <CardTitle className='text-muted-foreground text-base font-normal'>
                      No scored opportunities yet
                    </CardTitle>
                  )}
                </CardHeader>
              </Card>
            </Link>
          </div>
        )}

        <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
          <Link to='/market/monitors'>
            <Card className='transition-colors hover:bg-muted/50'>
              <CardHeader>
                <CardTitle className='text-base'>Monitors</CardTitle>
                <CardDescription>
                  What to poll, on what cadence — create, edit, enable/disable eBay item, watchlist,
                  search, and seller monitors.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
          <Link to='/market/items'>
            <Card className='transition-colors hover:bg-muted/50'>
              <CardHeader>
                <CardTitle className='text-base'>Watched items</CardTitle>
                <CardDescription>
                  Marketplace items linked to your monitors, joined with their latest observation.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
          <Link to='/market/searches'>
            <Card className='transition-colors hover:bg-muted/50'>
              <CardHeader>
                <CardTitle className='text-base'>Search &amp; seller monitors</CardTitle>
                <CardDescription>
                  Discovered-item counts and recent new-listing activity per discovery monitor.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
          <Link to='/market/opportunities'>
            <Card className='transition-colors hover:bg-muted/50'>
              <CardHeader>
                <CardTitle className='text-base'>Opportunities</CardTitle>
                <CardDescription>
                  Events stamped and scored by an opportunity rule, ranked and linked to their item.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Recent events</CardTitle>
            <CardDescription>The latest derived market events, across every item.</CardDescription>
          </CardHeader>
          <CardContent>
            {isPending ? (
              <Skeleton className='h-48 w-full' />
            ) : (
              <RecentEventsList events={data?.recentEvents ?? []} />
            )}
          </CardContent>
        </Card>
      </div>
    </MarketPage>
  );
}
