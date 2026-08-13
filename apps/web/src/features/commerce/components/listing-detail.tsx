import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { formatDateTime, formatMoney, formatQuantity } from '@/lib/format';
import { channelListingQuery } from '@/features/commerce/api/queries';
import {
  channelListingStatusLabel,
  channelListingStatusTone,
  manualListingChannelLabel,
  providerLabel,
  MANUAL_PROVIDER
} from '@/features/commerce/constants';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import RecordSaleForm from '@/features/commerce/components/record-sale-form';

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-muted-foreground text-xs'>{label}</span>
      <span className='text-sm'>{children}</span>
    </div>
  );
}

export default function ListingDetail({ listingId }: { listingId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(channelListingQuery(listingId));
  const [saleOpen, setSaleOpen] = React.useState(false);

  if (isPending) {
    return <div className='text-muted-foreground text-sm'>Loading…</div>;
  }
  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load listing' onRetry={() => refetch()} />
    );
  }

  const isManual = data.provider === MANUAL_PROVIDER;
  const canRecordSale = isManual && data.status !== 'sold_out' && data.status !== 'ended';

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader className='flex flex-row items-start justify-between gap-2'>
          <div>
            <CardTitle className='flex items-center gap-2 text-xl'>
              {data.listingCode}
              <Badge variant={channelListingStatusTone(data.status)}>
                {channelListingStatusLabel(data.status)}
              </Badge>
            </CardTitle>
            <p className='text-muted-foreground text-sm'>
              {data.listingTitle ?? data.catalogItemName}
            </p>
          </div>
          {canRecordSale && (
            <Button size='sm' onClick={() => setSaleOpen(true)}>
              <Icons.check />
              Record sale
            </Button>
          )}
        </CardHeader>
        <CardContent className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
          <DetailRow label='Provider'>{providerLabel(data.provider)}</DetailRow>
          <DetailRow label='Channel'>{manualListingChannelLabel(data.channel)}</DetailRow>
          <DetailRow label='SKU'>{data.catalogItemSku}</DetailRow>
          <DetailRow label='Price'>
            {data.price ? formatMoney(data.price, data.currency ?? 'USD') : '—'}
          </DetailRow>
          <DetailRow label='Quantity available'>{data.quantityAvailable ?? '—'}</DetailRow>
          <DetailRow label='Listed'>
            {data.listedAt ? formatDateTime(data.listedAt) : 'Not yet listed'}
          </DetailRow>
          <DetailRow label='Ended'>{data.endedAt ? formatDateTime(data.endedAt) : '—'}</DetailRow>
          <DetailRow label='Inventory item'>
            {data.inventoryItemId ? (
              <Link
                to='/inventory/stock/$id'
                params={{ id: data.inventoryItemId }}
                className='hover:underline'
              >
                {data.inventoryItemCode}
              </Link>
            ) : (
              '—'
            )}
          </DetailRow>
          {data.listingUrl && (
            <DetailRow label='Listing URL'>
              <a
                href={data.listingUrl}
                target='_blank'
                rel='noreferrer'
                className='hover:underline'
              >
                {data.listingUrl}
              </a>
            </DetailRow>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Sales</CardTitle>
        </CardHeader>
        <CardContent>
          {data.sales.length === 0 ? (
            <p className='text-muted-foreground text-sm'>
              {isManual
                ? 'No sale recorded yet.'
                : 'Connector-synced orders for this listing appear here once order ingestion writes channel_listing_id.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quantity</TableHead>
                  <TableHead className='text-right'>Unit price</TableHead>
                  <TableHead className='text-right'>Line total</TableHead>
                  <TableHead>Placed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sales.map((sale) => (
                  <TableRow key={sale.orderLineId}>
                    <TableCell className='tabular-nums'>
                      {formatQuantity(Number(sale.quantity))}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {formatMoney(sale.unitPrice, sale.currency)}
                    </TableCell>
                    <TableCell className='text-right font-medium tabular-nums'>
                      {formatMoney(sale.lineTotal, sale.currency)}
                    </TableCell>
                    <TableCell className='text-muted-foreground tabular-nums'>
                      {formatDateTime(sale.placedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {saleOpen && (
        <RecordSaleForm
          open={saleOpen}
          onOpenChange={setSaleOpen}
          channelListingId={data.id}
          defaultUnitPrice={data.price}
        />
      )}
    </div>
  );
}
