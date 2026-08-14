import type { NavGroup } from '@/types';

/**
 * Commerce workspace navigation (loxep-dgf.6, Flipping M6; orders added
 * loxep-i51). Consumed by both the sidebar and the Cmd+K palette via
 * `@/config/workspaces.ts`'s shared `getWorkspaceForPath` — see
 * `@/config/navigation/inventory.ts` for the same pattern.
 *
 * `/commerce` is the last of the three Phase 9 workspace roots to arrive
 * (flipping-lifecycle-design.md, "Where the surfaces live"): listings depend
 * on enrichment, which depends on the inventory workspace existing.
 *
 * Orders moved here from nowhere (loxep-i51, WEAVE AUDIT 2026-08 finding
 * 7): Woo/eBay/Medusa order ingestion had been writing `orders`,
 * `order_lines`, `order_fees`, `order_refunds`, and `order_fulfillments`
 * since Phase 3 landed, visible only as a dashboard Money-band aggregate —
 * no row was ever rendered. `/commerce/orders` (list + detail) is that
 * surface now, own group so it reads as a peer of "Catalog and listings"
 * rather than a sub-item of it (orders reference catalog/listings rows via
 * opportunistic joins, but Commerce and Catalog-and-Listings are documented
 * as distinct domains — see commerce-schema-design.md's "Scope").
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
    label: 'Orders',
    items: [
      {
        title: 'Orders',
        url: '/commerce/orders',
        icon: 'orders',
        isActive: false,
        shortcut: ['g', 'o'],
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
