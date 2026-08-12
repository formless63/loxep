import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import SearchDashboard from '@/features/market/components/search-dashboard';
import { MarketPage } from '@/features/market/components/market-page';

/**
 * Only `DiscoveryMonitorsTable` (the primary table on this route) is
 * URL-synced — see `RecentNewListingsTable`'s doc
 * (`@/features/market/components/search-dashboard.tsx`) for why a second
 * table on the same route can't also own `page`/`perPage`/`sort`.
 */
const searchesSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional()
});

export const Route = createFileRoute('/market/searches')({
  validateSearch: zodValidator(searchesSearchSchema),
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
