import type { NavGroup } from '@/types';

/**
 * Finance workspace navigation (loxep-dgf.1, M1). Consumed by both the
 * sidebar and the Cmd+K palette via the shared workspace configuration —
 * see `apps/web/src/config/workspaces.ts` and `getWorkspaceForPath`.
 *
 * "New expense" is a navigation entry, not a separate action-registration
 * mechanism: the command palette (`@/components/command-menu`) only ever
 * lists nav items plus two hardcoded theme actions — `Link`/`navigate` are
 * driven by a plain `url: string`, which TanStack Router resolves as a
 * PATHNAME (it does not parse an embedded `?search` out of an opaque
 * string). So the palette-reachable "record a spend" affordance is its own
 * tiny redirect-only route, `routes/finance/expenses.new.tsx`, which issues a
 * properly-typed `redirect({ to: '/finance/expenses', search: { quickEntry:
 * true } })` that opens the quick-entry dialog on arrival.
 */
export const financeNavGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        title: 'Overview',
        url: '/finance/overview',
        icon: 'dashboard',
        isActive: false,
        shortcut: ['g', 'f'],
        items: []
      }
    ]
  },
  {
    label: 'Expenses',
    items: [
      {
        title: 'Expenses',
        url: '/finance/expenses',
        icon: 'fees',
        isActive: false,
        shortcut: ['g', 'x'],
        items: []
      },
      {
        title: 'New expense',
        url: '/finance/expenses/new',
        icon: 'add',
        isActive: false,
        shortcut: ['g', 'n'],
        items: []
      }
    ]
  },
  {
    label: 'Books',
    items: [
      {
        title: 'Books',
        url: '/finance/books',
        icon: 'ledger',
        isActive: false,
        shortcut: ['g', 'b'],
        items: []
      }
    ]
  }
];
