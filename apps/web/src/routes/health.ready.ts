import { createFileRoute } from '@tanstack/react-router';
import { readiness, readinessHttpStatus } from '@loxep/runtime';

export const Route = createFileRoute('/health/ready')({
  server: {
    handlers: {
      GET: async () => {
        const report = await readiness();
        return Response.json(report, { status: readinessHttpStatus(report) });
      },
    },
  },
});
