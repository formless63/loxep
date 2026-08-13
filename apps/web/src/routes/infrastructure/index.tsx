import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/infrastructure/')({
  beforeLoad: () => {
    throw redirect({ to: '/infrastructure/overview' });
  }
});
