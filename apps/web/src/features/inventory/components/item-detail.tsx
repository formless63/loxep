import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { formatDate, formatDateTime, formatMoney, formatQuantity, formatScore } from '@/lib/format';
import { inventoryItemQuery } from '@/features/inventory/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import {
  itemConditionLabel,
  itemStatusLabel,
  itemStatusTone,
  movementIsInbound,
  movementKindLabel
} from '@/features/inventory/constants';

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-muted-foreground text-xs'>{label}</span>
      <span className='text-sm'>{children}</span>
    </div>
  );
}

export default function ItemDetail({ itemId }: { itemId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(inventoryItemQuery(itemId));

  if (isPending) {
    return <div className='text-muted-foreground text-sm'>Loading…</div>;
  }

  if (isError) {
    return <QueryErrorAlert error={error} title='Could not load item' onRetry={() => refetch()} />;
  }

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader className='flex flex-row items-start justify-between gap-2'>
          <div>
            <CardTitle className='flex items-center gap-2 text-xl'>
              {data.itemCode}
              <Badge variant={itemStatusTone(data.status)}>{itemStatusLabel(data.status)}</Badge>
            </CardTitle>
            <p className='text-muted-foreground text-sm'>{data.label}</p>
          </div>
        </CardHeader>
        <CardContent className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
          <DetailRow label='Condition'>
            {itemConditionLabel(data.conditionCode)}
            {data.gradeLabel && (
              <span className='text-muted-foreground'>
                {' '}
                ({data.gradingAuthority} {data.gradeLabel})
              </span>
            )}
          </DetailRow>
          <DetailRow label='Location'>
            {data.locationCode ? `${data.locationCode} — ${data.locationName}` : '—'}
          </DetailRow>
          <DetailRow label='Quantity on hand'>
            {formatQuantity(Number(data.quantityOnHand))} / {formatQuantity(Number(data.quantity))}
          </DetailRow>
          <DetailRow label='Available to sell'>
            {formatQuantity(Number(data.availableToSell))}
          </DetailRow>
          <DetailRow label='Acquisition cost'>
            {formatMoney(data.acquisitionCostAmount, data.currency)}
          </DetailRow>
          <DetailRow label='Landed cost'>
            {formatMoney(data.landedCostAmount, data.currency)}
          </DetailRow>
          <DetailRow label='Estimated value'>
            {formatMoney(data.estimatedValueAmount, data.currency)}
            <span className='text-muted-foreground'> (target resale, not a valuation)</span>
          </DetailRow>
          <DetailRow label='Cost basis'>
            {data.costBasisLockedAt ? (
              <span className='inline-flex items-center gap-1'>
                <Icons.lock className='size-3.5' />
                Locked {formatDate(data.costBasisLockedAt)}
              </span>
            ) : (
              'Open'
            )}
          </DetailRow>
          <DetailRow label='Lot'>
            {data.acquisitionId ? (
              <Link
                to='/inventory/acquisitions/$id'
                params={{ id: data.acquisitionId }}
                className='hover:underline'
              >
                {data.acquisitionReferenceCode}
              </Link>
            ) : (
              '—'
            )}
          </DetailRow>
          <DetailRow label='Acquired'>{formatDate(data.acquiredAt)}</DetailRow>
          <DetailRow label='Received'>
            {data.receivedAt ? formatDate(data.receivedAt) : '—'}
          </DetailRow>
          <DetailRow label='Listed'>
            {data.listedAt ? formatDate(data.listedAt) : 'Not listed'}
          </DetailRow>
          {data.serialNumber && <DetailRow label='Serial'>{data.serialNumber}</DetailRow>}
          {data.lotReference && <DetailRow label='Lot reference'>{data.lotReference}</DetailRow>}
          {data.conditionNotes && (
            <DetailRow label='Condition notes'>{data.conditionNotes}</DetailRow>
          )}
        </CardContent>
      </Card>

      {data.sourcedFrom.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Sourced from /market</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-2'>
            {data.sourcedFrom.map((link) => (
              <div key={link.id} className='flex flex-wrap items-center gap-2 text-sm'>
                <Badge variant='secondary'>{link.linkKind.replace(/_/g, ' ')}</Badge>
                {link.marketplaceItemId ? (
                  <Link
                    to='/market/items/$itemId'
                    params={{ itemId: link.marketplaceItemId }}
                    className='hover:underline'
                  >
                    {link.marketplaceItemTitle ?? link.marketplaceItemId}
                  </Link>
                ) : (
                  <span className='text-muted-foreground'>—</span>
                )}
                {link.scoreAtLink && (
                  <span className='text-muted-foreground'>
                    score {formatScore(Number(link.scoreAtLink))} at link time
                  </span>
                )}
                <span className='text-muted-foreground text-xs'>
                  {formatDateTime(link.linkedAt)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Movements</CardTitle>
        </CardHeader>
        <CardContent>
          {data.movements.length === 0 ? (
            <p className='text-muted-foreground text-sm'>No movements recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead className='text-right'>Quantity</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Occurred</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.movements.map((movement) => (
                  <TableRow key={movement.id}>
                    <TableCell>
                      <Badge
                        variant={movementIsInbound(movement.movementKind) ? 'success' : 'outline'}
                      >
                        {movementKindLabel(movement.movementKind)}
                      </Badge>
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {formatQuantity(Number(movement.quantity))}
                    </TableCell>
                    <TableCell className='text-muted-foreground'>
                      {movement.locationCode ?? '—'}
                    </TableCell>
                    <TableCell className='text-muted-foreground'>
                      {movement.reasonCode ?? '—'}
                    </TableCell>
                    <TableCell className='text-muted-foreground tabular-nums'>
                      {formatDateTime(movement.occurredAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
