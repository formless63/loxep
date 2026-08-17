import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getWorkspaceForPath, workspaces } from '@/config/workspaces';
import { userDisplayLabel, userInitials } from '@/lib/user-identity';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useFilteredNavGroups } from '@/hooks/use-nav';
import { authClient } from '@/lib/auth-client';
import { Link } from '@tanstack/react-router';
import { useLocation, useRouteContext, useRouter } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';
import { Icons } from '../icons';

async function handleSignOut() {
  const { error } = await authClient.signOut();
  if (error) {
    toast.error(error.message || 'Sign out failed. Please try again.');
    return;
  }
  // Full navigation so the server re-evaluates the session for every route.
  window.location.assign('/auth/sign-in');
}
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar
} from '@/components/ui/sidebar';

export default function AppSidebar() {
  const { pathname } = useLocation();
  const { isOpen } = useMediaQuery();
  const { isMobile, setOpenMobile } = useSidebar();
  const router = useRouter();
  // On a phone the sidebar is a Sheet overlaying the page; navigating must
  // dismiss it, or the destination renders underneath a still-open menu
  // (loxep-0g4 W5's finding). Keyed on the pathname rather than per-link
  // onClick so every navigation path — nav link, workspace switcher,
  // command palette — dismisses it. No-op on desktop.
  React.useEffect(() => {
    if (isMobile) setOpenMobile(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close on route change only
  }, [pathname]);
  const { auth } = useRouteContext({ from: '__root__' });
  const activeWorkspace = getWorkspaceForPath(pathname);
  const filteredGroups = useFilteredNavGroups(activeWorkspace.navGroups);

  // displayName → name → email → 'User' (`@/lib/user-identity`), so the
  // account button, the profile page, and anything added later name the
  // signed-in person the same way.
  const userName = userDisplayLabel(auth?.user);
  const userEmail = auth?.user.email ?? '';
  const userImage = auth?.user.image ?? '';

  React.useEffect(() => {
    // Side effects based on sidebar state changes
  }, [isOpen]);

  return (
    <Sidebar variant='inset' collapsible='icon'>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size='lg'
                  className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
                >
                  <div className='bg-primary text-primary-foreground flex aspect-square size-8 shrink-0 items-center justify-center rounded-md'>
                    <Icons.logo className='size-4' />
                  </div>
                  <div className='grid flex-1 text-left text-sm leading-tight'>
                    <span className='truncate font-semibold'>Loxep</span>
                    <span className='text-muted-foreground truncate text-xs'>
                      {activeWorkspace.label}
                    </span>
                  </div>
                  <Icons.chevronsDown className='ml-auto size-4' />
                </SidebarMenuButton>
              </DropdownMenuTrigger>

              <DropdownMenuContent
                className='w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg'
                side='bottom'
                align='start'
                sideOffset={4}
              >
                <DropdownMenuGroup>
                  {workspaces.map((workspace) => (
                    <DropdownMenuItem
                      key={workspace.id}
                      onClick={() => router.navigate({ to: workspace.defaultPath })}
                    >
                      <div className='grid gap-0.5'>
                        <span className='font-medium'>{workspace.label}</span>
                        <span className='text-muted-foreground text-xs'>
                          {workspace.description}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className='overflow-x-hidden'>
        {filteredGroups.map((group) => (
          <SidebarGroup key={group.label || 'ungrouped'} className='py-0'>
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon ? Icons[item.icon] : Icons.logo;
                return item?.items && item?.items?.length > 0 ? (
                  <Collapsible key={item.title} defaultOpen={item.isActive} asChild>
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton
                          tooltip={item.title}
                          isActive={pathname === item.url}
                          className='group/collapsible'
                        >
                          {item.icon && <Icon />}
                          <span>{item.title}</span>
                          <Icons.chevronRight className='ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90' />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {item.items?.map((subItem) => (
                            <SidebarMenuSubItem key={subItem.title}>
                              <SidebarMenuSubButton asChild isActive={pathname === subItem.url}>
                                <Link to={subItem.url} aria-label={subItem.title}>
                                  <span>{subItem.title}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                ) : (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      tooltip={item.title}
                      isActive={pathname === item.url}
                    >
                      <Link to={item.url} aria-label={item.title}>
                        <Icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size='lg'
                  className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
                >
                  <Avatar className='size-8 shrink-0'>
                    {userImage && <AvatarImage src={userImage} alt='' />}
                    <AvatarFallback>{userInitials(auth?.user)}</AvatarFallback>
                  </Avatar>
                  <div className='grid flex-1 text-left text-sm leading-tight'>
                    <span className='truncate font-medium'>{userName}</span>
                    <span className='text-muted-foreground truncate text-xs'>{userEmail}</span>
                  </div>
                  <Icons.chevronsDown className='ml-auto size-4' />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className='w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg'
                side='bottom'
                align='end'
                sideOffset={4}
              >
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => router.navigate({ to: '/account/profile' })}>
                    <Icons.account className='mr-2 h-4 w-4' />
                    Account
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      router.navigate({
                        to:
                          activeWorkspace.id === 'starter'
                            ? '/starter/notifications'
                            : '/dashboard/overview'
                      })
                    }
                  >
                    <Icons.notification className='mr-2 h-4 w-4' />
                    Notifications
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSignOut}>
                  <Icons.logout className='mr-2 h-4 w-4' />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
