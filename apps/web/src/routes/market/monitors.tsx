import { createFileRoute } from '@tanstack/react-router';
import MonitorsTable from '@/features/market/components/monitors-table';
import { MarketPage } from '@/features/market/components/market-page';

export const Route = createFileRoute('/market/monitors')({
  component: MarketMonitors
});

function MarketMonitors() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <MarketPage
      title='Monitors'
      description='What to poll, on what cadence — scheduling state (interval, priority, backoff) lives in the database; a small number of dispatcher jobs claim due work.'
    >
      <MonitorsTable isAdmin={isAdmin} />
    </MarketPage>
  );
}
