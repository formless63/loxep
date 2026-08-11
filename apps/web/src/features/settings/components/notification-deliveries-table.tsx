import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import type { NotificationDeliveryDto } from '@/server/admin-functions';
import { notificationDeliveriesQuery } from '@/features/settings/api/queries';
import { deliveryStatusLabel, marketEventTypeLabel } from '@/features/settings/constants';

function statusVariant(status: string): 'secondary' | 'outline' | 'destructive' {
  if (status === 'delivered') return 'secondary';
  if (status === 'failed') return 'destructive';
  return 'outline';
}

function formatTimestamp(value: string | null): string {
  return value ? format(new Date(value), 'yyyy-MM-dd HH:mm:ss') : '—';
}

/**
 * Read-only recent delivery attempts (member-readable metadata only, ADR-0017
 * — never token material). Event detection and delivery stay separate
 * concepts; this surfaces the delivery half of that boundary.
 */
export default function NotificationDeliveriesTable() {
  const { data, isPending, isError, error } = useQuery(notificationDeliveriesQuery);

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  if (isError) {
    return (
      <p className='text-destructive text-sm'>
        {error instanceof Error ? error.message : 'Failed to load deliveries'}
      </p>
    );
  }

  const deliveries: NotificationDeliveryDto[] = data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Recent deliveries</CardTitle>
      </CardHeader>
      <CardContent>
        {deliveries.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No deliveries yet</EmptyTitle>
              <EmptyDescription>
                Delivery attempts appear here once matched market events are enqueued to an
                endpoint.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className='overflow-x-auto'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event type</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead>Delivered at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell>{marketEventTypeLabel(delivery.eventType)}</TableCell>
                    <TableCell className='text-muted-foreground'>{delivery.endpointName}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(delivery.status)}>
                        {deliveryStatusLabel(delivery.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className='text-muted-foreground'>{delivery.attemptCount}</TableCell>
                    <TableCell className='text-destructive max-w-xs truncate'>
                      {delivery.lastError ?? '—'}
                    </TableCell>
                    <TableCell className='text-muted-foreground'>
                      {formatTimestamp(delivery.deliveredAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
