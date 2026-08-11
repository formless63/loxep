import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import AvailabilityTimeline from '@/features/market/components/availability-timeline';
import EventHistoryList from '@/features/market/components/event-history-list';
import ItemStateCard from '@/features/market/components/item-state-card';
import { MarketPage } from '@/features/market/components/market-page';
import PriceHistoryChart from '@/features/market/components/price-history-chart';
import { marketItemQuery } from '@/features/market/api/queries';

export const Route = createFileRoute('/market/items/$itemId')({
  component: MarketItemDetail
});

function MarketItemDetail() {
  const { itemId } = Route.useParams();
  const { data: item, isPending, isError, error } = useQuery(marketItemQuery(itemId));

  if (isPending) {
    return (
      <MarketPage title='Item' description='Loading…'>
        <div className='flex flex-col gap-4'>
          <Skeleton className='h-40 w-full' />
          <Skeleton className='h-64 w-full' />
          <Skeleton className='h-64 w-full' />
        </div>
      </MarketPage>
    );
  }

  if (isError || !item) {
    return (
      <MarketPage title='Item' description='This item could not be loaded.'>
        <Alert variant='destructive'>
          <AlertTitle>Item unavailable</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'Unknown error'}
          </AlertDescription>
        </Alert>
      </MarketPage>
    );
  }

  return (
    <MarketPage
      title={item.title ?? item.externalItemId}
      description={`${item.provider}/${item.marketplace} · first seen ${item.firstSeenAt}`}
    >
      <div className='flex flex-col gap-4'>
        <ItemStateCard item={item} />
        <div className='grid grid-cols-1 gap-4 xl:grid-cols-2'>
          <PriceHistoryChart marketplaceItemId={item.id} />
          <AvailabilityTimeline marketplaceItemId={item.id} />
        </div>
        <EventHistoryList marketplaceItemId={item.id} />
      </div>
    </MarketPage>
  );
}
