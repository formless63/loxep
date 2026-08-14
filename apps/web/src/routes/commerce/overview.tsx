import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { CommercePage } from '@/features/commerce/components/commerce-page';
import {
  catalogItemsQuery,
  channelListingsQuery,
  ordersQuery
} from '@/features/commerce/api/queries';
import {
  channelListingStatusLabel,
  channelListingStatusOptions,
  MANUAL_PROVIDER
} from '@/features/commerce/constants';

export const Route = createFileRoute('/commerce/overview')({
  component: CommerceOverview
});

function CommerceOverview() {
  const { data: listings, isPending: listingsPending } = useQuery(channelListingsQuery({}));
  const { data: catalogItems, isPending: catalogPending } = useQuery(catalogItemsQuery);
  const { data: orders, isPending: ordersPending } = useQuery(ordersQuery({}));

  const countByStatus = new Map<string, number>();
  let manualCount = 0;
  for (const listing of listings ?? []) {
    countByStatus.set(listing.status, (countByStatus.get(listing.status) ?? 0) + 1);
    if (listing.provider === MANUAL_PROVIDER) manualCount += 1;
  }

  const manualOrderCount = (orders ?? []).filter((order) => order.isManual).length;
  const connectorOrderCount = (orders ?? []).length - manualOrderCount;

  return (
    <CommercePage
      title='Overview'
      description='Catalog items, channel listings, and orders — connector-synced and manually recorded alike.'
    >
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5'>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm text-muted-foreground'>Orders</CardTitle>
          </CardHeader>
          <CardContent>
            {ordersPending ? (
              <Skeleton className='h-8 w-16' />
            ) : (
              <>
                <p className='text-3xl font-semibold tabular-nums'>{orders?.length ?? 0}</p>
                <p className='text-muted-foreground text-xs'>
                  {connectorOrderCount} connector-synced · {manualOrderCount} manual
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm text-muted-foreground'>Listings</CardTitle>
          </CardHeader>
          <CardContent>
            {listingsPending ? (
              <Skeleton className='h-8 w-16' />
            ) : (
              <p className='text-3xl font-semibold tabular-nums'>{listings?.length ?? 0}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm text-muted-foreground'>Active listings</CardTitle>
          </CardHeader>
          <CardContent>
            {listingsPending ? (
              <Skeleton className='h-8 w-16' />
            ) : (
              <p className='text-3xl font-semibold tabular-nums'>
                {countByStatus.get('active') ?? 0}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm text-muted-foreground'>Manual / offline</CardTitle>
          </CardHeader>
          <CardContent>
            {listingsPending ? (
              <Skeleton className='h-8 w-16' />
            ) : (
              <p className='text-3xl font-semibold tabular-nums'>{manualCount}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm text-muted-foreground'>Catalog items</CardTitle>
          </CardHeader>
          <CardContent>
            {catalogPending ? (
              <Skeleton className='h-8 w-16' />
            ) : (
              <p className='text-3xl font-semibold tabular-nums'>{catalogItems?.length ?? 0}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Link
        to='/commerce/orders'
        className='text-primary focus-visible:ring-ring inline-flex w-fit items-center gap-1 rounded-md text-sm hover:underline focus-visible:ring-2 focus-visible:outline-none'
      >
        <Icons.orders className='size-4' />
        View every order
        <Icons.arrowRight className='size-3.5' />
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Listings by status</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-wrap gap-2'>
          {listingsPending ? (
            <Skeleton className='h-6 w-full' />
          ) : (
            channelListingStatusOptions.map((option) => (
              <Badge key={option.value} variant='outline'>
                {channelListingStatusLabel(option.value)}: {countByStatus.get(option.value) ?? 0}
              </Badge>
            ))
          )}
        </CardContent>
      </Card>
    </CommercePage>
  );
}
