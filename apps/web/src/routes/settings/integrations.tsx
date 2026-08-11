import { createFileRoute } from '@tanstack/react-router';
import IntegrationsCatalogGrid from '@/features/settings/components/integrations-catalog-grid';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const Route = createFileRoute('/settings/integrations')({
  component: SettingsIntegrations
});

function SettingsIntegrations() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <SettingsPage
      title='Integrations'
      description='The services Loxep can work with, and how far each one is set up. Accounts are added afterwards on the connections page.'
    >
      <IntegrationsCatalogGrid isAdmin={isAdmin} />
    </SettingsPage>
  );
}
