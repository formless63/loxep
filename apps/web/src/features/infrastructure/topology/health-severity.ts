/**
 * Health severity ordering shared by the graph lens (node status dots) and
 * the map lens (marker tinting, rule MAP2's "worst linked health"). One
 * ranking, defined once, so "worst" always means the same thing everywhere
 * on this page.
 */
import type { TopologyHealthStatus } from '@/server/infrastructure-topology-functions';

/** Higher is worse. `unknown` ranks above `ok` (a probe that could not determine a status is not the same as a clean bill of health) and below `degraded`/`failing` (an actual observed problem is worse than "we don't know yet"). */
export const HEALTH_SEVERITY: Record<TopologyHealthStatus, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  failing: 3
};

/** `null` (no health data at all) is the least severe of all — "never checked" renders neutrally, never as a problem. */
export function worseStatus(
  a: TopologyHealthStatus | null,
  b: TopologyHealthStatus | null
): TopologyHealthStatus | null {
  if (a === null) return b;
  if (b === null) return a;
  return HEALTH_SEVERITY[a] >= HEALTH_SEVERITY[b] ? a : b;
}

/** Folds a list of statuses (nulls skipped) down to the single worst one, or `null` if every entry was `null`/the list was empty. */
export function worstOfStatuses(
  statuses: (TopologyHealthStatus | null)[]
): TopologyHealthStatus | null {
  let worst: TopologyHealthStatus | null = null;
  for (const status of statuses) worst = worseStatus(worst, status);
  return worst;
}
