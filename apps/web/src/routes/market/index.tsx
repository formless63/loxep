import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/market/')({
  beforeLoad: () => {
    throw redirect({ to: '/market/overview' });
  }
});
