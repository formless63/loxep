import { createFileRoute } from '@tanstack/react-router';
import OpportunitiesTable from '@/features/market/components/opportunities-table';
import { MarketPage } from '@/features/market/components/market-page';

export const Route = createFileRoute('/market/opportunities')({
  component: MarketOpportunities
});

function MarketOpportunities() {
  return (
    <MarketPage
      title='Opportunities'
      description='Events stamped by an opportunity rule (loxep-7dp.5) — declarative conditions over derived market events, scored and ranked.'
    >
      <OpportunitiesTable />
    </MarketPage>
  );
}
