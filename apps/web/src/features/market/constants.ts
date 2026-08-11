/**
 * Client-safe constants for the market workspace. Nothing server-side (and
 * nothing that would drag in `@loxep/jobs`/`graphile-worker`, see
 * `@/server/admin`'s `getMarketModule` doc) reaches the client bundle.
 *
 * `SupportedMonitorTargetType` is deliberately a local literal union, not an
 * import of `@loxep/market`'s `MonitorTargetType` — so a future addition to
 * that package's type fails typechecking HERE (the `satisfies` below) rather
 * than silently drifting. As of loxep-7dp.6, `@loxep/market`'s
 * `MONITOR_TARGET_TYPES` already carries all four members
 * (`ebay_item`/`ebay_watchlist`/`ebay_search`/`ebay_seller` — the Phase 2
 * discovery types poll through the same claim/backoff/adaptive machinery,
 * `monitors.ts`'s doc), and this union and the create/edit UI below cover all
 * four. `monitorTargetTypeLabel` still falls back to the raw stored value for
 * any other `monitor_targets.target_type` value, so a type this union hasn't
 * caught up to yet displays instead of erroring.
 */
export type SupportedMonitorTargetType =
  | 'ebay_item'
  | 'ebay_watchlist'
  | 'ebay_search'
  | 'ebay_seller';

const MONITOR_TARGET_TYPE_LABELS = {
  ebay_item: 'eBay item',
  ebay_watchlist: 'eBay watchlist',
  ebay_search: 'eBay search',
  ebay_seller: 'eBay seller'
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
