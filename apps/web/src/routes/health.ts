import { createFileRoute } from '@tanstack/react-router';
import { readiness } from '@loxep/runtime';

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      // Observable health detail: always 200; degraded conditions are
      // information here, not probe failures (ADR-0018).
      GET: async () => Response.json(await readiness())
    }
  }
});
