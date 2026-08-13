import { createFileRoute } from '@tanstack/react-router';
import HealthReport from '@/features/settings/components/health-report';
import IntegrationHealthReport from '@/features/settings/components/integration-health-report';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const Route = createFileRoute('/settings/overview')({
  component: SettingsOverview
});

function SettingsOverview() {
  return (
    <SettingsPage
      title='Settings'
      description='Installation health, administration, and diagnostics.'
    >
      <div className='flex flex-col gap-4'>
        <HealthReport />
        <IntegrationHealthReport />
      </div>
    </SettingsPage>
  );
}
