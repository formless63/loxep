import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
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
import { inventoryLocationsQuery } from '@/features/inventory/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { locationKindLabel } from '@/features/inventory/constants';

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

  return (
    <InventoryPage
      title='Locations'
      description='Where stock physically is — a tree, not a warehouse management system.'
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
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Location</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((location) => (
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </InventoryPage>
  );
}
