import type { NavGroup } from '@/types';
import { dashboardNavGroups } from '@/config/navigation/dashboard';
import { starterNavGroups } from '@/config/navigation/starter';

export type WorkspaceId = 'dashboard' | 'starter';

export type Workspace = {
  id: WorkspaceId;
  label: string;
  description: string;
  root: string;
  defaultPath: string;
  navGroups: NavGroup[];
};

export const workspaces: Workspace[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Loxep overview',
    root: '/dashboard',
    defaultPath: '/dashboard/overview',
    navGroups: dashboardNavGroups
  },
  {
    id: 'starter',
    label: 'Starter Reference',
    description: 'UI pattern reference',
    root: '/starter',
    defaultPath: '/starter/overview',
    navGroups: starterNavGroups
  }
];

export function getWorkspaceForPath(pathname: string): Workspace {
  return (
    workspaces.find(
      (workspace) =>
        pathname === workspace.root || pathname.startsWith(`${workspace.root}/`)
    ) ?? workspaces[0]
  );
}
