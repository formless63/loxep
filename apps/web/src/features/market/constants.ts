/**
 * Client-safe constants for the market workspace. Nothing server-side (and
 * nothing that would drag in `@loxep/jobs`/`graphile-worker`, see
 * `@/server/admin`'s `getMarketModule` doc) reaches the client bundle.
 *
 * `SupportedMonitorTargetType` is deliberately a local literal union, not an
 * import of `@loxep/market`'s `MonitorTargetType` — this workspace's Phase 1
 * scope (loxep-62y.4) is create/edit for `ebay_item`/`ebay_watchlist` only
 * (`monitors.ts`'s `MonitorTargetType` may grow further target types under
 * other beads; the market-functions.ts server input validator is similarly
 * scoped to these two literals). `monitorTargetTypeLabel` still falls back to
 * the raw stored value for any other `monitor_targets.target_type` value, so
 * unsupported types display instead of erroring.
 */
export type SupportedMonitorTargetType = 'ebay_item' | 'ebay_watchlist';

const MONITOR_TARGET_TYPE_LABELS = {
  ebay_item: 'eBay item',
  ebay_watchlist: 'eBay watchlist'
} satisfies Record<SupportedMonitorTargetType, string>;

export const MONITOR_TARGET_TYPE_VALUES = Object.keys(
  MONITOR_TARGET_TYPE_LABELS
) as readonly SupportedMonitorTargetType[];

export const monitorTargetTypeOptions = MONITOR_TARGET_TYPE_VALUES.map((value) => ({
  value,
  label: MONITOR_TARGET_TYPE_LABELS[value]
}));

export function monitorTargetTypeLabel(targetType: string): string {
  return MONITOR_TARGET_TYPE_LABELS[targetType as SupportedMonitorTargetType] ?? targetType;
}

/** No-connection sentinel for connection selects (Radix Select rejects ''). */
export const NO_CONNECTION_VALUE = '__none__';

/** "Show items from every monitor" sentinel for the items table's filter. */
export const ANY_MONITOR_VALUE = '__any_monitor__';
