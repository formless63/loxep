import { createFileRoute } from '@tanstack/react-router';
import EntitiesTable from '@/features/settings/components/entities-table';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const Route = createFileRoute('/settings/entities')({
  component: SettingsEntities
});

function SettingsEntities() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <SettingsPage
      title='Economic entities'
      description='Attribution and business-context records — not users, permissions, or accounting books.'
    >
      <EntitiesTable isAdmin={isAdmin} />
    </SettingsPage>
  );
}
