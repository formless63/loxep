import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { marketItemsQuery, monitorsQuery } from '@/features/market/api/queries';
import { ANY_MONITOR_VALUE } from '@/features/market/constants';

function formatTimestamp(value: string | null): string {
  return value ? format(new Date(value), 'yyyy-MM-dd HH:mm') : '—';
}

function formatPrice(price: string | null, currency: string | null): string {
  if (price === null) return '—';
  return currency ? `${price} ${currency}` : price;
}

export default function ItemsTable() {
  const [page, setPage] = React.useState(0);
  const [monitorTargetId, setMonitorTargetId] = React.useState<string>(ANY_MONITOR_VALUE);

  const { data: monitors } = useQuery(monitorsQuery);
  const filterValue = monitorTargetId === ANY_MONITOR_VALUE ? null : monitorTargetId;
  const { data, isPending } = useQuery(marketItemsQuery({ page, monitorTargetId: filterValue }));

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 25;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const handleFilterChange = (value: string) => {
    setMonitorTargetId(value);
    setPage(0);
  };

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <Select value={monitorTargetId} onValueChange={handleFilterChange}>
          <SelectTrigger size='sm' className='min-w-48'>
            <SelectValue placeholder='All monitors' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_MONITOR_VALUE}>All monitors</SelectItem>
            {(monitors ?? []).map((monitor) => (
              <SelectItem key={monitor.id} value={monitor.id}>
                {monitor.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            Previous
          </Button>
          <span className='text-muted-foreground text-sm'>
            Page {page + 1} of {pageCount}
          </span>
          <Button
            size='sm'
            variant='outline'
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      {isPending ? (
        <Skeleton className='h-64 w-full' />
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No watched items</EmptyTitle>
            <EmptyDescription>
              Items appear here once live polling records observations for a monitor. Until then —
              or with the selected monitor filter — this list is empty.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className='overflow-x-auto'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Availability</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Listing state</TableHead>
                <TableHead>Last observed</TableHead>
                <TableHead>Monitors</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link
                      to='/market/items/$itemId'
                      params={{ itemId: item.id }}
                      className='font-medium hover:underline'
                    >
                      {item.title ?? item.externalItemId}
                    </Link>
                    <div className='text-muted-foreground text-xs'>
                      {item.provider}/{item.marketplace} · {item.externalItemId}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant='outline'>{item.currentState}</Badge>
                  </TableCell>
                  <TableCell>
                    {formatPrice(
                      item.latestObservation?.price ?? null,
                      item.latestObservation?.currency ?? null
                    )}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {item.latestObservation?.availability ?? '—'}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {item.latestObservation?.quantityAvailable ?? '—'}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {item.latestObservation?.listingState ?? '—'}
                  </TableCell>
                  <TableCell className='text-muted-foreground'>
                    {formatTimestamp(item.latestObservation?.observedAt ?? null)}
                  </TableCell>
                  <TableCell>
                    {item.monitors.length === 0 ? (
                      <span className='text-muted-foreground'>—</span>
                    ) : (
                      <div className='flex flex-wrap gap-1'>
                        {item.monitors.map((monitor) => (
                          <Badge key={monitor.id} variant='outline'>
                            {monitor.name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
