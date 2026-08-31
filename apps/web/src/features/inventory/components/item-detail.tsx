import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatDate, formatDateTime, formatMoney, formatQuantity, formatScore } from '@/lib/format';
import { inventoryItemQuery } from '@/features/inventory/api/queries';
import InventoryItemListingsPanel from '@/features/commerce/components/inventory-item-listings-panel';
import ImageGallery from '@/features/inventory/components/image-gallery';
import ItemAllocationsTable from '@/features/inventory/components/item-allocations-table';
import ReleaseStaleHoldsButton from '@/features/inventory/components/release-stale-holds-button';
import ItemEnrichmentPanel from '@/features/inventory/components/item-enrichment-panel';
import SpecificsEditor from '@/features/inventory/components/specifics-editor';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { completeItemIntakeReview } from '@/server/inventory-functions';
import { RecordMovementDialog } from '@/features/inventory/components/movement-dialogs';
import {
  MoveItemLocationDialog,
  SetItemConditionDialog,
  TransferItemEntityDialog
} from '@/features/inventory/components/item-action-dialogs';
import {
  itemConditionLabel,
  itemStatusLabel,
  itemStatusTone,
  movementIsInbound,
  movementKindLabel
} from '@/features/inventory/constants';

/**
 * `acquisition_opportunity_links.link_kind` (loxep-759) — closed, `CHECK`ed
 * (`OPPORTUNITY_LINK_KINDS`, `packages/db/src/schema/inventory.ts`): mirrors
 * `acquisition-detail.tsx`'s identical helper — `sourced_from` means the
 * observation drove the purchase, `evaluated_against` means we priced our
 * decision using it, `comparable` means it is a reference point found later,
 * unrelated to why we bought.
 */
const OPPORTUNITY_LINK_KIND_LABELS: Record<string, string> = {
  sourced_from: 'Sourced from',
  evaluated_against: 'Priced against',
  comparable: 'Comparable (found later)'
};

function opportunityLinkKindLabel(kind: string): string {
  return OPPORTUNITY_LINK_KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

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
  const queryClient = useQueryClient();
  const [recordOpen, setRecordOpen] = React.useState(false);
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [conditionOpen, setConditionOpen] = React.useState(false);
  const [transferOpen, setTransferOpen] = React.useState(false);

  const completeReviewMutation = useMutation({
    mutationFn: () => completeItemIntakeReview({ data: { id: itemId } }),
    onSuccess: () => {
      toast.success('Marked available');
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => toastError(error, 'Could not complete review')
  });

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
          <div className='flex items-center gap-2'>
            {data.status === 'intake' && (
              <Button
                size='sm'
                disabled={completeReviewMutation.isPending}
                onClick={() => completeReviewMutation.mutate()}
              >
                <Icons.check />
                Complete review
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size='sm' variant='outline'>
                  Actions
                  <Icons.chevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                <DropdownMenuItem onSelect={() => setRecordOpen(true)}>
                  Record adjustment…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
                  Move to location…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setConditionOpen(true)}>
                  Set condition…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setTransferOpen(true)}>
                  Transfer to entity…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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

      <ItemEnrichmentPanel item={data} />

      <InventoryItemListingsPanel
        inventoryItemId={data.id}
        itemCode={data.itemCode}
        itemLabel={data.label}
        itemStatus={data.status}
        currency={data.currency}
        estimatedValueAmount={data.estimatedValueAmount}
      />

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Specifics</CardTitle>
        </CardHeader>
        <CardContent>
          <SpecificsEditor inventoryItemId={data.id} specifics={data.specifics} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className='pt-6'>
          <ImageGallery inventoryItemId={data.id} media={data.media} />
        </CardContent>
      </Card>

      {data.sourcedFrom.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>/market relationships</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-2'>
            {data.sourcedFrom.map((link) => (
              <div key={link.id} className='flex flex-wrap items-center gap-2 text-sm'>
                <Badge variant={link.linkKind === 'sourced_from' ? 'secondary' : 'outline'}>
                  {opportunityLinkKindLabel(link.linkKind)}
                </Badge>
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
                {link.targetPriceAmount && link.targetCurrency && (
                  <span className='text-muted-foreground'>
                    target {formatMoney(link.targetPriceAmount, link.targetCurrency)} at link time
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
        <CardHeader className='flex flex-row items-start justify-between gap-2'>
          <div>
            <CardTitle className='text-base'>Allocations</CardTitle>
            <p className='text-muted-foreground text-sm'>
              Every reservation against this item — the rows behind &quot;available to sell&quot;.
            </p>
          </div>
          <ReleaseStaleHoldsButton />
        </CardHeader>
        <CardContent>
          <ItemAllocationsTable allocations={data.allocations} />
        </CardContent>
      </Card>

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
                  <TableHead>Source</TableHead>
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
                    <TableCell className='text-muted-foreground text-xs'>
                      {/*
                        Provenance the row actually carries (loxep-1zg):
                        `acquisitionId` links out (the lot this receipt/found
                        movement traces to); the rest have no detail page yet
                        (order lines, allocations, shipments, and reversed
                        movements are not independently browsable), so they
                        render as a labeled, titled identifier rather than a
                        fabricated link.
                      */}
                      {movement.acquisitionId ? (
                        <Link
                          to='/inventory/acquisitions/$id'
                          params={{ id: movement.acquisitionId }}
                          className='hover:underline'
                        >
                          lot
                        </Link>
                      ) : movement.orderLineId ? (
                        <span title={`order_line_id ${movement.orderLineId}`}>order line</span>
                      ) : movement.shipmentId ? (
                        <span title={`shipment_id ${movement.shipmentId}`}>shipment</span>
                      ) : movement.reversesMovementId ? (
                        <span title={`reverses movement ${movement.reversesMovementId}`}>
                          reversal
                        </span>
                      ) : (
                        '—'
                      )}
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

      <RecordMovementDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        defaultInventoryItemId={data.id}
      />
      <MoveItemLocationDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        inventoryItemId={data.id}
      />
      <SetItemConditionDialog
        open={conditionOpen}
        onOpenChange={setConditionOpen}
        inventoryItemId={data.id}
        currentConditionCode={data.conditionCode}
        currentConditionNotes={data.conditionNotes}
      />
      <TransferItemEntityDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        inventoryItemId={data.id}
      />
    </div>
  );
}
