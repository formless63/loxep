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
import type { FleetProvider, FleetProviderSignalDto } from '@/server/infrastructure-functions';
import type { DashboardInfrastructureDto } from '@/server/dashboard-functions';

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

interface ConnectionHealthCounts {
  errored: number;
  degraded: number;
  unknown: number;
  active: number;
}

/**
 * Connection health chip (loxep-9m2 bug 2 fix): a genuine failure beats
 * degraded beats unknown beats healthy. `unknown` ("Loxep could not
 * determine") gets its own warning tone rather than folding into either
 * healthy or failing — previously it, and `degraded`, were discarded
 * entirely, so a degraded credential or an unreachable hub rendered as fine.
 */
export function connectionHealthTone(input: ConnectionHealthCounts): BadgeVariant {
  if (input.errored > 0) return 'destructive';
  if (input.degraded > 0 || input.unknown > 0) return 'warning';
  return input.active > 0 ? 'success' : 'outline';
}

export function connectionHealthIcon(input: ConnectionHealthCounts) {
  if (input.errored > 0) return Icons.xCircle;
  if (input.degraded > 0) return Icons.alertCircle;
  if (input.unknown > 0) return Icons.help;
  return input.active > 0 ? Icons.circleCheck : Icons.circle;
}

/** A counts-only label, never a verdict — "2 erroring, 1 unknown" rather than "unhealthy". */
export function connectionHealthLabel(input: ConnectionHealthCounts): string {
  const parts: string[] = [];
  if (input.errored > 0) parts.push(`${input.errored} erroring`);
  if (input.degraded > 0) parts.push(`${input.degraded} degraded`);
  if (input.unknown > 0) parts.push(`${input.unknown} unknown`);
  if (parts.length === 0) return `${input.active} active`;
  return parts.join(', ');
}

/** Labels for the two `otherSync` target types — see `DashboardOtherSyncTargetDto`. */
const OTHER_SYNC_TARGET_TYPE_LABELS = {
  ebay_purchases: 'eBay purchases',
  infrastructure_domain_reconcile: 'DNS reconcile'
} as const;

export function otherSyncTargetTypeLabel(targetType: string): string {
  return (
    OTHER_SYNC_TARGET_TYPE_LABELS[targetType as keyof typeof OTHER_SYNC_TARGET_TYPE_LABELS] ??
    targetType
  );
}

/**
 * Fleet-signals tone/label (loxep-cum's `computeFleetSignals`, folded into
 * the Operations band). Witness-not-verdict, same as `/infrastructure`'s own
 * `fleet-signals-band.tsx`: this NEVER blends providers into one page-level
 * verdict — each provider's own counts stand alone, so this module
 * deliberately does not import that component and instead restates the same
 * small, pure logic for the dashboard's more compact tile.
 */
export const FLEET_PROVIDER_LABELS: Record<FleetProvider, string> = {
  tailscale: 'Tailscale',
  beszel: 'Beszel',
  dockhand: 'Dockhand',
  gatus: 'Gatus',
  termix: 'Termix'
};

export function fleetProviderTone(provider: FleetProviderSignalDto): BadgeVariant {
  if (provider.failingCount > 0) return 'destructive';
  if (provider.degradedCount > 0 || provider.unknownCount > 0) return 'warning';
  return provider.okCount > 0 ? 'success' : 'outline';
}

export function fleetProviderCountLabel(provider: FleetProviderSignalDto): string {
  const parts: string[] = [];
  if (provider.failingCount > 0) parts.push(`${provider.failingCount} failing`);
  if (provider.degradedCount > 0) parts.push(`${provider.degradedCount} degraded`);
  if (provider.unknownCount > 0) parts.push(`${provider.unknownCount} unknown`);
  if (provider.uncheckedCount > 0) parts.push(`${provider.uncheckedCount} unchecked`);
  if (parts.length === 0) return `${provider.okCount} ok`;
  return parts.join(', ');
}

/**
 * This installation's own infrastructure tile: any recent reconcile failure
 * is a genuine problem; unresolved DNS drift alone is degraded, not failing
 * (a drift finding is evidence to review, not necessarily broken).
 */
export function infrastructureTone(
  data: Pick<DashboardInfrastructureDto, 'unresolvedDriftCount' | 'recentFailedReconcileRunCount'>
): BadgeVariant {
  if (data.recentFailedReconcileRunCount > 0) return 'destructive';
  if (data.unresolvedDriftCount > 0) return 'warning';
  return 'success';
}

export function infrastructureIcon(
  data: Pick<DashboardInfrastructureDto, 'unresolvedDriftCount' | 'recentFailedReconcileRunCount'>
) {
  if (data.recentFailedReconcileRunCount > 0) return Icons.xCircle;
  if (data.unresolvedDriftCount > 0) return Icons.alertCircle;
  return Icons.circleCheck;
}
