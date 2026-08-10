import type { NavGroup } from '@/types';

export const dashboardNavGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        title: 'Overview',
        url: '/dashboard/overview',
        icon: 'dashboard',
        isActive: false,
        shortcut: ['g', 'd'],
        items: []
      }
    ]
  }
];
