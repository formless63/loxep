import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    throw redirect({ to: context.auth ? '/dashboard/overview' : '/auth/sign-in' });
  }
});
