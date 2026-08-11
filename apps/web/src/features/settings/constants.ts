/**
 * Client-safe constants for the settings workspace. Server-package imports
 * here are type-only so nothing heavy reaches the client bundle; the
 * `satisfies Record<...>` maps keep every union member covered — adding a
 * kind/status upstream fails typechecking here instead of silently drifting.
 */
import type { EconomicEntityKind } from '@loxep/db/schema';
import type { ConnectionStatus } from '@loxep/domain';
import type { StorageDriverFamily } from '@loxep/storage';
import type { MarketEventType } from '@loxep/market';
import type { DeliveryStatus, NtfyPriority } from '@loxep/notifications';

const ENTITY_KIND_LABELS = {
  individual: 'Individual',
  sole_proprietorship: 'Sole proprietorship',
  llc: 'LLC',
  partnership: 'Partnership',
  corporation: 'Corporation',
  assumed_name: 'Assumed name',
  operating_unit: 'Operating unit',
  other: 'Other'
} satisfies Record<EconomicEntityKind, string>;

export const ECONOMIC_ENTITY_KIND_VALUES = Object.keys(
  ENTITY_KIND_LABELS
) as readonly EconomicEntityKind[];

export const entityKindOptions = ECONOMIC_ENTITY_KIND_VALUES.map((value) => ({
  value,
  label: ENTITY_KIND_LABELS[value]
}));

export function entityKindLabel(kind: EconomicEntityKind | string): string {
  return ENTITY_KIND_LABELS[kind as EconomicEntityKind] ?? kind;
}

export const CONNECTION_STATUS_LABELS = {
  active: 'Active',
  disabled: 'Disabled',
  error: 'Error'
} satisfies Record<ConnectionStatus, string>;

export const STORAGE_DRIVER_LABELS = {
  local: 'Local filesystem',
  s3: 'S3-compatible'
} satisfies Record<StorageDriverFamily, string>;

/** No-attribution sentinel for entity selects (Radix Select rejects ''). */
export const NO_ENTITY_VALUE = '__none__';

/** Rule-filter sentinel meaning "any event type" / "any monitor target". */
export const ANY_MARKET_EVENT_TYPE_VALUE = '__any_event_type__';
export const ANY_MONITOR_TARGET_VALUE = '__any_monitor_target__';

const MARKET_EVENT_TYPE_LABELS = {
  price_changed: 'Price changed',
  price_dropped: 'Price dropped',
  restocked: 'Restocked',
  sold_out: 'Sold out',
  quantity_changed: 'Quantity changed',
  listing_ended: 'Listing ended'
} satisfies Record<MarketEventType, string>;

export const MARKET_EVENT_TYPE_VALUES = Object.keys(
  MARKET_EVENT_TYPE_LABELS
) as readonly MarketEventType[];

export const marketEventTypeOptions = MARKET_EVENT_TYPE_VALUES.map((value) => ({
  value,
  label: MARKET_EVENT_TYPE_LABELS[value]
}));

export function marketEventTypeLabel(eventType: MarketEventType | string): string {
  return MARKET_EVENT_TYPE_LABELS[eventType as MarketEventType] ?? eventType;
}

/** Mirrors `@loxep/notifications`'s `NTFY_PRIORITIES` (https://docs.ntfy.sh). */
const NTFY_PRIORITY_LABELS = {
  min: 'Min',
  low: 'Low',
  default: 'Default',
  high: 'High',
  urgent: 'Urgent'
} satisfies Record<NtfyPriority, string>;

export const ntfyPriorityOptions = (Object.keys(NTFY_PRIORITY_LABELS) as NtfyPriority[]).map(
  (value) => ({ value, label: NTFY_PRIORITY_LABELS[value] })
);

export const DELIVERY_STATUS_LABELS = {
  pending: 'Pending',
  delivered: 'Delivered',
  failed: 'Failed'
} satisfies Record<DeliveryStatus, string>;

export function deliveryStatusLabel(status: DeliveryStatus | string): string {
  return DELIVERY_STATUS_LABELS[status as DeliveryStatus] ?? status;
}
