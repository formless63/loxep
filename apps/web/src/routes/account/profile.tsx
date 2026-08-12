import { createFileRoute } from '@tanstack/react-router';
import { AccountPage } from '@/features/account/components/account-page';
import ProfileForm from '@/features/account/components/profile-form';

export const Route = createFileRoute('/account/profile')({
  component: AccountProfile
});

function AccountProfile() {
  const { auth } = Route.useRouteContext();
  if (!auth) return null;
  return (
    <AccountPage
      title='Profile'
      description='Your name, display name, and avatar. Set once by your identity provider, yours to change at any time.'
    >
      <ProfileForm user={auth.user} />
    </AccountPage>
  );
}
