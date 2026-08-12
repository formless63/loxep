import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import ItemsTable from '@/features/market/components/items-table';
import { MarketPage } from '@/features/market/components/market-page';

const itemsSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(25),
  sort: z.string().optional(),
  /** The "Monitors" column's single-select facet. */
  monitorTargetId: z.string().optional()
});

export const Route = createFileRoute('/market/items/')({
  validateSearch: zodValidator(itemsSearchSchema),
  component: MarketItems
});

function MarketItems() {
  return (
    <MarketPage
      title='Watched items'
      description='Marketplace items linked to your monitors, joined with their latest observation.'
    >
      <ItemsTable />
    </MarketPage>
  );
}
