import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Redirect-only route so "Intake review" can be a plain nav entry (and
 * therefore Cmd+K-reachable) while landing on `/inventory/stock` with a
 * properly-typed `search.status=intake` — mirrors
 * `routes/finance/expenses.new.tsx`'s reasoning: TanStack Router resolves a
 * plain `url: string` as a pathname and does not parse an embedded `?search`
 * out of it, so `redirect({ to, search })`, issued imperatively, is the
 * reliable way to land pre-filtered.
 */
export const Route = createFileRoute('/inventory/intake')({
  beforeLoad: () => {
    throw redirect({ to: '/inventory/stock', search: { status: 'intake' } });
  }
});
