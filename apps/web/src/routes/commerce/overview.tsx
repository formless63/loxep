import type * as React from 'react';
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
  channelListingStatusTone,
  MANUAL_PROVIDER
} from '@/features/commerce/constants';

const CARD_LINK_CLASS =
  'block rounded-xl outline-none focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-[3px] focus-visible:ring-offset-2';

/**
 * Every stat card here links out to the list it counts (loxep-1zg): these
 * were plain, non-clickable numbers while `/market`'s and the dashboard's
 * own KPI tiles already navigate on click.
 *
 * Presentational only — deliberately not wrapping its own `<Link>`; see
 * `/inventory/overview`'s identical `StatCardBody` doc for why a shared
 * wrapper that also owned `to`/`search` mistyped the search shape.
 */
function StatCardBody({
  label,
  value,
  isPending,
  detail
}: {
  label: string;
  value: number;
  isPending: boolean;
  detail?: React.ReactNode;
}) {
  return (
    <Card className='hover:border-primary/50 h-full transition-colors'>
      <CardHeader>
        <CardTitle className='text-sm text-muted-foreground'>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className='h-8 w-16' />
        ) : (
          <>
            <p className='text-2xl font-semibold tabular-nums'>{value}</p>
            {detail}
          </>
        )}
      </CardContent>
    </Card>
  );
}

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
        <Link to='/commerce/orders' className={CARD_LINK_CLASS}>
          <StatCardBody
            label='Orders'
            value={orders?.length ?? 0}
            isPending={ordersPending}
            detail={
              <p className='text-muted-foreground text-xs'>
                {connectorOrderCount} connector-synced · {manualOrderCount} manual
              </p>
            }
          />
        </Link>
        <Link to='/commerce/listings' className={CARD_LINK_CLASS}>
          <StatCardBody
            label='Listings'
            value={listings?.length ?? 0}
            isPending={listingsPending}
          />
        </Link>
        <Link to='/commerce/listings' search={{ status: 'active' }} className={CARD_LINK_CLASS}>
          <StatCardBody
            label='Active listings'
            value={countByStatus.get('active') ?? 0}
            isPending={listingsPending}
          />
        </Link>
        <Link
          to='/commerce/listings'
          search={{ provider: MANUAL_PROVIDER }}
          className={CARD_LINK_CLASS}
        >
          <StatCardBody label='Manual / offline' value={manualCount} isPending={listingsPending} />
        </Link>
        <Link to='/commerce/catalog' className={CARD_LINK_CLASS}>
          <StatCardBody
            label='Catalog items'
            value={catalogItems?.length ?? 0}
            isPending={catalogPending}
          />
        </Link>
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
              <Link
                key={option.value}
                to='/commerce/listings'
                search={{ status: option.value }}
                className='focus-visible:ring-ring rounded-full outline-none focus-visible:ring-[3px]'
              >
                <Badge
                  variant={channelListingStatusTone(option.value)}
                  className='hover:opacity-80 cursor-pointer'
                >
                  {channelListingStatusLabel(option.value)}: {countByStatus.get(option.value) ?? 0}
                </Badge>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </CommercePage>
  );
}
