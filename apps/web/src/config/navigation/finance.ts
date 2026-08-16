import type { NavGroup } from '@/types';

/**
 * Finance workspace navigation (loxep-dgf.1, M1; loxep-cd3.2, M2). Consumed
 * by both the sidebar and the Cmd+K palette via the shared workspace
 * configuration — see `apps/web/src/config/workspaces.ts` and
 * `getWorkspaceForPath`.
 *
 * TWO entries exist for recording a spend, and neither is a mode of the
 * other (`expense-entry-design.md` section 1, "The route, and what happens
 * to quick entry"): "Quick expense" is capture (the one-screen dialog,
 * Phase 9's thrift-store-counter target) and "New expense" is composition
 * (the two-pane `/finance/expenses/new` page, form and evidence pane side by
 * side). Both must be palette-reachable, so both are plain nav entries — the
 * command palette (`@/components/command-menu`) only ever lists nav items
 * plus two hardcoded theme actions, and `Link`/`navigate` are driven by a
 * plain `url: string`, which TanStack Router resolves as a PATHNAME (it does
 * not parse an embedded `?search` out of an opaque string). So "Quick
 * expense" points at its own tiny redirect-only route,
 * `routes/finance/expenses.quick.tsx`, which issues a properly-typed
 * `redirect({ to: '/finance/expenses', search: { quickEntry: true } })` that
 * opens the quick-entry dialog on arrival — "New expense" needs no such
 * indirection because `/finance/expenses/new` IS the real page.
 *
 * "Estates" (loxep-47o.8) points at `/finance/estate` — the ONE nav entry
 * Rule N2 allows this workspace for the estate-browser program, mirroring
 * `config/navigation/infrastructure.ts`'s own "Estates" item exactly. It is
 * placed ahead of "Expenses" because it is the workspace's only other
 * top-level list (alongside Overview and Books).
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
    label: 'Estates',
    items: [
      {
        title: 'Estates',
        url: '/finance/estate',
        icon: 'integrations',
        isActive: false,
        shortcut: ['g', 's'],
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
        title: 'Quick expense',
        url: '/finance/expenses/quick',
        icon: 'add',
        isActive: false,
        shortcut: ['g', 'n'],
        items: []
      },
      {
        title: 'New expense',
        url: '/finance/expenses/new',
        icon: 'edit',
        isActive: false,
        shortcut: ['g', 'e'],
        items: []
      },
      {
        title: 'Import',
        url: '/finance/import',
        icon: 'upload',
        isActive: false,
        shortcut: ['g', 'i'],
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
