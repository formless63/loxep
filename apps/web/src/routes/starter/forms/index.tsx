import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/starter/forms/')({
  beforeLoad: () => {
    throw redirect({ to: '/starter/forms/basic' });
  }
});
