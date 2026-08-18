/**
 * Unit test for `shapeRunsOutcomeTrend`, the pure helper behind
 * `/infrastructure/runs`' outcome chart (loxep-8e2, priority 5). Rendering
 * is exercised visually per Frontend Standards' two-themes-plus-dark-mode
 * check, not here — this repo's suite tests pure helpers, matching
 * `stacked-status-bar.test.ts`. The helper lives in its own module rather
 * than the chart component precisely so this file does not import Recharts
 * to test arithmetic (it timed out at the suite's 5s default when it did).
 *
 * The cases that matter: day bucketing is by `startedAt`'s calendar date,
 * duration averages only over runs that actually FINISHED (an in-flight run
 * has no duration and must not drag the average toward zero), and an unknown
 * future status is counted into no series rather than crashing or being
 * silently folded into `failed`.
 */
import { describe, expect, test } from 'bun:test';
import { shapeRunsOutcomeTrend } from './runs-outcome-trend';
import type { ReconcileRunDto } from '@/server/infrastructure-functions';

function run(overrides: Partial<ReconcileRunDto>): ReconcileRunDto {
  return {
    id: 'run-1',
    kind: 'domain.sync',
    subjectType: 'domain',
    subjectId: 'subject-1',
    subjectLabel: 'example.com',
    mode: 'apply',
    status: 'succeeded',
    trigger: 'sweep',
    stepCount: 3,
    errorSummary: null,
    startedAt: '2026-08-17T10:00:00.000Z',
    finishedAt: '2026-08-17T10:00:30.000Z',
    ...overrides
  };
}

describe('shapeRunsOutcomeTrend', () => {
  test('no runs shapes to no buckets — the caller renders its own empty state', () => {
    expect(shapeRunsOutcomeTrend([])).toEqual([]);
  });

  test('buckets by calendar day of startedAt, sorted ascending', () => {
    const trend = shapeRunsOutcomeTrend([
      run({ id: 'b', startedAt: '2026-08-18T01:00:00.000Z', finishedAt: null, status: 'running' }),
      run({ id: 'a', startedAt: '2026-08-16T23:00:00.000Z' })
    ]);
    expect(trend.map((bucket) => bucket.day)).toEqual(['2026-08-16', '2026-08-18']);
  });

  test('counts each outcome into its own series', () => {
    const trend = shapeRunsOutcomeTrend([
      run({ id: '1', status: 'succeeded' }),
      run({ id: '2', status: 'succeeded' }),
      run({ id: '3', status: 'failed' }),
      run({ id: '4', status: 'partial' }),
      run({ id: '5', status: 'running', finishedAt: null })
    ]);
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ succeeded: 2, failed: 1, partial: 1, running: 1 });
  });

  test('averages duration over finished runs only — an in-flight run contributes nothing', () => {
    const trend = shapeRunsOutcomeTrend([
      run({
        id: '1',
        startedAt: '2026-08-17T10:00:00.000Z',
        finishedAt: '2026-08-17T10:00:10.000Z'
      }),
      run({
        id: '2',
        startedAt: '2026-08-17T11:00:00.000Z',
        finishedAt: '2026-08-17T11:00:30.000Z'
      }),
      run({ id: '3', startedAt: '2026-08-17T12:00:00.000Z', finishedAt: null, status: 'running' })
    ]);
    expect(trend[0]?.avgDurationSeconds).toBe(20);
  });

  test('a day with no finished run has a null average, not a fabricated zero', () => {
    const trend = shapeRunsOutcomeTrend([run({ id: '1', status: 'running', finishedAt: null })]);
    expect(trend[0]?.avgDurationSeconds).toBeNull();
  });

  test('an unrecognized future status is counted into no series, and does not throw', () => {
    const trend = shapeRunsOutcomeTrend([run({ id: '1', status: 'cancelled' })]);
    expect(trend[0]).toMatchObject({ succeeded: 0, failed: 0, partial: 0, running: 0 });
  });
});
