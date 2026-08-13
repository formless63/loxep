import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Redirect-only route so "New expense" can be a plain nav entry (and
 * therefore Cmd+K-reachable, per the shared command-palette mechanism —
 * `@/config/navigation/finance.ts`) while still landing on
 * `/finance/expenses` with a properly-typed `search.quickEntry`, which opens
 * the quick-entry dialog. TanStack Router's `Link`/`navigate` resolve a
 * plain `url: string` as a pathname and do not parse an embedded `?search`
 * out of it, so `redirect({ to, search })` — issued imperatively, not via a
 * string — is the reliable way to land with a search param set.
 */
export const Route = createFileRoute('/finance/expenses/new')({
  beforeLoad: () => {
    throw redirect({ to: '/finance/expenses', search: { quickEntry: true } });
  }
});
