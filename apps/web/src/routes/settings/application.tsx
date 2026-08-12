import { createFileRoute } from '@tanstack/react-router';
import ApplicationSettings from '@/features/settings/components/application-settings';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const Route = createFileRoute('/settings/application')({
  component: SettingsApplication
});

function SettingsApplication() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <SettingsPage
      title='Application settings'
      description='Database-backed application configuration — secrets never appear here.'
    >
      <ApplicationSettings isAdmin={isAdmin} />
    </SettingsPage>
  );
}
