import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import CommandMenu from '@/components/command-menu';
import AppSidebar from '@/components/layout/app-sidebar';
import Header from '@/components/layout/header';
import { InfoSidebar } from '@/components/layout/info-sidebar';
import { InfobarProvider } from '@/components/ui/infobar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

export const Route = createFileRoute('/commerce')({
  beforeLoad: ({ context }) => {
    if (!context.auth) {
      throw redirect({ to: '/auth/sign-in' });
    }
  },
  head: () => ({
    meta: [
      { title: 'Commerce — Loxep' },
      {
        name: 'description',
        content: 'Loxep commerce workspace — catalog, channel listings, and manual/offline sales'
      },
      { name: 'robots', content: 'noindex, nofollow' }
    ]
  }),
  component: CommerceLayout
});

function CommerceLayout() {
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
