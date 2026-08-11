import { createFileRoute } from '@tanstack/react-router';
import StorageBackendsTable from '@/features/settings/components/storage-backends-table';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const Route = createFileRoute('/settings/storage')({
  component: SettingsStorage
});

function SettingsStorage() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <SettingsPage
      title='Storage backends'
      description='Media storage destinations behind the local/S3 driver abstraction.'
    >
      <StorageBackendsTable isAdmin={isAdmin} />
    </SettingsPage>
  );
}
