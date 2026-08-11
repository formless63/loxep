import { createFileRoute } from '@tanstack/react-router';
import ApplicationSettings from '@/features/settings/components/application-settings';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const Route = createFileRoute('/settings/application')({
  component: SettingsApplication
});

function SettingsApplication() {
  return (
    <SettingsPage
      title='Application settings'
      description='Database-backed application configuration (ADR-0016) — secrets never appear here.'
    >
      <ApplicationSettings />
    </SettingsPage>
  );
}
