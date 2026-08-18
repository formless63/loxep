import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import RulesTable from '@/features/market/components/rules-table';
import { MarketPage } from '@/features/market/components/market-page';

const rulesSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional()
});

export const Route = createFileRoute('/market/rules')({
  validateSearch: zodValidator(rulesSearchSchema),
  component: MarketRules
});

function MarketRules() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <MarketPage
      title='Rules'
      description='The declarative conditions that score a derived market event into an opportunity. All declared predicates are ANDed; the first enabled match wins.'
    >
      <RulesTable isAdmin={isAdmin} />
    </MarketPage>
  );
}
