import type { NavGroup } from '@/types';

/**
 * Market workspace navigation. Consumed by both the sidebar and the Cmd+K
 * palette via the shared workspace configuration (loxep-62y.4).
 */
export const marketNavGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        title: 'Overview',
        url: '/market/overview',
        icon: 'dashboard',
        isActive: false,
        shortcut: ['g', 'm'],
        items: []
      }
    ]
  },
  {
    label: 'Monitors',
    items: [
      {
        title: 'Monitors',
        url: '/market/monitors',
        icon: 'search',
        isActive: false,
        shortcut: ['g', 'o'],
        items: []
      }
    ]
  },
  {
    label: 'Items',
    items: [
      {
        title: 'Watched items',
        url: '/market/items',
        icon: 'product',
        isActive: false,
        shortcut: ['g', 'i'],
        items: []
      }
    ]
  }
];
