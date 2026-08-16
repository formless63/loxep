import type { NavGroup } from '@/types';

/**
 * Infrastructure workspace navigation (Phase 7 milestone 3, loxep-lmy.3).
 * Consumed by both the sidebar and the Cmd+K palette via the shared
 * workspace configuration, the same shape `market.ts`/`inventory.ts` use.
 */
export const infrastructureNavGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        title: 'Overview',
        url: '/infrastructure/overview',
        icon: 'dashboard',
        isActive: false,
        shortcut: ['g', 'f'],
        items: []
      }
    ]
  },
  {
    label: 'Domains',
    items: [
      {
        title: 'Domains',
        url: '/infrastructure/domains',
        icon: 'search',
        isActive: false,
        shortcut: ['g', 'd'],
        items: []
      }
    ]
  },
  {
    label: 'Fleet',
    items: [
      {
        title: 'Fleet',
        url: '/infrastructure/fleet',
        icon: 'integrations',
        isActive: false,
        shortcut: ['g', 't'],
        items: []
      }
    ]
  },
  {
    label: 'Templates',
    items: [
      {
        title: 'Templates',
        url: '/infrastructure/templates',
        icon: 'integrations',
        isActive: false,
        shortcut: ['g', 'p'],
        items: []
      }
    ]
  },
  {
    label: 'History',
    items: [
      {
        title: 'Reconcile runs',
        url: '/infrastructure/runs',
        icon: 'clock',
        isActive: false,
        shortcut: ['g', 'r'],
        items: []
      }
    ]
  },
  {
    label: 'Dynamic IP',
    items: [
      {
        title: 'IP aliases',
        url: '/infrastructure/aliases',
        icon: 'integrations',
        isActive: false,
        shortcut: ['g', 'a'],
        items: []
      }
    ]
  }
];
