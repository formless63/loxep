import { createFileRoute } from '@tanstack/react-router';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import UsersTable from '@/features/settings/components/users-table';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const Route = createFileRoute('/settings/users')({
  component: SettingsUsers
});

function SettingsUsers() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;
  return (
    <SettingsPage
      title='Users'
      description='Who may become a Loxep user, deployment users, and installation-wide roles (admin / member).'
    >
      {isAdmin ? (
        <UsersTable currentUserId={auth?.user.id ?? ''} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Admin role required</EmptyTitle>
            <EmptyDescription>
              User listing and role management are restricted to administrators.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </SettingsPage>
  );
}
