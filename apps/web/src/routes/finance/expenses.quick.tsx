import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Redirect-only route so "Quick expense" can be a plain nav entry (and
 * therefore Cmd+K-reachable, per the shared command-palette mechanism —
 * `@/config/navigation/finance.ts`) while still landing on
 * `/finance/expenses` with a properly-typed `search.quickEntry`, which opens
 * the quick-entry dialog. TanStack Router's `Link`/`navigate` resolve a
 * plain `url: string` as a pathname and do not parse an embedded `?search`
 * out of it, so `redirect({ to, search })` — issued imperatively, not via a
 * string — is the reliable way to land with a search param set.
 *
 * Moved here VERBATIM from `/finance/expenses/new` (loxep-cd3.2, M2 —
 * `expense-entry-design.md` section 1, "The route, and what happens to
 * quick entry") when that path became the real two-pane entry page. The
 * dialog itself is UNCHANGED and stays forever — it is Phase 9's
 * thrift-store-counter target, not a mode of the new page.
 */
export const Route = createFileRoute('/finance/expenses/quick')({
  beforeLoad: () => {
    throw redirect({ to: '/finance/expenses', search: { quickEntry: true } });
  }
});
