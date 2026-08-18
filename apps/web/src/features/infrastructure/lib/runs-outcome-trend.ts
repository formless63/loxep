/**
 * The pure shaping behind `/infrastructure/runs`' outcome chart (loxep-8e2,
 * priority 5), kept in its own module so its unit test does not have to
 * import the chart component — and with it Recharts and the whole React
 * tree — just to exercise arithmetic. Same split as
 * `@/features/market/lib/sort-rows.ts` and `market-functions.test.ts`'s
 * `shapePriceTrends`.
 */
import type { ReconcileRunDto } from '@/server/infrastructure-functions';

export const RUN_STATUS_KEYS = ['succeeded', 'partial', 'failed', 'running'] as const;
export type RunStatusKey = (typeof RUN_STATUS_KEYS)[number];

export interface RunsDayBucket {
  day: string;
  succeeded: number;
  partial: number;
  failed: number;
  running: number;
  /** `null` — not `0` — for a day whose runs are all still in flight; an unfinished run has no duration to average. */
  avgDurationSeconds: number | null;
}

function isRunStatusKey(status: string): status is RunStatusKey {
  return (RUN_STATUS_KEYS as readonly string[]).includes(status);
}

/**
 * Buckets `runs` by calendar day (of `startedAt`), counting outcome per day
 * and averaging duration among the runs that actually finished — no extra
 * query. `runs` is exactly the already-fetched result of
 * `fetchReconcileRuns` (`RECONCILE_RUNS_LIMIT = 100` most recent,
 * `@/server/infrastructure-functions.ts`), so this chart's window is "the
 * last 100 runs," stated here once rather than re-derived per caller.
 *
 * A status outside the `CHECK`ed four is counted into no series rather than
 * folded into `failed` — inventing an outcome for a value this build does
 * not know is worse than showing a short bar.
 */
export function shapeRunsOutcomeTrend(runs: readonly ReconcileRunDto[]): RunsDayBucket[] {
  const byDay = new Map<string, RunsDayBucket>();
  const durationSumsByDay = new Map<string, { sum: number; count: number }>();

  for (const run of runs) {
    const day = run.startedAt.slice(0, 10);
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = { day, succeeded: 0, partial: 0, failed: 0, running: 0, avgDurationSeconds: null };
      byDay.set(day, bucket);
    }
    if (isRunStatusKey(run.status)) bucket[run.status] += 1;

    if (run.finishedAt !== null) {
      const durationSeconds =
        (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000;
      if (Number.isFinite(durationSeconds) && durationSeconds >= 0) {
        const entry = durationSumsByDay.get(day) ?? { sum: 0, count: 0 };
        entry.sum += durationSeconds;
        entry.count += 1;
        durationSumsByDay.set(day, entry);
      }
    }
  }

  for (const [day, { sum, count }] of durationSumsByDay) {
    const bucket = byDay.get(day);
    if (bucket) bucket.avgDurationSeconds = sum / count;
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}
