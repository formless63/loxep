import * as React from 'react';
import type { ReactNode } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { DataTable } from '@/components/ui/table/data-table';
import { Progress } from '@/components/ui/progress';
import { Icons } from '@/components/icons';
import { dataTableFeatures, type DataTableFeatures } from '@/lib/table-features';
import { sumMoney, sumMoneyBy } from '@/lib/aggregate';
import { formatDateTime, formatMoney, formatQuantity } from '@/lib/format';
import { orderQuery } from '@/features/commerce/api/queries';
import {
  feeDirectionLabel,
  feeDirectionTone,
  fulfillmentRecordStatusLabel,
  fulfillmentRecordStatusTone,
  humanizeSnakeCase,
  orderFulfillmentStatusLabel,
  orderFulfillmentStatusTone,
  orderPaymentStatusLabel,
  orderPaymentStatusTone,
  orderStatusLabel,
  orderStatusTone,
  providerLabel,
  provenanceRetentionLabel,
  provenanceRetentionTone,
  refundKindLabel,
  refundStatusLabel,
  refundStatusTone
} from '@/features/commerce/constants';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import OrderAttributionDialog from '@/features/commerce/components/order-attribution-dialog';
import ShipmentsPanel from '@/features/inventory/components/shipments-panel';
import type {
  OrderDetailDto,
  OrderFeeDto,
  OrderFulfillmentDto,
  OrderLineDto,
  OrderRefundDto
} from '@/server/orders-functions';

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-muted-foreground text-xs'>{label}</span>
      <span className='text-sm'>{children}</span>
    </div>
  );
}

function LineJoins({ line }: { line: OrderLineDto }) {
  return (
    <div className='flex flex-col gap-0.5 text-xs'>
      <span>
        Listing:{' '}
        {line.channelListingId ? (
          <Link
            to='/commerce/listings/$id'
            params={{ id: line.channelListingId }}
            className='hover:underline'
          >
            {line.channelListingCode ?? 'View listing'}
          </Link>
        ) : (
          <span className='text-muted-foreground'>not linked</span>
        )}
      </span>
      <span>
        Market item:{' '}
        {line.marketplaceItemId ? (
          <Link
            to='/market/items/$itemId'
            params={{ itemId: line.marketplaceItemId }}
            className='hover:underline'
          >
            {line.marketplaceItemTitle ?? 'View listing'}
          </Link>
        ) : (
          <span className='text-muted-foreground'>not linked</span>
        )}
      </span>
    </div>
  );
}

/**
 * Per-line shipped quantity (loxep-759): sums `order_fulfillment_lines.quantity`
 * across every fulfillment record for the order, grouped by `order_line_id` via
 * `sumMoneyBy` (decimal-safe — `quantity` is `numeric(20,6)`, never JS `number`
 * arithmetic). A `cancelled` fulfillment record is excluded — the schema doc
 * for `order_fulfillments` calls it "what the CHANNEL reported as shipped",
 * and a cancelled record reports nothing that actually shipped.
 */
function shippedQuantityByLine(fulfillments: OrderFulfillmentDto[]): Map<string, string> {
  const shippedLines = fulfillments
    .filter((fulfillment) => fulfillment.status !== 'cancelled')
    .flatMap((fulfillment) => fulfillment.lines);
  return sumMoneyBy(
    shippedLines,
    (line) => line.quantity,
    (line) => line.orderLineId
  );
}

/**
 * "X of Y units shipped" per line, plus a thin `--primary`-filled progress
 * bar. The percentage below feeds ONLY the bar's width — a UI proportion, not
 * a stored or compared value — mirroring the `Number(decimalString)`-for-a-
 * chart-axis exception in Frontend Standards' "Standard formats" section; the
 * `X of Y` text itself renders the exact decimal quantities via
 * `formatQuantity`, never the derived percentage.
 */
function ShippedProgress({ shipped, ordered }: { shipped: string; ordered: string }) {
  const shippedNumber = Number(shipped);
  const orderedNumber = Number(ordered);
  const percent =
    orderedNumber > 0 ? Math.min(100, Math.max(0, (shippedNumber / orderedNumber) * 100)) : 0;
  return (
    <div className='flex flex-col items-end gap-1'>
      <span className='text-muted-foreground text-xs tabular-nums'>
        {formatQuantity(shippedNumber)} of {formatQuantity(orderedNumber)} shipped
      </span>
      <Progress value={percent} className='h-1.5 w-20' />
    </div>
  );
}

function LinesTable({
  lines,
  currency,
  shippedByLine
}: {
  lines: OrderLineDto[];
  currency: string;
  shippedByLine: Map<string, string>;
}) {
  if (lines.length === 0) {
    return <p className='text-muted-foreground text-sm'>This order has no lines.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead>Joins</TableHead>
          <TableHead className='text-right'>Qty</TableHead>
          <TableHead className='text-right'>Unit price</TableHead>
          <TableHead className='text-right'>Line total</TableHead>
          <TableHead className='text-right'>Shipped</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line) => (
          <TableRow key={line.id}>
            <TableCell>
              <div className='flex flex-col'>
                <span className='font-medium'>{line.title ?? line.catalogItemName ?? '—'}</span>
                <span className='text-muted-foreground text-xs'>
                  {line.channelSku ?? line.catalogItemSku ?? '—'}
                </span>
              </div>
            </TableCell>
            <TableCell>
              <LineJoins line={line} />
            </TableCell>
            <TableCell className='text-right tabular-nums'>
              {formatQuantity(Number(line.quantity))}
            </TableCell>
            <TableCell className='text-right tabular-nums'>
              {formatMoney(line.unitPrice, currency)}
            </TableCell>
            <TableCell className='text-right font-medium tabular-nums'>
              {formatMoney(line.lineTotal, currency)}
            </TableCell>
            <TableCell>
              <ShippedProgress
                shipped={shippedByLine.get(line.id) ?? '0'}
                ordered={line.quantity}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * `fee_direction`/currency composite bucket key for the per-direction
 * subtotals below — never sum across currencies (`sumMoneyBy`'s own rule),
 * so a direction with mixed-currency fees (unusual, but not precluded by the
 * schema) still gets one subtotal per currency rather than one fabricated
 * cross-currency total.
 */
const FEE_BUCKET_SEPARATOR = '::';

function feeBucketKey(fee: OrderFeeDto): string {
  return `${fee.feeDirection}${FEE_BUCKET_SEPARATOR}${fee.currency}`;
}

function splitFeeBucketKey(key: string): { direction: string; currency: string } {
  const [direction, currency] = key.split(FEE_BUCKET_SEPARATOR);
  return { direction: direction ?? key, currency: currency ?? '' };
}

const feeColumns: ColumnDef<DataTableFeatures, OrderFeeDto>[] = [
  {
    id: 'feeType',
    accessorKey: 'feeType',
    header: 'Type',
    cell: ({ row }) => (
      <div className='flex flex-col'>
        <span>{humanizeSnakeCase(row.original.feeType)}</span>
        {row.original.providerFeeCode && (
          <span className='text-muted-foreground text-xs'>{row.original.providerFeeCode}</span>
        )}
      </div>
    )
  },
  {
    id: 'feeDirection',
    accessorKey: 'feeDirection',
    header: 'Direction',
    cell: ({ cell }) => {
      const direction = cell.getValue<string>();
      return <Badge variant={feeDirectionTone(direction)}>{feeDirectionLabel(direction)}</Badge>;
    }
  },
  {
    id: 'feeScope',
    accessorKey: 'feeScope',
    header: 'Scope',
    cell: ({ cell }) => (
      <span className='text-muted-foreground capitalize'>{cell.getValue<string>()}</span>
    )
  },
  {
    id: 'chargedAt',
    accessorKey: 'chargedAt',
    header: 'Charged',
    cell: ({ cell }) => (
      <span className='text-muted-foreground tabular-nums'>
        {formatDateTime(cell.getValue<string | null>())}
      </span>
    )
  },
  {
    id: 'amount',
    accessorKey: 'amount',
    header: () => <div className='text-right'>Amount</div>,
    cell: ({ row }) => (
      <div className='text-right tabular-nums'>
        {formatMoney(row.original.amount, row.original.currency)}
      </div>
    )
  }
];

/**
 * `FEE_DIRECTIONS` exists precisely so `seller_charge` (a deduction from
 * proceeds) and `buyer_surcharge` (already inside `orders.total`, never
 * subtracted) are never conflated — this table renders a Direction badge per
 * row and a per-direction (per-currency) subtotal in the `DataTable` summary
 * slot, rather than one undifferentiated amount column with no sum.
 */
function FeesTable({ fees }: { fees: OrderFeeDto[] }) {
  const table = useTable({
    data: fees,
    columns: feeColumns,
    features: dataTableFeatures,
    getRowId: (fee) => fee.id,
    manualPagination: true
  });

  if (fees.length === 0) {
    return <p className='text-muted-foreground text-sm'>No fees reported for this order.</p>;
  }

  const totalsByBucket = sumMoneyBy(fees, (fee) => fee.amount, feeBucketKey);

  return (
    <DataTable
      table={table}
      summary={
        <>
          {[...totalsByBucket.entries()].map(([bucketKey, total]) => {
            const { direction, currency } = splitFeeBucketKey(bucketKey);
            return (
              <TableRow key={bucketKey}>
                <TableCell colSpan={4} className='font-medium'>
                  {feeDirectionLabel(direction)} subtotal
                </TableCell>
                <TableCell className='text-right font-medium tabular-nums'>
                  {formatMoney(total, currency)}
                </TableCell>
              </TableRow>
            );
          })}
        </>
      }
    />
  );
}

function RefundsList({ refunds }: { refunds: OrderRefundDto[] }) {
  if (refunds.length === 0) {
    return <p className='text-muted-foreground text-sm'>No refunds recorded for this order.</p>;
  }
  return (
    <div className='flex flex-col gap-3'>
      {refunds.map((refund) => (
        <div key={refund.id} className='flex flex-col gap-2 rounded-md border p-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div className='flex items-center gap-2'>
              <Badge variant={refundStatusTone(refund.status)}>
                {refundStatusLabel(refund.status)}
              </Badge>
              <span className='text-sm'>{refundKindLabel(refund.kind)}</span>
              {refund.reasonCode && (
                <span className='text-muted-foreground text-xs'>{refund.reasonCode}</span>
              )}
            </div>
            <div className='flex items-center gap-3'>
              <span className='text-muted-foreground text-xs tabular-nums'>
                {refund.refundedAt ? formatDateTime(refund.refundedAt) : '—'}
              </span>
              <span className='font-medium tabular-nums'>
                {formatMoney(refund.amount, refund.currency)}
              </span>
            </div>
          </div>
          {refund.lines.length > 0 && (
            <div className='flex flex-col gap-1 pl-1'>
              {refund.lines.map((line) => (
                <div key={line.id} className='text-muted-foreground flex justify-between text-xs'>
                  <span>
                    {line.orderLineId
                      ? `Line ${line.orderLineId.slice(0, 8)}…`
                      : 'Order-level adjustment'}
                    {line.quantity ? ` × ${formatQuantity(Number(line.quantity))}` : ''}
                  </span>
                  <span className='tabular-nums'>{formatMoney(line.amount, refund.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Reconciles the sum of displayed refund lines against `orders.refunded_amount`
 * (loxep-759) — the schema doc for `order_refunds` calls a mismatch "a
 * reconciliation finding, not a constraint violation": `refunded_amount` is a
 * provider-reported rollup, not a derived sum, so the two CAN legitimately
 * disagree (a refund the provider rolled into the order total before a
 * `order_refunds` row was ever ingested, for instance). Grouped by currency via
 * `sumMoneyBy` — refunds are never summed across currencies, and
 * `orders.refunded_amount` is itself in `orders.currency` only, so any bucket
 * in a different currency is reported as extra evidence rather than compared.
 */
function RefundReconciliation({
  refunds,
  orderCurrency,
  orderRefundedAmount
}: {
  refunds: OrderRefundDto[];
  orderCurrency: string;
  orderRefundedAmount: string;
}) {
  const totalsByCurrency = sumMoneyBy(
    refunds,
    (refund) => refund.amount,
    (refund) => refund.currency
  );
  const displayedTotal = totalsByCurrency.get(orderCurrency) ?? sumMoney([]);
  const recordedAmount = sumMoney([orderRefundedAmount]);
  const matches = displayedTotal === recordedAmount;
  const otherCurrencyBuckets = [...totalsByCurrency.entries()].filter(
    ([currency]) => currency !== orderCurrency
  );

  return (
    <div
      className={`flex flex-col gap-1 rounded-md border p-3 text-xs ${
        matches ? 'border-success/40 bg-success/5' : 'border-warning/40 bg-warning/5'
      }`}
    >
      <div className='flex items-center gap-1.5'>
        {matches ? (
          <Icons.circleCheck className='text-success size-3.5' />
        ) : (
          <Icons.warning className='text-warning size-3.5' />
        )}
        <span className={matches ? 'text-success font-medium' : 'text-warning font-medium'}>
          {matches ? 'Reconciled' : 'Mismatch'}
        </span>
        <span className='text-muted-foreground'>
          Displayed refunds ({formatMoney(displayedTotal, orderCurrency)}) vs.{' '}
          <code className='text-[0.7rem]'>orders.refunded_amount</code> (
          {formatMoney(recordedAmount, orderCurrency)})
        </span>
      </div>
      {otherCurrencyBuckets.length > 0 && (
        <p className='text-muted-foreground'>
          Also refunded in a different currency than the order (
          {otherCurrencyBuckets.map(([currency, total]) => formatMoney(total, currency)).join(', ')}
          ) — not comparable to <code className='text-[0.7rem]'>orders.refunded_amount</code>.
        </p>
      )}
    </div>
  );
}

function FulfillmentsList({ fulfillments }: { fulfillments: OrderFulfillmentDto[] }) {
  if (fulfillments.length === 0) {
    return <p className='text-muted-foreground text-sm'>Nothing reported as shipped yet.</p>;
  }
  return (
    <div className='flex flex-col gap-3'>
      {fulfillments.map((fulfillment) => (
        <div key={fulfillment.id} className='flex flex-col gap-2 rounded-md border p-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div className='flex items-center gap-2'>
              <Badge variant={fulfillmentRecordStatusTone(fulfillment.status)}>
                {fulfillmentRecordStatusLabel(fulfillment.status)}
              </Badge>
              {fulfillment.carrierName && (
                <span className='text-sm'>{fulfillment.carrierName}</span>
              )}
              {fulfillment.trackingNumber &&
                (fulfillment.trackingUrl ? (
                  <a
                    href={fulfillment.trackingUrl}
                    target='_blank'
                    rel='noreferrer'
                    className='text-muted-foreground text-xs hover:underline'
                  >
                    {fulfillment.trackingNumber}
                  </a>
                ) : (
                  <span className='text-muted-foreground text-xs'>
                    {fulfillment.trackingNumber}
                  </span>
                ))}
            </div>
            <div className='flex items-center gap-3 text-xs'>
              <span className='text-muted-foreground'>
                {fulfillment.destinationCountry
                  ? [fulfillment.destinationRegion, fulfillment.destinationCountry]
                      .filter(Boolean)
                      .join(', ')
                  : '—'}
              </span>
              <span className='text-muted-foreground tabular-nums'>
                {fulfillment.shippedAt ? formatDateTime(fulfillment.shippedAt) : 'Not shipped'}
              </span>
            </div>
          </div>
          {fulfillment.lines.length > 0 && (
            <div className='text-muted-foreground pl-1 text-xs'>
              {fulfillment.lines
                .map((line) => `${formatQuantity(Number(line.quantity))} unit(s)`)
                .join(', ')}{' '}
              across {fulfillment.lines.length} line(s)
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ProvenanceTable({ provenance }: { provenance: OrderDetailDto['provenance'] }) {
  if (provenance.length === 0) {
    return (
      <p className='text-muted-foreground text-sm'>
        No retained source facts linked to this order yet.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Effect</TableHead>
          <TableHead>Captured</TableHead>
          <TableHead>Retention</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {provenance.map((link) => (
          <TableRow key={link.linkId}>
            <TableCell>
              {link.sourceKind === 'provider_object' ? 'Provider snapshot' : 'Source event'}
            </TableCell>
            <TableCell className='text-muted-foreground'>
              {link.objectType ? humanizeSnakeCase(link.objectType) : '—'}
            </TableCell>
            <TableCell className='text-muted-foreground capitalize'>{link.effect}</TableCell>
            <TableCell className='text-muted-foreground tabular-nums'>
              {link.capturedAt ? formatDateTime(link.capturedAt) : '—'}
            </TableCell>
            <TableCell>
              {link.retention ? (
                <Badge variant={provenanceRetentionTone(link.retention)}>
                  {provenanceRetentionLabel(link.retention)}
                </Badge>
              ) : (
                <span className='text-muted-foreground'>—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function OrderDetail({ orderId }: { orderId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(orderQuery(orderId));
  const [attributionOpen, setAttributionOpen] = React.useState(false);

  if (isPending) {
    return <div className='text-muted-foreground text-sm'>Loading…</div>;
  }
  if (isError) {
    return <QueryErrorAlert error={error} title='Could not load order' onRetry={() => refetch()} />;
  }

  return (
    <div className='flex flex-col gap-4'>
      {data.duplicateOfOrderId && (
        <Alert variant='warning'>
          <Icons.warning />
          <AlertTitle>Marked as a duplicate</AlertTitle>
          <AlertDescription>
            Cross-connection duplicate detection linked this order to another as its canonical
            record.{' '}
            <Link
              to='/commerce/orders/$id'
              params={{ id: data.duplicateOfOrderId }}
              className='underline'
            >
              View the canonical order
            </Link>
            . This row is kept as retained evidence and excluded from the orders list.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className='flex flex-row items-start justify-between gap-2'>
          <div>
            <CardTitle className='flex flex-wrap items-center gap-2 text-xl'>
              {data.externalOrderNumber ?? data.externalOrderId}
              <Badge variant={orderStatusTone(data.status)}>{orderStatusLabel(data.status)}</Badge>
              <Badge variant={orderPaymentStatusTone(data.paymentStatus)}>
                {orderPaymentStatusLabel(data.paymentStatus)}
              </Badge>
              <Badge variant={orderFulfillmentStatusTone(data.fulfillmentStatus)}>
                {orderFulfillmentStatusLabel(data.fulfillmentStatus)}
              </Badge>
            </CardTitle>
            <p className='text-muted-foreground text-sm'>
              {data.isManual ? (
                <span className='inline-flex items-center gap-1'>
                  <Icons.user className='size-3.5' /> Manually recorded sale
                </span>
              ) : (
                <span className='inline-flex items-center gap-1'>
                  <Icons.integrations className='size-3.5' /> Synced from{' '}
                  {providerLabel(data.provider)}
                </span>
              )}
              {' · '}
              {data.channel}
              {data.marketplace ? ` · ${data.marketplace}` : ''}
            </p>
          </div>
        </CardHeader>
        <CardContent className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
          <DetailRow label='Placed'>{formatDateTime(data.placedAt)}</DetailRow>
          <DetailRow label='Provider updated'>
            {data.providerUpdatedAt ? formatDateTime(data.providerUpdatedAt) : '—'}
          </DetailRow>
          <DetailRow label='Last synced'>{formatDateTime(data.lastSyncedAt)}</DetailRow>
          <DetailRow label='Cancelled'>
            {data.cancelledAt ? formatDateTime(data.cancelledAt) : '—'}
          </DetailRow>
          <DetailRow label='Buyer'>
            {data.buyerDisplayName ?? '—'}
            {data.buyerExternalId && (
              <span className='text-muted-foreground block text-xs'>{data.buyerExternalId}</span>
            )}
          </DetailRow>
          <DetailRow label='Attribution'>
            <span className='flex items-center gap-1.5'>
              <span>
                {data.economicEntityName ?? 'Unattributed'}
                <span className='text-muted-foreground block text-xs capitalize'>
                  {data.entityAttributionSource.replaceAll('_', ' ')}
                </span>
              </span>
              <Button
                type='button'
                variant='ghost'
                size='icon-sm'
                aria-label='Edit attribution'
                onClick={() => setAttributionOpen(true)}
              >
                <Icons.edit className='size-3.5' />
              </Button>
            </span>
          </DetailRow>
          <DetailRow label='Provider order id'>{data.externalOrderId}</DetailRow>
          <DetailRow label='Source account'>{data.sourceAccountKey}</DetailRow>
          {data.providerStatusRaw && (
            <DetailRow label='Provider status (raw)'>{data.providerStatusRaw}</DetailRow>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Totals</CardTitle>
        </CardHeader>
        <CardContent className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
          <DetailRow label='Subtotal'>{formatMoney(data.subtotalAmount, data.currency)}</DetailRow>
          <DetailRow label='Shipping'>{formatMoney(data.shippingAmount, data.currency)}</DetailRow>
          <DetailRow label='Discount'>{formatMoney(data.discountAmount, data.currency)}</DetailRow>
          <DetailRow label='Tax'>{formatMoney(data.taxAmount, data.currency)}</DetailRow>
          <DetailRow label='Fees (seller-charged)'>
            {formatMoney(data.feeAmount, data.currency)}
          </DetailRow>
          <DetailRow label='Refunded'>{formatMoney(data.refundedAmount, data.currency)}</DetailRow>
          <DetailRow label='Total'>
            <span className='text-base font-semibold'>
              {formatMoney(data.totalAmount, data.currency)}
            </span>
          </DetailRow>
        </CardContent>
        <CardContent className='text-muted-foreground text-xs'>
          Revenue minus provider-reported fees and refunds — before cost of goods. Margin arrives
          once cost basis exists.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2 text-base'>
            <Icons.orders className='size-4' /> Lines
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LinesTable
            lines={data.lines}
            currency={data.currency}
            shippedByLine={shippedQuantityByLine(data.fulfillments)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2 text-base'>
            <Icons.fees className='size-4' /> Fees
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FeesTable fees={data.fees} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2 text-base'>
            <Icons.refunds className='size-4' /> Refunds
          </CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          <RefundsList refunds={data.refunds} />
          <RefundReconciliation
            refunds={data.refunds}
            orderCurrency={data.currency}
            orderRefundedAmount={data.refundedAmount}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2 text-base'>
            <Icons.send className='size-4' /> Fulfillments
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FulfillmentsList fulfillments={data.fulfillments} />
        </CardContent>
      </Card>

      <ShipmentsPanel
        orderId={data.id}
        currency={data.currency}
        lines={data.lines.map((line) => ({
          id: line.id,
          title: line.title,
          quantity: line.quantity
        }))}
      />

      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2 text-base'>
            <Icons.lock className='size-4' /> Provenance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ProvenanceTable provenance={data.provenance} />
        </CardContent>
      </Card>

      <OrderAttributionDialog
        open={attributionOpen}
        onOpenChange={setAttributionOpen}
        orderId={data.id}
        currentEconomicEntityId={data.economicEntityId}
      />
    </div>
  );
}
