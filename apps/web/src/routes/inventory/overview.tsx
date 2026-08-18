import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StackedStatusBar } from '@/components/ui/stacked-status-bar';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import { acquisitionsQuery, inventoryItemsQuery } from '@/features/inventory/api/queries';
import {
  itemStatusBarColor,
  itemStatusLabel,
  itemStatusOptions,
  itemStatusTone
} from '@/features/inventory/constants';
import { sumMoneyBy } from '@/lib/aggregate';
import { formatMoney } from '@/lib/format';

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

  /**
   * "Value on shelves right now" (loxep-759). Zero new query:
   * `landedCostAmount` / `estimatedValueAmount` / `currency` /
   * `quantityOnHand` are already on every row `inventoryItemsQuery({})`
   * fetches above for the "Stock rows"/"Intake pending review" tiles.
   *
   * "On shelves" = actually holding units, per the domain rule that
   * quantity is the authority and `status` is only a convenience label
   * (`packages/db/src/schema/inventory.ts`'s `ITEM_STATUSES` doc) — a
   * `written_off`/`archived`/`depleted` row with zero `quantityOnHand`
   * contributes nothing to shelf value even though its cost row still
   * exists.
   *
   * Grouped by currency via `sumMoneyBy` — money is NEVER summed across
   * currencies, so a multi-currency shelf renders one total per currency
   * instead of one meaningless combined figure.
   */
  const onShelfItems = (items ?? []).filter((item) => Number(item.quantityOnHand) > 0);
  const shelfCostByCurrency = sumMoneyBy(
    onShelfItems,
    (item) => item.landedCostAmount,
    (item) => item.currency
  );
  // `estimatedValueAmount` is nullable (a market-value opinion, not a cost)
  // — shown as a secondary muted line per currency when present, since it
  // costs nothing extra to surface alongside the authoritative landed-cost
  // figure.
  const shelfEstimatedByCurrency = sumMoneyBy(
    onShelfItems,
    (item) => item.estimatedValueAmount,
    (item) => item.currency
  );

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
          <CardTitle className='text-base'>Value on shelves right now</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          {itemsPending ? (
            <Skeleton className='h-8 w-32' />
          ) : shelfCostByCurrency.size === 0 ? (
            <p className='text-muted-foreground text-sm'>No stock currently on hand.</p>
          ) : (
            <div className='flex flex-wrap gap-6'>
              {[...shelfCostByCurrency].map(([currency, amount]) => (
                <div key={currency}>
                  <p className='text-2xl font-semibold tabular-nums'>
                    {formatMoney(amount, currency)}
                  </p>
                  {shelfEstimatedByCurrency.has(currency) && (
                    <p className='text-muted-foreground text-xs'>
                      est. value {formatMoney(shelfEstimatedByCurrency.get(currency), currency)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className='text-muted-foreground text-sm'>
            Landed cost of every row with quantity on hand, one total per currency.{' '}
            <Link to='/inventory/profitability' className='underline-offset-2 hover:underline'>
              See aging by days-since-acquired
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Stock by status</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          {itemsPending ? (
            <Skeleton className='h-6 w-full' />
          ) : (
            <>
              <StackedStatusBar
                segments={itemStatusOptions.map((option) => ({
                  key: option.value,
                  label: option.label,
                  count: itemCountByStatus.get(option.value) ?? 0,
                  color: itemStatusBarColor(option.value)
                }))}
              />
              <div className='flex flex-wrap gap-2'>
                {itemStatusOptions.map((option) => (
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
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </InventoryPage>
  );
}
