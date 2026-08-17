/**
 * The /dashboard sidebar's launchpad sections (loxep-koj): "Pinned" (above)
 * and "Workspaces" (below), rendered by `AppSidebar` only when the active
 * workspace is `dashboard`. Dashboard's own nav content
 * (`config/navigation/dashboard.ts`) still renders through the normal
 * `filteredGroups` loop above these — this file only adds the two
 * dashboard-specific groups, it does not touch `NavGroup` or hardcode a
 * second workspace list.
 */
import { Link } from '@tanstack/react-router';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar';
import { workspaces } from '@/config/workspaces';
import { usePinnedPages, usePinnedPagesActions } from '@/hooks/use-pinned-pages';

/**
 * Every workspace the launchpad can jump to, in `workspaces` order. Today
 * `useFilteredNavGroups`/the header switcher apply no role-based gating —
 * RBAC was removed — so this mirrors the header dropdown's own unfiltered
 * `workspaces.map(...)` exactly, with the two exclusions the bead calls
 * for: `dashboard` itself (already the active surface) and `starter` (donor
 * reference, never a product destination). If workspace-level gating is
 * ever reintroduced, it belongs here as the same check the header dropdown
 * applies, not a separate rule.
 */
const LAUNCHPAD_WORKSPACES = workspaces.filter(
  (workspace) => workspace.id !== 'dashboard' && workspace.id !== 'starter'
);

export function WorkspacesNavGroup() {
  if (LAUNCHPAD_WORKSPACES.length === 0) return null;

  return (
    <SidebarGroup className='py-0'>
      <SidebarGroupLabel>Workspaces</SidebarGroupLabel>
      <SidebarMenu>
        {LAUNCHPAD_WORKSPACES.map((workspace) => {
          const Icon = Icons[workspace.icon];
          return (
            <SidebarMenuItem key={workspace.id}>
              <SidebarMenuButton asChild className='group h-auto items-start py-2'>
                <Link to={workspace.defaultPath} aria-label={workspace.label}>
                  <span className='bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary flex size-6 shrink-0 items-center justify-center rounded-md transition-colors'>
                    <Icon className='size-3.5' />
                  </span>
                  <span className='grid flex-1 gap-0.5 overflow-hidden text-left'>
                    <span className='truncate'>{workspace.label}</span>
                    <span className='text-muted-foreground truncate text-xs'>
                      {workspace.description}
                    </span>
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function workspaceLabel(workspaceId: string): string {
  return workspaces.find((workspace) => workspace.id === workspaceId)?.label ?? workspaceId;
}

export function PinnedNavGroup() {
  const pinned = usePinnedPages();
  const { unpin } = usePinnedPagesActions();

  return (
    <SidebarGroup className='py-0'>
      <SidebarGroupLabel>Pinned</SidebarGroupLabel>
      {pinned.length === 0 ? (
        <p className='text-muted-foreground px-2 py-1.5 text-xs'>
          Pin pages from any sidebar for one-tap access
        </p>
      ) : (
        <SidebarMenu>
          {pinned.map((page) => {
            const Icon = page.icon ? Icons[page.icon] : Icons.page;
            return (
              <SidebarMenuItem key={page.url}>
                <SidebarMenuButton asChild tooltip={page.title}>
                  <Link to={page.url} aria-label={page.title}>
                    <Icon />
                    <span className='truncate'>{page.title}</span>
                    <Badge variant='outline' className='ml-auto shrink-0 text-[10px]'>
                      {workspaceLabel(page.workspaceId)}
                    </Badge>
                  </Link>
                </SidebarMenuButton>
                <SidebarMenuAction
                  showOnHover
                  className='opacity-60 md:opacity-0'
                  aria-label={`Unpin ${page.title}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    unpin(page.url);
                  }}
                >
                  <Icons.pinFilled className='text-primary' />
                  <span className='sr-only'>Unpin</span>
                </SidebarMenuAction>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
