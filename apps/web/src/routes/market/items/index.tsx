import { createFileRoute } from '@tanstack/react-router';
import ItemsTable from '@/features/market/components/items-table';
import { MarketPage } from '@/features/market/components/market-page';

export const Route = createFileRoute('/market/items/')({
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
