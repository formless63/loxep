import { createFileRoute } from '@tanstack/react-router';
import { liveness } from '@loxep/runtime';

export const Route = createFileRoute('/health/live')({
  server: {
    handlers: {
      GET: () => Response.json(liveness())
    }
  }
});
