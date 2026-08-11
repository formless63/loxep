import { setComponentStatus } from './state.ts';

interface MinimalLogger {
  info: (obj: object | string, msg?: string) => void;
}

export interface EmbeddedWorker {
  stop: () => Promise<void>;
}

/**
 * Placeholder worker runtime. The worker-runtime epic replaces the internals
 * with the real Graphile Worker runner (task registry, retry/backoff, job-key
 * conventions) behind this same start/stop contract; the entrypoint and health
 * wiring do not change when that lands.
 */
export function startEmbeddedWorker(options: { logger: MinimalLogger }): EmbeddedWorker {
  options.logger.info('worker runtime placeholder started (Graphile Worker arrives with the worker-runtime epic)');
  setComponentStatus('worker', { ok: true, detail: 'placeholder runtime' });
  return {
    stop: () => Promise.resolve(),
  };
}
