import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import OpportunitiesTable from '@/features/market/components/opportunities-table';
import { MarketPage } from '@/features/market/components/market-page';

const opportunitiesSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(25),
  sort: z.string().optional(),
  /** `DataTableDateFilter`'s single-date epoch-ms value, on `detectedAt`. */
  detectedAt: z.string().optional()
});

export const Route = createFileRoute('/market/opportunities')({
  validateSearch: zodValidator(opportunitiesSearchSchema),
  component: MarketOpportunities
});

function MarketOpportunities() {
  return (
    <MarketPage
      title='Opportunities'
      description='Events stamped by an opportunity rule — declarative conditions over derived market events, scored and ranked.'
    >
      <OpportunitiesTable />
    </MarketPage>
  );
}
