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
import { NotificationBell } from '@/features/notifications/components/notification-bell';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { useCommandMenu } from '@/components/command-menu';

export default function Header() {
  const { pathname } = useLocation();
  const activeWorkspace = getWorkspaceForPath(pathname);
  // Rule M4: Cmd+K has no phone equivalent, so the palette is otherwise
  // unreachable on mobile — this button is the phone's only entry point,
  // shown exactly where `SearchInput` (the desktop trigger) is hidden.
  const { toggle: toggleCommandMenu } = useCommandMenu();
  // loxep-67w hid the bell on every product surface because the only feed was
  // `mockNotifications`. loxep-oii landed the real one (`notification_events`,
  // ADR-0023), so the bell is back on product surfaces — with its DATA SOURCE
  // replaced, which is exactly what that decision required, not with the mock
  // store restored. The donor `NotificationCenter` and its fiction stay where
  // they are honest: inside `/starter`.
  const isDonorWorkspace = activeWorkspace.id === 'starter';

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
        <Button
          variant='outline'
          size='icon'
          className='md:hidden'
          aria-label='Search'
          onClick={toggleCommandMenu}
        >
          <Icons.search />
        </Button>
        <ThemeModeToggle />
        <div className='hidden sm:block'>
          <ThemeSelector />
        </div>
        {isDonorWorkspace ? <NotificationCenter /> : <NotificationBell />}
      </div>
    </header>
  );
}
