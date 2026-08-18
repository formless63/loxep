import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { CommercePage } from '@/features/commerce/components/commerce-page';
import ListingsTable from '@/features/commerce/components/listings-table';
import ManualListingForm from '@/features/commerce/components/manual-listing-form';
import SellThroughFunnelChart from '@/features/commerce/components/sell-through-funnel-chart';

/**
 * List route named `listings.index.tsx`, not `listings.tsx` —
 * `listings.$id.tsx` is a sibling, and a flat `listings.tsx` would become
 * that detail route's layout instead of the list content (the same
 * route-nesting lesson `routes/inventory/stock.index.tsx` recorded for
 * `stock.$id.tsx`).
 */
const listingsSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  status: z.string().optional(),
  provider: z.string().optional()
});

export const Route = createFileRoute('/commerce/listings/')({
  validateSearch: zodValidator(listingsSearchSchema),
  component: CommerceListings
});

function CommerceListings() {
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <CommercePage
      title='Listings'
      description='Every channel listing — manual/offline and connector-synced alike.'
      actions={
        <Button size='sm' onClick={() => setCreateOpen(true)}>
          <Icons.add />
          Add listing
        </Button>
      }
    >
      <SellThroughFunnelChart />
      <ListingsTable />
      {createOpen && <ManualListingForm open={createOpen} onOpenChange={setCreateOpen} />}
    </CommercePage>
  );
}
