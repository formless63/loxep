/**
 * Server functions for `/settings/diagnostics` (loxep-6ea, tier-1 audit
 * finding A1): the dead-letter surface for Graphile Worker.
 *
 * ## Why this reads `graphile_worker.jobs` directly instead of calling
 * `@loxep/jobs`' `getJobStats`
 *
 * `getJobStats` (`packages/jobs/src/stats.ts`) is the obvious verb to mount,
 * but it is only ever wired up by `startEmbeddedWorker`
 * (`packages/runtime/src/worker.ts`) — the `worker-jobs` health check it
 * registers exists only in a process that actually started the embedded
 * worker runtime. In a split `LOXEP_MODE=web` + `LOXEP_MODE=worker`
 * deployment, the `web` process never calls `startEmbeddedWorker`, so that
 * health check — and with it the only place queue stats reached the browser
 * before this bead — does not exist there at all. Worse, `@loxep/jobs`
 * itself must never enter the web bundle (it pulls `graphile-worker`, which
 * this package's sibling server functions keep out via dynamic
 * `@vite-ignore` imports elsewhere in this codebase) — importing it here
 * would risk exactly that.
 *
 * `graphile_worker.jobs` is a plain SQL VIEW (over `_private_jobs`/
 * `_private_tasks`, verified against the pinned `graphile-worker@0.17.3`
 * package's own migration SQL) that graphile-worker creates once, the first
 * time ANY process starts the worker runtime — not per-process. Reading it
 * straight from the database, the way this module does, works in every
 * `LOXEP_MODE` regardless of which process is running right now, which is
 * the fix the audit asked for. The four aggregate numbers below intentionally
 * mirror `getJobStats`' own query (same columns, same predicates) rather than
 * calling it, so the two can drift only if someone edits one and not the
 * other — small enough surface area to keep in sync by inspection.
 *
 * ## Row actions: Retry and Discard
 *
 * Both go through graphile-worker's own PUBLIC administrative functions
 * (`graphile_worker.reschedule_jobs`, added in 0.14 for exactly this kind of
 * operator action) or a plain `DELETE` against `_private_jobs` guarded the
 * same way graphile-worker's own `remove_job`/`reschedule_jobs`/
 * `permanently_fail_jobs` functions guard their writes
 * (`locked_at is null or locked_at < now() - interval '4 hours'`, i.e. never
 * touch a job a worker might currently be executing):
 *
 * - **Retry** calls `reschedule_jobs(job_ids, run_at => now(), attempts =>
 *   0)` — the documented function graphile-worker ships for this. Resets the
 *   attempt counter and schedules the job to run immediately.
 * - **Discard** deletes the row directly. graphile-worker's own public
 *   `remove_job(job_key)` only works for jobs enqueued with a `job_key`
 *   (`packages/jobs/src/conventions.ts`: `jobKey` is optional, used only for
 *   dedupe-able work), so it cannot delete an arbitrary failed job by id —
 *   most jobs never carry one. There is no public "delete by id" function.
 *   `_private_jobs` is graphile-worker's internal storage table (the `jobs`
 *   view is read-only), but the delete this module performs is *exactly*
 *   what graphile-worker's own `complete_job` does on success — `DELETE FROM
 *   _private_jobs WHERE id = ... RETURNING *` — just invoked here for a
 *   failed job an operator has decided to give up on, with the same
 *   never-touch-a-locked-job guard the library's own admin functions use.
 *   This is pinned to the `graphile-worker@0.17.3` schema verified in this
 *   repo's `node_modules`; a future graphile-worker upgrade that changes
 *   `_private_jobs`' shape would need this query revisited.
 *
 * Both actions require `attempts >= max_attempts` is not a precondition
 * (a "stuck pending" row is discardable/retryable too) — the server does not
 * re-derive which bucket a job is in, it just acts on the id.
 *
 * Role gate: everything here is `requireAdmin` (ADR-0017) — this is
 * operational machinery, not ordinary product data.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

export interface JobStatsDto {
  pending: number;
  running: number;
  failed: number;
  oldestPendingSeconds: number | null;
}

export type JobDiagnosticBucket = 'failed' | 'pending';

export interface JobDiagnosticRowDto {
  id: string;
  taskIdentifier: string;
  bucket: JobDiagnosticBucket;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
  lockedAt: string | null;
  createdAt: string;
}

const FAILED_JOBS_LIMIT = 200;
const OLDEST_PENDING_LIMIT = 25;

function toStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export const fetchJobStats = createServerFn({ method: 'GET' }).handler(
  async (): Promise<JobStatsDto> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    await requireAdmin();
    const { handle } = getAdminServices();
    const result = await handle.db.execute(
      `select
         count(*) filter (where locked_at is null and attempts < max_attempts)::int as pending,
         count(*) filter (where locked_at is not null)::int as running,
         count(*) filter (where locked_at is null and attempts >= max_attempts)::int as failed,
         floor(extract(epoch from now() - min(run_at) filter (
           where locked_at is null and attempts < max_attempts and run_at <= now()
         )))::float8 as oldest_pending_seconds
       from graphile_worker.jobs`
    );
    const row = result.rows[0] ?? {};
    const oldest = row['oldest_pending_seconds'];
    return {
      pending: Number(row['pending'] ?? 0),
      running: Number(row['running'] ?? 0),
      failed: Number(row['failed'] ?? 0),
      oldestPendingSeconds: oldest === null || oldest === undefined ? null : Number(oldest)
    };
  }
);

/**
 * Failed jobs (attempts exhausted) plus the oldest still-pending jobs — the
 * table the diagnostics page renders. Unbounded/unpaginated by server
 * contract (capped at {@link FAILED_JOBS_LIMIT}/{@link OLDEST_PENDING_LIMIT}
 * rows each): Frontend Standards' "one legitimate exception" for
 * client-side sort/filter over a fully-fetched result set, matching a
 * genuinely small operational backlog rather than a growing product table.
 */
export const fetchJobDiagnostics = createServerFn({ method: 'GET' }).handler(
  async (): Promise<JobDiagnosticRowDto[]> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    await requireAdmin();
    const { handle } = getAdminServices();
    const result = await handle.db.execute(
      `(
         select id::text as id, task_identifier, attempts, max_attempts, last_error,
                run_at, locked_at, created_at, 'failed' as bucket
           from graphile_worker.jobs
          where attempts >= max_attempts
          order by updated_at desc
          limit ${FAILED_JOBS_LIMIT}
       )
       union all
       (
         select id::text as id, task_identifier, attempts, max_attempts, last_error,
                run_at, locked_at, created_at, 'pending' as bucket
           from graphile_worker.jobs
          where locked_at is null and attempts < max_attempts and run_at <= now()
          order by run_at asc
          limit ${OLDEST_PENDING_LIMIT}
       )
       order by bucket asc, run_at asc`
    );
    return result.rows.map((row): JobDiagnosticRowDto => ({
      id: String(row['id']),
      taskIdentifier: String(row['task_identifier']),
      bucket: row['bucket'] === 'pending' ? 'pending' : 'failed',
      attempts: Number(row['attempts'] ?? 0),
      maxAttempts: Number(row['max_attempts'] ?? 0),
      lastError: toStringOrNull(row['last_error']),
      runAt: String(row['run_at']),
      lockedAt: toStringOrNull(row['locked_at']),
      createdAt: String(row['created_at'])
    }));
  }
);

const jobIdInput = z.strictObject({ jobId: z.string().regex(/^\d+$/, 'expected a job id') });

/** Reset attempts and re-schedule the job to run now — see this module's doc. */
export const retryJob = createServerFn({ method: 'POST' })
  .inputValidator(jobIdInput)
  .handler(async ({ data }): Promise<{ retried: boolean }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    await requireAdmin();
    const { handle } = getAdminServices();
    const result = await handle.db.execute(
      `select id from graphile_worker.reschedule_jobs(
         array[${Number(data.jobId)}]::bigint[],
         run_at => now(),
         attempts => 0
       )`
    );
    return { retried: result.rows.length > 0 };
  });

/** Delete the job row outright — see this module's doc for why this is safe. */
export const discardJob = createServerFn({ method: 'POST' })
  .inputValidator(jobIdInput)
  .handler(async ({ data }): Promise<{ discarded: boolean }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    await requireAdmin();
    const { handle } = getAdminServices();
    const result = await handle.db.execute(
      `delete from graphile_worker._private_jobs
        where id = ${Number(data.jobId)}
          and (locked_at is null or locked_at < now() - interval '4 hours')
        returning id`
    );
    return { discarded: result.rows.length > 0 };
  });
