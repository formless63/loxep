import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import MonitorsTable from '@/features/market/components/monitors-table';
import { MarketPage } from '@/features/market/components/market-page';

const monitorsSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  /** The "Type" column's multi-select facet, comma-separated target types. */
  targetType: z.string().optional()
});

export const Route = createFileRoute('/market/monitors')({
  validateSearch: zodValidator(monitorsSearchSchema),
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
