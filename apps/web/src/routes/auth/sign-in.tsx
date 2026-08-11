import { createFileRoute, redirect } from '@tanstack/react-router';
import { fetchLoginPaths } from '@/server/auth-functions';
import { SignInView } from '@/features/auth/components/sign-in-view';

/**
 * Sign-in surface (ADR-0007): magic-link email plus optional OIDC SSO.
 * A peer route outside the app shell — no sidebar/header chrome.
 */
export const Route = createFileRoute('/auth/sign-in')({
  head: () => ({
    meta: [{ title: 'Sign in — Loxep' }, { name: 'robots', content: 'noindex, nofollow' }]
  }),
  beforeLoad: ({ context }) => {
    if (context.auth) {
      throw redirect({ to: '/dashboard/overview' });
    }
  },
  loader: () => fetchLoginPaths(),
  component: SignInPage
});

function SignInPage() {
  const loginPaths = Route.useLoaderData();
  return <SignInView loginPaths={loginPaths} />;
}
