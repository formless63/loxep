import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/finance/')({
  beforeLoad: () => {
    throw redirect({ to: '/finance/overview' });
  }
});
