import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/starter/')({
  beforeLoad: () => {
    throw redirect({ to: '/starter/overview' });
  }
});
