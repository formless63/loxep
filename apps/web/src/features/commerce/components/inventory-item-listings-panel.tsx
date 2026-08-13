import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Icons } from '@/components/icons';
import { formatMoney } from '@/lib/format';
import { inventoryItemListingsQuery } from '@/features/commerce/api/queries';
import {
  channelListingStatusLabel,
  channelListingStatusTone,
  manualListingChannelLabel,
  providerLabel
} from '@/features/commerce/constants';
import ManualListingForm from '@/features/commerce/components/manual-listing-form';

/**
 * The market→inventory→listing weave's inventory-side half: an item detail
 * gains a listings panel (design "the weave" → "Inventory to listings",
 * loxep-dgf.6). Lives in `@loxep/commerce`'s feature module (not
 * `@/features/inventory`) because listings are Catalog-and-Listings-owned —
 * imported into `ItemDetail` the same way `ItemDetail` already imports
 * `sortRows` from `@/features/market`.
 */
export default function InventoryItemListingsPanel({
  inventoryItemId,
  itemCode,
  itemLabel,
  itemStatus,
  currency,
  estimatedValueAmount
}: {
  inventoryItemId: string;
  itemCode: string;
  itemLabel: string;
  itemStatus: string;
  currency: string;
  estimatedValueAmount: string | null;
}) {
  const { data, isPending } = useQuery(inventoryItemListingsQuery(inventoryItemId));
  const [createOpen, setCreateOpen] = React.useState(false);
  const canList =
    itemStatus !== 'intake' && itemStatus !== 'written_off' && itemStatus !== 'archived';

  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between gap-2'>
        <CardTitle className='text-base'>Listings</CardTitle>
        {canList && (
          <Button size='sm' variant='outline' onClick={() => setCreateOpen(true)}>
            <Icons.add />
            List this item
          </Button>
        )}
      </CardHeader>
      <CardContent className='flex flex-col gap-2'>
        {isPending ? (
          <p className='text-muted-foreground text-sm'>Loading…</p>
        ) : data === undefined || data.length === 0 ? (
          <p className='text-muted-foreground text-sm'>
            Not listed anywhere yet.
            {itemStatus === 'intake' && ' Complete intake review before creating a listing.'}
          </p>
        ) : (
          data.map((listing) => (
            <div key={listing.id} className='flex flex-wrap items-center gap-2 text-sm'>
              <Link
                to='/commerce/listings/$id'
                params={{ id: listing.id }}
                className='font-medium hover:underline'
              >
                {listing.listingCode}
              </Link>
              <Badge variant={channelListingStatusTone(listing.status)}>
                {channelListingStatusLabel(listing.status)}
              </Badge>
              <span className='text-muted-foreground'>
                {providerLabel(listing.provider)} · {manualListingChannelLabel(listing.channel)}
              </span>
              {listing.price && (
                <span className='text-muted-foreground'>
                  {formatMoney(listing.price, listing.currency ?? 'USD')}
                </span>
              )}
            </div>
          ))
        )}
      </CardContent>
      {createOpen && (
        <ManualListingForm
          open={createOpen}
          onOpenChange={setCreateOpen}
          prefill={{
            inventoryItemId,
            itemLabel,
            itemCode,
            currency,
            estimatedValueAmount
          }}
        />
      )}
    </Card>
  );
}
