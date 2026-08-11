import type { NavGroup } from '@/types';

/**
 * Settings workspace navigation. Consumed by both the sidebar and the Cmd+K
 * palette via the shared workspace configuration.
 */
export const settingsNavGroups: NavGroup[] = [
  {
    label: 'General',
    items: [
      {
        title: 'Overview',
        url: '/settings/overview',
        icon: 'settings',
        isActive: false,
        shortcut: ['g', 's'],
        items: []
      }
    ]
  },
  {
    label: 'Directory',
    items: [
      {
        title: 'Economic entities',
        url: '/settings/entities',
        icon: 'product',
        isActive: false,
        shortcut: ['g', 'e'],
        items: []
      },
      {
        title: 'Connections',
        url: '/settings/connections',
        icon: 'share',
        isActive: false,
        shortcut: ['g', 'c'],
        items: []
      }
    ]
  },
  {
    label: 'Storage',
    items: [
      {
        title: 'Storage backends',
        url: '/settings/storage',
        icon: 'media',
        isActive: false,
        shortcut: ['g', 'b'],
        items: []
      }
    ]
  },
  {
    label: 'Users',
    items: [
      {
        title: 'Users',
        url: '/settings/users',
        icon: 'teams',
        isActive: false,
        shortcut: ['g', 'u'],
        items: []
      }
    ]
  },
  {
    label: 'Application',
    items: [
      {
        title: 'Settings',
        url: '/settings/application',
        icon: 'adjustments',
        isActive: false,
        shortcut: ['g', 'a'],
        items: []
      }
    ]
  }
];
