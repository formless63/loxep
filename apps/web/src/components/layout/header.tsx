import React from 'react';
import { useLocation } from '@tanstack/react-router';
import { SidebarTrigger } from '../ui/sidebar';
import { Separator } from '../ui/separator';
import { Breadcrumbs } from '../breadcrumbs';
import SearchInput from '../search-input';
import { ThemeSelector } from '../themes/theme-selector';
import { ThemeModeToggle } from '../themes/theme-mode-toggle';
import CtaGithub from './cta-github';
import { getWorkspaceForPath } from '@/config/workspaces';
import { NotificationCenter } from '@/features/notifications/components/notification-center';

export default function Header() {
  const { pathname } = useLocation();
  const activeWorkspace = getWorkspaceForPath(pathname);
  // PROVISIONAL (loxep-67w): the notification bell is hidden on every product
  // surface. features/notifications/** is donor/reference code the repo
  // deliberately preserves — its mock store is honest inside /starter, but
  // is actively misleading in the real product shell, which has no real
  // notification feed yet. Hide here, don't delete. The bell returns to
  // product surfaces when loxep-oii lands a real feed backed by
  // notification_deliveries; re-enabling it must NOT mean re-enabling
  // mockNotifications.
  const showNotificationBell = activeWorkspace.id === 'starter';

  return (
    <header className='bg-background/60 sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-2 rounded-t-xl border-b backdrop-blur-md px-4'>
      <div className='flex items-center gap-2'>
        <SidebarTrigger className='-ml-1' />
        <Separator orientation='vertical' className='mr-2 h-4' />
        <Breadcrumbs />
      </div>

      <div className='flex items-center gap-2'>
        <CtaGithub />
        <div className='hidden md:flex'>
          <SearchInput />
        </div>
        <ThemeModeToggle />
        <div className='hidden sm:block'>
          <ThemeSelector />
        </div>
        {showNotificationBell && <NotificationCenter />}
      </div>
    </header>
  );
}
