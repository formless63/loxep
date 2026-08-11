import { createFileRoute } from '@tanstack/react-router';
import NotificationEndpointsTable from '@/features/settings/components/notification-endpoints-table';
import NotificationRulesTable from '@/features/settings/components/notification-rules-table';
import NotificationDeliveriesTable from '@/features/settings/components/notification-deliveries-table';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const Route = createFileRoute('/settings/notifications')({
  component: SettingsNotifications
});

function SettingsNotifications() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <SettingsPage
      title='Notifications'
      description='Delivery endpoints and the rules that route detected events to them — detection and delivery stay separate concepts.'
    >
      <div className='flex flex-col gap-8'>
        <section className='flex flex-col gap-3'>
          <h2 className='text-lg font-medium'>Endpoints</h2>
          <NotificationEndpointsTable isAdmin={isAdmin} />
        </section>
        <section className='flex flex-col gap-3'>
          <h2 className='text-lg font-medium'>Rules</h2>
          <NotificationRulesTable isAdmin={isAdmin} />
        </section>
        <section className='flex flex-col gap-3'>
          <h2 className='text-lg font-medium'>Delivery status</h2>
          <NotificationDeliveriesTable />
        </section>
      </div>
    </SettingsPage>
  );
}
