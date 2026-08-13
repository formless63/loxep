import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/commerce/')({
  beforeLoad: () => {
    throw redirect({ to: '/commerce/overview' });
  }
});
