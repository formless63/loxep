import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CommercePage } from '@/features/commerce/components/commerce-page';
import { catalogItemsQuery, channelListingsQuery } from '@/features/commerce/api/queries';
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

  const countByStatus = new Map<string, number>();
  let manualCount = 0;
  for (const listing of listings ?? []) {
    countByStatus.set(listing.status, (countByStatus.get(listing.status) ?? 0) + 1);
    if (listing.provider === MANUAL_PROVIDER) manualCount += 1;
  }

  return (
    <CommercePage
      title='Overview'
      description='Catalog items, channel listings, and manual/offline sales — Orders (connector-synced) land here in a later milestone.'
    >
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4'>
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
