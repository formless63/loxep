import type { NavGroup } from '@/types';

/**
 * Inventory workspace navigation (loxep-dgf.2, M2). Consumed by both the
 * sidebar and the Cmd+K palette via `@/config/workspaces.ts`'s shared
 * `getWorkspaceForPath` — see `@/config/navigation/finance.ts` for the same
 * pattern.
 *
 * "Intake review" is a nav entry, not a separate screen: the design's one
 * review queue is the stock list filtered to `status=intake`. TanStack
 * Router resolves a plain `url: string` as a PATHNAME and does not parse an
 * embedded `?search` out of it (`@/config/navigation/finance.ts`'s "New
 * expense" hit the same thing), so it is reachable through the redirect-only
 * `routes/inventory/intake.tsx`, which issues a properly-typed
 * `redirect({ to: '/inventory/stock', search: { status: 'intake' } })`.
 */
export const inventoryNavGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        title: 'Overview',
        url: '/inventory/overview',
        icon: 'dashboard',
        isActive: false,
        shortcut: ['g', 'i'],
        items: []
      }
    ]
  },
  {
    label: 'Stock',
    items: [
      {
        title: 'Stock',
        url: '/inventory/stock',
        icon: 'product',
        isActive: false,
        shortcut: ['g', 's'],
        items: []
      },
      {
        title: 'Intake review',
        url: '/inventory/intake',
        icon: 'checks',
        isActive: false,
        shortcut: ['g', 'r'],
        items: []
      },
      {
        title: 'Locations',
        url: '/inventory/locations',
        icon: 'workspace',
        isActive: false,
        shortcut: ['g', 'l'],
        items: []
      }
    ]
  },
  {
    label: 'Acquisitions',
    items: [
      {
        title: 'Acquisitions',
        url: '/inventory/acquisitions',
        icon: 'billing',
        isActive: false,
        shortcut: ['g', 'a'],
        items: []
      },
      {
        title: 'Movements',
        url: '/inventory/movements',
        icon: 'refunds',
        isActive: false,
        shortcut: ['g', 'm'],
        items: []
      }
    ]
  },
  {
    label: 'Profitability',
    items: [
      {
        title: 'Profitability',
        url: '/inventory/profitability',
        icon: 'trendingUp',
        isActive: false,
        shortcut: ['g', 'p'],
        items: []
      }
    ]
  }
];
