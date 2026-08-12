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
import { Icons } from '@/components/icons';
import type { badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';

/** No dedicated `BadgeVariant` export exists yet; derived from the cva config. */
export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

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

/**
 * `market_events.event_type` → tone + icon (loxep-foi.5). `@loxep/market`'s
 * `MARKET_EVENT_TYPES` (`events.ts`) has exactly these seven members; the
 * `satisfies Record<...>` below fails typecheck the day an eighth is added,
 * same convention as `MONITOR_TARGET_TYPE_LABELS` above. Price drops and
 * restocks are good news for a watcher (`success`); a sold-out item is
 * at-risk, not a failure (`warning`); a plain quantity/price change is
 * informational (`secondary`); a listing ending is a closed/neutral state
 * (`outline`, matching `MARKET_ITEM_STATE_TONE.ended` below); a brand-new
 * discovered listing is the one primary-emphasis moment on the discovery
 * surfaces (`default` — `bg-primary`).
 */
export const MARKET_EVENT_TYPE_TONE = {
  price_changed: 'secondary',
  price_dropped: 'success',
  restocked: 'success',
  sold_out: 'warning',
  quantity_changed: 'secondary',
  listing_ended: 'outline',
  new_listing: 'default'
} satisfies Record<
  | 'price_changed'
  | 'price_dropped'
  | 'restocked'
  | 'sold_out'
  | 'quantity_changed'
  | 'listing_ended'
  | 'new_listing',
  BadgeVariant
>;

export const MARKET_EVENT_TYPE_ICON = {
  price_changed: Icons.adjustments,
  price_dropped: Icons.trendingDown,
  restocked: Icons.circleCheck,
  sold_out: Icons.alertCircle,
  quantity_changed: Icons.adjustments,
  listing_ended: Icons.xCircle,
  new_listing: Icons.sparkles
} satisfies Record<keyof typeof MARKET_EVENT_TYPE_TONE, React.FC<React.SVGProps<SVGSVGElement>>>;

export function marketEventTypeTone(eventType: string): BadgeVariant {
  return MARKET_EVENT_TYPE_TONE[eventType as keyof typeof MARKET_EVENT_TYPE_TONE] ?? 'outline';
}

export function marketEventTypeIcon(eventType: string): React.FC<React.SVGProps<SVGSVGElement>> {
  return MARKET_EVENT_TYPE_ICON[eventType as keyof typeof MARKET_EVENT_TYPE_ICON] ?? Icons.circle;
}

/**
 * `marketplace_items.current_state` is free-form `text` (default `"active"`,
 * see `packages/market/src/observations.ts`), not a PG enum or a closed TS
 * union — `LISTING_STATE_ENDED = "ended"` (`@loxep/market/events.ts`) is the
 * only other value the codebase currently writes. Both fall back to the raw
 * stored value/`outline`/neutral icon for any other state, same convention
 * as `monitorTargetTypeLabel`, so an unrecognized future state displays
 * instead of erroring.
 */
const MARKET_ITEM_STATE_LABELS: Record<string, string> = {
  active: 'Active',
  ended: 'Ended'
};

const MARKET_ITEM_STATE_TONE: Record<string, BadgeVariant> = {
  active: 'success',
  ended: 'outline'
};

const MARKET_ITEM_STATE_ICON: Record<string, React.FC<React.SVGProps<SVGSVGElement>>> = {
  active: Icons.circleCheck,
  ended: Icons.xCircle
};

export function marketItemStateLabel(state: string): string {
  return MARKET_ITEM_STATE_LABELS[state] ?? state;
}

export function marketItemStateTone(state: string): BadgeVariant {
  return MARKET_ITEM_STATE_TONE[state] ?? 'secondary';
}

export function marketItemStateIcon(state: string): React.FC<React.SVGProps<SVGSVGElement>> {
  return MARKET_ITEM_STATE_ICON[state] ?? Icons.circle;
}

/**
 * Opportunity/rule score tone bands (loxep-foi.5/loxep-foi.6): `formatScore`
 * (`@/lib/format`) owns the two-decimal display precision everywhere; this
 * only maps the already-formatted magnitude to a tone + icon so a strong
 * match reads differently from a marginal one at a glance.
 */
export function scoreTone(score: number): BadgeVariant {
  if (score >= 0.75) return 'success';
  if (score >= 0.4) return 'warning';
  return 'outline';
}

export function scoreIcon(score: number): React.FC<React.SVGProps<SVGSVGElement>> {
  if (score >= 0.75) return Icons.trendingUp;
  if (score >= 0.4) return Icons.minus;
  return Icons.trendingDown;
}

/**
 * `monitor_targets.consecutive_errors` tone bands (loxep-foi.3): 0 is
 * healthy (`success`), 1-4 is at-risk but not yet a failure (`warning`), 5+
 * consecutive failures is a genuine failure worth flagging in
 * `--destructive`.
 */
export function consecutiveErrorsTone(count: number): BadgeVariant {
  if (count === 0) return 'success';
  if (count < 5) return 'warning';
  return 'destructive';
}

export function consecutiveErrorsIcon(count: number): React.FC<React.SVGProps<SVGSVGElement>> {
  if (count === 0) return Icons.circleCheck;
  if (count < 5) return Icons.alertCircle;
  return Icons.xCircle;
}
