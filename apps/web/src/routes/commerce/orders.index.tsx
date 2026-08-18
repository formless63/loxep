import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { CommercePage } from '@/features/commerce/components/commerce-page';
import OrdersTable from '@/features/commerce/components/orders-table';
import DuplicateOrdersPanel from '@/features/commerce/components/duplicate-orders-panel';

/**
 * List route named `orders.index.tsx`, not `orders.tsx` — `orders.$id.tsx`
 * is a sibling, and a flat `orders.tsx` would become that detail route's
 * layout instead of the list content (the same route-nesting lesson
 * `listings.index.tsx`/`listings.$id.tsx` already record for this
 * workspace).
 */
const ordersSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  placedAt: z.string().optional()
});

export const Route = createFileRoute('/commerce/orders/')({
  validateSearch: zodValidator(ordersSearchSchema),
  component: CommerceOrders
});

function CommerceOrders() {
  return (
    <CommercePage
      title='Orders'
      description='Every order — connector-synced and manually recorded alike — with the lines, fees, refunds, and fulfillments the dashboard aggregate never showed.'
    >
      <div className='flex flex-col gap-4'>
        <DuplicateOrdersPanel />
        <OrdersTable />
      </div>
    </CommercePage>
  );
}
