import { registerHealthCheck, setComponentStatus } from './state.ts';
import type { StartWorkerRuntimeOptions, WorkerRuntime } from '@loxep/jobs';

/**
 * Embedded Graphile Worker lifecycle (ADR-0003, ADR-0013, ADR-0018).
 *
 * `@loxep/jobs` (and with it graphile-worker) is loaded LAZILY via dynamic
 * import inside {@link startEmbeddedWorker}: this package is also imported by
 * the web bundle's health routes, and only the entrypoint's worker modes may
 * pull the job runtime into the process. Keep any top-level reference to
 * `@loxep/jobs` type-only, and keep this package free of runtime
 * dependencies.
 */

export interface EmbeddedWorker {
  stop: () => Promise<void>;
}

/**
 * What the composition root (`@loxep/app`) hands back: the task registry to
 * run, optionally the cron schedules that go with it, and an optional
 * teardown for anything the composition owns (e.g. its database pool).
 *
 * Typed structurally off `@loxep/jobs`'s own options so this package still
 * takes no runtime dependency on the job system.
 */
export interface WorkerRegistryComposition {
  registry: NonNullable<StartWorkerRuntimeOptions['registry']>;
  cronItems?: StartWorkerRuntimeOptions['cronItems'];
  close?: () => Promise<void>;
}

export interface StartEmbeddedWorkerOptions {
  logger: StartWorkerRuntimeOptions['logger'];
  databaseUrl: string;
  concurrency?: number;
  /**
   * Compose the task registry to run. Called lazily INSIDE the worker start
   * so that only worker-capable modes ever load the composition root and its
   * provider integrations; omitting it keeps `@loxep/jobs`' own defaults
   * (heartbeat only), which is exactly the pre-Phase-1 behaviour.
   */
  buildRegistry?: () => Promise<WorkerRegistryComposition>;
}

/**
 * Start the embedded worker runtime and wire it into runtime health:
 *  - component `worker` flips ready on successful start (and not-ready if the
 *    runner later crashes, or if startup fails — startup failure does not
 *    crash the process, matching ADR-0018's fail-readiness-with-diagnostic);
 *  - readiness check `worker-jobs` reports queue statistics as detail. Per
 *    ADR-0018 a degraded backlog or failed jobs are observable detail, not
 *    automatic unreadiness — the check only reports not-ok when the runner
 *    itself has crashed.
 */
export async function startEmbeddedWorker(options: StartEmbeddedWorkerOptions): Promise<EmbeddedWorker> {
  const { logger, databaseUrl, concurrency, buildRegistry } = options;

  let runtime: WorkerRuntime;
  let composition: WorkerRegistryComposition | undefined;
  try {
    // Composition first: a registry that cannot be built is a startup
    // failure, not a half-started worker running the wrong task list.
    composition = buildRegistry === undefined ? undefined : await buildRegistry();
    const { startWorkerRuntime } = await import('@loxep/jobs');
    runtime = await startWorkerRuntime({
      databaseUrl,
      logger,
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(composition !== undefined ? { registry: composition.registry } : {}),
      ...(composition?.cronItems !== undefined ? { cronItems: composition.cronItems } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error({ err: detail }, 'worker runtime failed to start');
    setComponentStatus('worker', { ok: false, detail: `worker runtime failed to start: ${detail}` });
    await composition?.close?.().catch(() => undefined);
    return { stop: () => Promise.resolve() };
  }

  let crashDetail: string | null = null;
  runtime.runner.promise.catch((error: unknown) => {
    crashDetail = error instanceof Error ? error.message : String(error);
    setComponentStatus('worker', { ok: false, detail: `worker runner crashed: ${crashDetail}` });
  });

  setComponentStatus('worker', { ok: true });
  registerHealthCheck('worker-jobs', async () => {
    const ok = crashDetail === null;
    const prefix = ok ? '' : `runner crashed: ${crashDetail}; `;
    try {
      const stats = await runtime.getStats();
      return {
        ok,
        detail:
          `${prefix}pending=${stats.pending} running=${stats.running} failed=${stats.failed}` +
          ` oldestPendingSeconds=${stats.oldestPendingSeconds ?? 0}`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok, detail: `${prefix}job stats unavailable: ${detail}` };
    }
  });

  logger.info(
    { tasks: [...(composition?.registry.keys() ?? ['(jobs defaults)'])] },
    'worker runtime started (Graphile Worker embedded, ADR-0018 one-process contract)',
  );
  const owned = composition;
  return {
    stop: async () => {
      try {
        await runtime.stop();
      } finally {
        await owned?.close?.();
      }
    },
  };
}
