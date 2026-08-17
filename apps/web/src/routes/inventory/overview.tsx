import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import { acquisitionsQuery, inventoryItemsQuery } from '@/features/inventory/api/queries';
import { itemStatusLabel, itemStatusOptions, itemStatusTone } from '@/features/inventory/constants';

const CARD_LINK_CLASS =
  'block rounded-xl outline-none focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-[3px] focus-visible:ring-offset-2';

/**
 * Every stat card here links out to the list it counts (loxep-1zg): these
 * were plain, non-clickable numbers while `/market`'s and the dashboard's
 * own KPI tiles already navigate on click — an inconsistency with no reason
 * behind it, since the destination list always already exists.
 *
 * Presentational only — deliberately not wrapping its own `<Link>`. TanStack
 * Router's `Link` is generic over its destination route, and a shared
 * wrapper component that also accepted `to`/`search` props would type them
 * against a collapsed, overly-loose default instead of the real per-route
 * search schema (tried first; every `search={...}` call site failed
 * typecheck). Each call site below wraps this in its own literal `<Link
 * to='...'>` instead, so `to` and `search` stay correctly correlated.
 */
function StatCardBody({
  label,
  value,
  isPending
}: {
  label: string;
  value: number;
  isPending: boolean;
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
          <p className='text-2xl font-semibold tabular-nums'>{value}</p>
        )}
      </CardContent>
    </Card>
  );
}

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
        <Link to='/inventory/stock' className={CARD_LINK_CLASS}>
          <StatCardBody label='Stock rows' value={items?.length ?? 0} isPending={itemsPending} />
        </Link>
        <Link to='/inventory/stock' search={{ status: 'intake' }} className={CARD_LINK_CLASS}>
          <StatCardBody
            label='Intake pending review'
            value={itemCountByStatus.get('intake') ?? 0}
            isPending={itemsPending}
          />
        </Link>
        <Link to='/inventory/acquisitions' className={CARD_LINK_CLASS}>
          <StatCardBody
            label='Acquisitions'
            value={acquisitions?.length ?? 0}
            isPending={acquisitionsPending}
          />
        </Link>
        {/*
          "Open lots" (costAllocationStatus !== 'final') has no equivalent
          server-side filter on `/inventory/acquisitions` — only `status`/
          `sourceKind`/`connectionId` are filterable there — so this links to
          the unfiltered list rather than fabricating a query param the list
          can't honor.
        */}
        <Link to='/inventory/acquisitions' className={CARD_LINK_CLASS}>
          <StatCardBody label='Open lots' value={openLotCount} isPending={acquisitionsPending} />
        </Link>
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
              <Link
                key={option.value}
                to='/inventory/stock'
                search={{ status: option.value }}
                className='focus-visible:ring-ring rounded-full outline-none focus-visible:ring-[3px]'
              >
                <Badge
                  variant={itemStatusTone(option.value)}
                  className='hover:opacity-80 cursor-pointer'
                >
                  {itemStatusLabel(option.value)}: {itemCountByStatus.get(option.value) ?? 0}
                </Badge>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </InventoryPage>
  );
}
