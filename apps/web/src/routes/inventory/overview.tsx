import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import { acquisitionsQuery, inventoryItemsQuery } from '@/features/inventory/api/queries';
import { itemStatusLabel, itemStatusOptions } from '@/features/inventory/constants';

export const Route = createFileRoute('/inventory/overview')({
  component: InventoryOverview
});

function InventoryOverview() {
  const { data: items, isPending: itemsPending } = useQuery(inventoryItemsQuery({}));
  const { data: acquisitions, isPending: acquisitionsPending } = useQuery(acquisitionsQuery({}));

  const itemCountByStatus = new Map<string, number>();
  for (const item of items ?? []) {
    itemCountByStatus.set(item.status, (itemCountByStatus.get(item.status) ?? 0) + 1);
  }
  const openLotCount = (acquisitions ?? []).filter(
    (acquisition) => acquisition.costAllocationStatus !== 'final'
  ).length;

  return (
    <InventoryPage
      title='Overview'
      description='Stock, lots, and where sourcing spend has landed — read straight off the shipped Phase 4 tables.'
    >
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm text-muted-foreground'>Stock rows</CardTitle>
          </CardHeader>
          <CardContent>
            {itemsPending ? (
              <Skeleton className='h-8 w-16' />
            ) : (
              <p className='text-3xl font-semibold tabular-nums'>{items?.length ?? 0}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm text-muted-foreground'>Intake pending review</CardTitle>
          </CardHeader>
          <CardContent>
            {itemsPending ? (
              <Skeleton className='h-8 w-16' />
            ) : (
              <p className='text-3xl font-semibold tabular-nums'>
                {itemCountByStatus.get('intake') ?? 0}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm text-muted-foreground'>Acquisitions</CardTitle>
          </CardHeader>
          <CardContent>
            {acquisitionsPending ? (
              <Skeleton className='h-8 w-16' />
            ) : (
              <p className='text-3xl font-semibold tabular-nums'>{acquisitions?.length ?? 0}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm text-muted-foreground'>Open lots</CardTitle>
          </CardHeader>
          <CardContent>
            {acquisitionsPending ? (
              <Skeleton className='h-8 w-16' />
            ) : (
              <p className='text-3xl font-semibold tabular-nums'>{openLotCount}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Stock by status</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-wrap gap-2'>
          {itemsPending ? (
            <Skeleton className='h-6 w-full' />
          ) : (
            itemStatusOptions.map((option) => (
              <Badge key={option.value} variant='outline'>
                {itemStatusLabel(option.value)}: {itemCountByStatus.get(option.value) ?? 0}
              </Badge>
            ))
          )}
        </CardContent>
      </Card>
    </InventoryPage>
  );
}
