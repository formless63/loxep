import { createFileRoute } from '@tanstack/react-router';
import ConnectionsTable from '@/features/settings/components/connections-table';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const Route = createFileRoute('/settings/connections')({
  component: SettingsConnections
});

function SettingsConnections() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <SettingsPage
      title='Connections'
      description='Configured relationships to external accounts, stores, and services.'
    >
      <ConnectionsTable isAdmin={isAdmin} />
    </SettingsPage>
  );
}
