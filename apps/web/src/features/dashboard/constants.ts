/**
 * Client-safe tone/label maps for the dashboard bands (loxep-jwm).
 *
 * Per Frontend Standards ("Status and health tone"), each feature keeps ONE
 * state→tone map and no duplicates. Everything the market and settings
 * features already own — market event tones, opportunity score tones,
 * consecutive-error tones, connection status labels, provider display names —
 * is imported from there rather than restated; only the tones this surface
 * introduces live here.
 *
 * Every tone below is paired with an icon at the call site, so meaning never
 * depends on hue alone.
 */
import { Icons } from '@/components/icons';
import type { BadgeVariant } from '@/features/market/constants';

/**
 * Order-sync freshness. A stale target is an operator-visible degradation
 * (`--warning`), not a failure: the sync may simply be disabled, or the
 * provider may have been unreachable for a cycle. A genuine failure shows up
 * as a consecutive-error streak, which uses the market feature's existing
 * `consecutiveErrorsTone`.
 */
export function syncFreshnessTone(input: { enabled: boolean; stale: boolean }): BadgeVariant {
  if (!input.enabled) return 'outline';
  return input.stale ? 'warning' : 'success';
}

export function syncFreshnessIcon(input: { enabled: boolean; stale: boolean }) {
  if (!input.enabled) return Icons.circle;
  return input.stale ? Icons.alertCircle : Icons.circleCheck;
}

export function syncFreshnessLabel(input: { enabled: boolean; stale: boolean }): string {
  if (!input.enabled) return 'Off';
  return input.stale ? 'Stale' : 'Fresh';
}

/**
 * Notification delivery success rate over the window. Anything below 90% of
 * settled attempts is a genuine failure to surface; 90–99% is degraded.
 * `null` (nothing settled) has no tone — the tile renders an icon instead of
 * a fabricated 100%.
 */
export function deliveryRateTone(rate: number | null): BadgeVariant {
  if (rate === null) return 'outline';
  if (rate >= 99) return 'success';
  if (rate >= 90) return 'warning';
  return 'destructive';
}

export function deliveryRateIcon(rate: number | null) {
  if (rate === null) return Icons.circle;
  if (rate >= 99) return Icons.circleCheck;
  if (rate >= 90) return Icons.alertCircle;
  return Icons.xCircle;
}

/**
 * Price-move direction is CATEGORICAL, not good/bad: a price rising is not a
 * success and a price falling is not a failure — which side is welcome
 * depends entirely on whether the watcher is buying or selling. So the tone
 * comes from the chart ramp (`bg-chart-N/15 text-chart-N`) rather than from
 * `--success`/`--destructive`, and the direction is carried by the arrow icon
 * and the explicit sign `formatPercent` already prints.
 */
export function priceMoveClassName(pct: number): string {
  return pct >= 0 ? 'bg-chart-2/15 text-chart-2' : 'bg-chart-5/15 text-chart-5';
}

export function priceMoveIcon(pct: number) {
  return pct >= 0 ? Icons.trendingUp : Icons.trendingDown;
}

/**
 * Monitor-fleet health rolled to one chip: any consecutive-error streak is
 * degraded, nothing enabled at all is neutral, everything polling cleanly is
 * healthy.
 */
export function fleetTone(input: { enabled: number; erroring: number }): BadgeVariant {
  if (input.enabled === 0) return 'outline';
  if (input.erroring > 0) return 'warning';
  return 'success';
}

export function fleetIcon(input: { enabled: number; erroring: number }) {
  if (input.enabled === 0) return Icons.circle;
  return input.erroring > 0 ? Icons.alertCircle : Icons.circleCheck;
}

/** Connection health chip: an error with no later success is a real failure. */
export function connectionHealthTone(input: { errored: number; active: number }): BadgeVariant {
  if (input.errored > 0) return 'destructive';
  return input.active > 0 ? 'success' : 'outline';
}

export function connectionHealthIcon(input: { errored: number; active: number }) {
  if (input.errored > 0) return Icons.xCircle;
  return input.active > 0 ? Icons.circleCheck : Icons.circle;
}
