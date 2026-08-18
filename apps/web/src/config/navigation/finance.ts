import type { NavGroup } from '@/types';

/**
 * Finance workspace navigation (loxep-dgf.1, M1; loxep-cd3.2, M2). Consumed
 * by both the sidebar and the Cmd+K palette via the shared workspace
 * configuration — see `apps/web/src/config/workspaces.ts` and
 * `getWorkspaceForPath`.
 *
 * OWNER REVERSAL (2026-08-17, `expense-entry-design.md` decision 1): the
 * one-screen quick-entry dialog and its redirect-only route
 * (`routes/finance/expenses.quick.tsx`) are REMOVED. "New expense" is now
 * the ONE entry for recording a spend — it points straight at the real
 * two-pane `/finance/expenses/new` page, no redirect indirection needed.
 * The "Quick expense" nav entry is gone; its `['g', 'n']` shortcut is freed
 * for reuse.
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
      },
      {
        title: 'Posting rules',
        url: '/finance/posting-rules',
        icon: 'adjustments',
        isActive: false,
        shortcut: ['g', 'r'],
        items: []
      }
    ]
  },
  {
    label: 'Partners',
    items: [
      {
        title: 'Trading partners',
        url: '/finance/partners',
        icon: 'teams',
        isActive: false,
        shortcut: ['g', 'p'],
        items: []
      }
    ]
  }
];
