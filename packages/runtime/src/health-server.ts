import { createServer, type Server } from 'node:http';
import { liveness, readiness, readinessHttpStatus } from './health.ts';

interface MinimalLogger {
  info: (obj: object | string, msg?: string) => void;
  error: (obj: object | string, msg?: string) => void;
}

/**
 * Health-only HTTP listener for LOXEP_MODE=worker, where no web runtime binds
 * the application port. Serves the same /health contract as the web server
 * routes so orchestrator probes are mode-agnostic (ADR-0018).
 */
export function startHealthServer(options: { port: number; logger: MinimalLogger }): Promise<Server> {
  const { port, logger } = options;
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    void (async () => {
      if (url === '/health/live') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(liveness()));
        return;
      }
      if (url === '/health/ready') {
        const report = await readiness();
        res.writeHead(readinessHttpStatus(report), { 'content-type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }
      if (url === '/health') {
        // Observable detail endpoint: always 200, mirroring the web route.
        const report = await readiness();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    })().catch((error: unknown) => {
      logger.error({ err: error }, 'health server request failed');
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      logger.info({ port }, 'health server listening');
      resolve(server);
    });
  });
}
