import type { NavGroup } from '@/types';

/**
 * Commerce workspace navigation (loxep-dgf.6, Flipping M6). Consumed by both
 * the sidebar and the Cmd+K palette via `@/config/workspaces.ts`'s shared
 * `getWorkspaceForPath` — see `@/config/navigation/inventory.ts` for the same
 * pattern.
 *
 * `/commerce` is the last of the three Phase 9 workspace roots to arrive
 * (flipping-lifecycle-design.md, "Where the surfaces live"): listings depend
 * on enrichment, which depends on the inventory workspace existing. Orders
 * have no surface yet — this milestone ships listings incl. manual/offline
 * and the catalog only; "Orders move here from nowhere" is a later
 * milestone's line to write.
 */
export const commerceNavGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        title: 'Overview',
        url: '/commerce/overview',
        icon: 'dashboard',
        isActive: false,
        shortcut: ['g', 'c'],
        items: []
      }
    ]
  },
  {
    label: 'Catalog and listings',
    items: [
      {
        title: 'Listings',
        url: '/commerce/listings',
        icon: 'billing',
        isActive: false,
        shortcut: ['g', 'x'],
        items: []
      },
      {
        title: 'Catalog',
        url: '/commerce/catalog',
        icon: 'product',
        isActive: false,
        shortcut: ['g', 'k'],
        items: []
      }
    ]
  }
];
