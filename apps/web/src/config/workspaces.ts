import type { NavGroup, NavItem } from '@/types';
import { commerceNavGroups } from '@/config/navigation/commerce';
import { dashboardNavGroups } from '@/config/navigation/dashboard';
import { financeNavGroups } from '@/config/navigation/finance';
import { infrastructureNavGroups } from '@/config/navigation/infrastructure';
import { inventoryNavGroups } from '@/config/navigation/inventory';
import { marketNavGroups } from '@/config/navigation/market';
import { settingsNavGroups } from '@/config/navigation/settings';
import { starterNavGroups } from '@/config/navigation/starter';

export type WorkspaceId =
  | 'dashboard'
  | 'market'
  | 'finance'
  | 'inventory'
  | 'commerce'
  | 'infrastructure'
  | 'settings'
  | 'starter';

export type Workspace = {
  id: WorkspaceId;
  label: string;
  description: string;
  /** Used by the dashboard launchpad's Workspaces tiles (loxep-koj). */
  icon: NonNullable<NavItem['icon']>;
  root: string;
  defaultPath: string;
  navGroups: NavGroup[];
};

export const workspaces: Workspace[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Money, market, operations, and the ledger',
    icon: 'dashboard',
    root: '/dashboard',
    defaultPath: '/dashboard/overview',
    navGroups: dashboardNavGroups
  },
  {
    id: 'market',
    label: 'Market',
    description: 'Monitors, watched items, and market events',
    icon: 'radar',
    root: '/market',
    defaultPath: '/market/overview',
    navGroups: marketNavGroups
  },
  {
    id: 'finance',
    label: 'Finance',
    description: 'Expense capture, receipts, and the expense reports',
    icon: 'ledger',
    root: '/finance',
    defaultPath: '/finance/overview',
    navGroups: financeNavGroups
  },
  {
    id: 'inventory',
    label: 'Inventory',
    description: 'Stock, locations, acquisitions, and movements',
    icon: 'product',
    root: '/inventory',
    defaultPath: '/inventory/overview',
    navGroups: inventoryNavGroups
  },
  {
    id: 'commerce',
    label: 'Commerce',
    description: 'Catalog, channel listings, and manual/offline sales',
    icon: 'orders',
    root: '/commerce',
    defaultPath: '/commerce/overview',
    navGroups: commerceNavGroups
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Managed domains, DNS, mail, and the hosting fleet',
    icon: 'integrations',
    root: '/infrastructure',
    defaultPath: '/infrastructure/overview',
    navGroups: infrastructureNavGroups
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Administration & diagnostics',
    icon: 'settings',
    root: '/settings',
    defaultPath: '/settings/overview',
    navGroups: settingsNavGroups
  },
  {
    id: 'starter',
    label: 'Starter Reference',
    description: 'UI pattern reference',
    icon: 'workspace',
    root: '/starter',
    defaultPath: '/starter/overview',
    navGroups: starterNavGroups
  }
];

export function getWorkspaceForPath(pathname: string): Workspace {
  return (
    workspaces.find(
      (workspace) => pathname === workspace.root || pathname.startsWith(`${workspace.root}/`)
    ) ?? workspaces[0]
  );
}
