import { createFileRoute } from '@tanstack/react-router';
import SearchDashboard from '@/features/market/components/search-dashboard';
import { MarketPage } from '@/features/market/components/market-page';

export const Route = createFileRoute('/market/searches')({
  component: MarketSearches
});

function MarketSearches() {
  return (
    <MarketPage
      title='Search & seller monitors'
      description='Persistent eBay searches and seller watches, the items they have discovered, and recent new-listing activity.'
    >
      <SearchDashboard />
    </MarketPage>
  );
}
