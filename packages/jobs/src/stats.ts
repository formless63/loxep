/**
 * Job-queue health visibility (loxep-680.3, ADR-0018).
 *
 * Reads the `graphile_worker.jobs` view (graphile-worker 0.17: a public view
 * over `_private_jobs`/`_private_tasks`, verified against the packaged SQL).
 * The view exposes `attempts`, `max_attempts`, `last_error`, `locked_at`,
 * `run_at` — everything needed to classify queue state without touching
 * Graphile's private tables.
 *
 * Per ADR-0018, backlog/failure numbers are health *detail*, never automatic
 * unreadiness.
 */

export interface JobStats {
  /** Jobs waiting to run (not locked, retry budget remaining). */
  pending: number;
  /** Jobs currently locked by a worker. */
  running: number;
  /** Permanently failed jobs (attempts exhausted, awaiting cleanup). */
  failed: number;
  /** Age of the oldest due-but-unstarted job, or null when none is due. */
  oldestPendingSeconds: number | null;
}

/** Structural subset of pg.Pool / pg.Client — avoids a runtime pg import. */
export interface Queryable {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Aggregate queue statistics. Throws if the `graphile_worker` schema does not
 * exist yet (it is created by the worker runner at startup); callers surfacing
 * health detail should catch and report that as detail.
 */
export async function getJobStats(pool: Queryable): Promise<JobStats> {
  const result = await pool.query(
    `select
       count(*) filter (where locked_at is null and attempts < max_attempts)::int as pending,
       count(*) filter (where locked_at is not null)::int as running,
       count(*) filter (where locked_at is null and attempts >= max_attempts)::int as failed,
       floor(extract(epoch from now() - min(run_at) filter (
         where locked_at is null and attempts < max_attempts and run_at <= now()
       )))::float8 as oldest_pending_seconds
     from graphile_worker.jobs`,
  );
  const row = result.rows[0] ?? {};
  const oldest = row["oldest_pending_seconds"];
  return {
    pending: Number(row["pending"] ?? 0),
    running: Number(row["running"] ?? 0),
    failed: Number(row["failed"] ?? 0),
    oldestPendingSeconds:
      oldest === null || oldest === undefined ? null : Number(oldest),
  };
}
