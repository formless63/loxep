import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { InventoryPage } from '@/features/inventory/components/inventory-page';
import { inventoryItemsQuery, inventoryLocationsQuery } from '@/features/inventory/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { locationKindLabel } from '@/features/inventory/constants';
import {
  AddLocationDialog,
  MoveLocationDialog
} from '@/features/inventory/components/location-dialogs';
import { sumMoneyBy } from '@/lib/aggregate';
import { formatMoney, formatQuantity } from '@/lib/format';
import type { InventoryLocationDto } from '@/server/inventory-functions';

export const Route = createFileRoute('/inventory/locations')({
  component: InventoryLocations
});

/**
 * The location tree, indented by depth. A plain `<Table>` rather than
 * `DataTable`: `path` already orders it correctly and this is a hierarchy
 * display, not a flat sortable/filterable list (Frontend Standards'
 * "Non-data uses of `<Table>`", same reasoning as `EventHistoryList`'s
 * payload-delta table).
 */
function InventoryLocations() {
  const { data, isPending, isError, error, refetch } = useQuery(inventoryLocationsQuery);
  /**
   * loxep-759: per-location item count + cost. This IS a new bounded query
   * on this route, not a free read of another route's cache — a mount of
   * `/inventory/locations` does not automatically have `/inventory/stock`'s
   * query data in memory; TanStack Query caches are keyed per `queryKey`,
   * not shared just because two routes happen to fetch the same shape.
   *
   * It reuses `inventoryItemsQuery({})` — the exact `['inventory','items',{}]`
   * key `/inventory/overview` and an unfiltered `/inventory/stock` both use
   * — deliberately: on a warm cache (navigated from either of those) this
   * costs nothing extra; on a cold direct hit to this route it is ONE
   * additional server round trip, bounded by the same `ITEM_LIST_LIMIT =
   * 1000` those routes already accept (`inventory-functions.ts`), not an
   * unbounded new read.
   */
  const { data: items } = useQuery(inventoryItemsQuery({}));
  const [addOpen, setAddOpen] = React.useState(false);
  const [moveTarget, setMoveTarget] = React.useState<InventoryLocationDto | null>(null);

  const itemsByLocation = new Map<string, NonNullable<typeof items>>();
  for (const item of items ?? []) {
    if (item.locationId === null) continue;
    const bucket = itemsByLocation.get(item.locationId);
    if (bucket) bucket.push(item);
    else itemsByLocation.set(item.locationId, [item]);
  }

  return (
    <InventoryPage
      title='Locations'
      description='Where stock physically is — a tree, not a warehouse management system.'
      actions={
        <Button size='sm' onClick={() => setAddOpen(true)}>
          <Icons.add />
          Add location
        </Button>
      }
    >
      {isPending ? (
        <Skeleton className='h-64 w-full' />
      ) : isError ? (
        <QueryErrorAlert error={error} title='Could not load locations' onRetry={() => refetch()} />
      ) : data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.workspace />
            </EmptyMedia>
            <EmptyTitle>No locations yet</EmptyTitle>
            <EmptyDescription>
              Sites, rooms, shelves, bins — as fine-grained as your operation needs, and no finer.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size='sm' onClick={() => setAddOpen(true)}>
              <Icons.add />
              Add location
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Location</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className='text-right'>Items</TableHead>
              <TableHead className='text-right'>Landed cost</TableHead>
              <TableHead className='w-10' />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((location) => {
              const locationItems = itemsByLocation.get(location.id) ?? [];
              const costByCurrency = sumMoneyBy(
                locationItems,
                (item) => item.landedCostAmount,
                (item) => item.currency
              );
              return (
                <TableRow key={location.id}>
                  <TableCell style={{ paddingLeft: `${location.depth * 1.5 + 1}rem` }}>
                    {location.name}
                    {location.isDefault && (
                      <Badge variant='secondary' className='ml-2'>
                        Default
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {locationKindLabel(location.kind)}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>{location.code}</TableCell>
                  <TableCell>
                    <Badge variant={location.active ? 'success' : 'outline'}>
                      {location.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {formatQuantity(locationItems.length)}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {costByCurrency.size === 0
                      ? '—'
                      : [...costByCurrency]
                          .map(([currency, amount]) => formatMoney(amount, currency))
                          .join(', ')}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='size-8'
                          aria-label={`Actions for ${location.name}`}
                        >
                          <Icons.ellipsis />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        <DropdownMenuItem onSelect={() => setMoveTarget(location)}>
                          Move to parent…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <AddLocationDialog open={addOpen} onOpenChange={setAddOpen} locations={data ?? []} />
      <MoveLocationDialog
        open={moveTarget !== null}
        onOpenChange={(next) => {
          if (!next) setMoveTarget(null);
        }}
        location={moveTarget}
        locations={data ?? []}
      />
    </InventoryPage>
  );
}
