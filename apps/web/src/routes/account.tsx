import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import CommandMenu from '@/components/command-menu';
import AppSidebar from '@/components/layout/app-sidebar';
import Header from '@/components/layout/header';
import { InfoSidebar } from '@/components/layout/info-sidebar';
import { InfobarProvider } from '@/components/ui/infobar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

/**
 * `/account/*` — the signed-in user's own account surfaces.
 *
 * Deliberately *not* a workspace (`src/config/workspaces.ts`): account
 * controls belong to the shared application shell, and the workspace switcher
 * is kept independent of user identity (Workspaces & Navigation, constraint
 * 5). The route family is reached from the sidebar account menu, keeps the
 * shell of whatever workspace the user came from, and is self-service only —
 * administering *other* users stays at `/settings/users`.
 */
export const Route = createFileRoute('/account')({
  beforeLoad: ({ context }) => {
    if (!context.auth) {
      throw redirect({ to: '/auth/sign-in' });
    }
  },
  head: () => ({
    meta: [
      { title: 'Account — Loxep' },
      {
        name: 'description',
        content: 'Your Loxep account — profile, name, and avatar'
      },
      { name: 'robots', content: 'noindex, nofollow' }
    ]
  }),
  component: AccountLayout
});

function AccountLayout() {
  return (
    <CommandMenu>
      <SidebarProvider>
        <a
          href='#main-content'
          className='sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring'
        >
          Skip to content
        </a>
        <AppSidebar />
        <SidebarInset id='main-content' tabIndex={-1}>
          <Header />
          <InfobarProvider defaultOpen={false}>
            <Outlet />
            <InfoSidebar side='right' />
          </InfobarProvider>
        </SidebarInset>
      </SidebarProvider>
    </CommandMenu>
  );
}
