/**
 * Client-safe constants for the settings workspace. Server-package imports
 * here are type-only so nothing heavy reaches the client bundle; the
 * `satisfies Record<...>` maps keep every union member covered — adding a
 * kind/status upstream fails typechecking here instead of silently drifting.
 */
import type { EconomicEntityKind } from '@loxep/db/schema';
import type { ConnectionStatus, ProviderWritePolicyTier } from '@loxep/domain';
import type { StorageDriverFamily } from '@loxep/storage';
import type { MarketEventType } from '@loxep/market';
import type { NotificationEventClass } from '@loxep/db/schema';
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
  error: 'Error',
  archived: 'Archived'
} satisfies Record<ConnectionStatus, string>;

/**
 * The write-authorization tier vocabulary (Pangolin chain design M3,
 * loxep-acj.3), re-declared client-safe — the same convention
 * `CONNECTION_STATUS_LABELS` above uses: `ProviderWritePolicyTier` is a
 * type-only import, and the label/description TEXT is the single source of
 * truth in `@loxep/domain`'s `provider-write-policy.ts`, kept in step by
 * hand rather than imported at runtime, because `@loxep/domain` pulls in
 * `@loxep/db` (Node-only) and this file ships in the client bundle.
 */
export const PROVIDER_WRITE_POLICY_TIER_LABELS = {
  read_only: 'Read-only',
  additive: 'Additive writes',
  access_affecting: 'Access-affecting writes',
  lockout_class: 'Lockout-class writes'
} satisfies Record<ProviderWritePolicyTier, string>;

export const PROVIDER_WRITE_POLICY_TIER_DESCRIPTIONS = {
  read_only:
    'Loxep may only read from this connection. No create, update, or disable call is ever made — the default for every connection.',
  additive:
    'Loxep may create new objects at this provider (a resource, a target, a rule) but may never change or disable an existing one.',
  access_affecting:
    'Loxep may also change existing objects at this provider — including updates that affect who or what can reach them. Every access-affecting apply is from a shown plan, never a background sweep.',
  lockout_class:
    "Loxep may also apply changes that could remove the operator's own way in — always behind a typed confirmation naming the object, and the self-lockout preflight can still refuse regardless of this setting."
} satisfies Record<ProviderWritePolicyTier, string>;

export const PROVIDER_WRITE_POLICY_TIER_VALUES = Object.keys(
  PROVIDER_WRITE_POLICY_TIER_LABELS
) as readonly ProviderWritePolicyTier[];

/** Providers this policy is wired to actually check (Pangolin chain design M3's cross-provider rule). Every other row shows "not applicable". */
export const WRITE_POLICY_ENFORCED_PROVIDERS = new Set(['cloudflare', 'purelymail', 'pangolin']);

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
  listing_ended: 'Listing ended',
  new_listing: 'New listing'
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

/**
 * Notification event classes (ADR-0023).
 *
 * Mirrored locally, exactly like `MARKET_EVENT_TYPE_LABELS` above and for the
 * same reason: this module's imports from server packages are type-only so
 * nothing heavy reaches the client bundle. `satisfies Record<...>` keeps the
 * union covered, so a class added to `@loxep/domain`'s registry fails
 * typechecking here instead of silently drifting. The registry — not this
 * map — remains authoritative: the server revalidates every (class, type)
 * pair on write.
 */
const NOTIFICATION_EVENT_CLASS_LABELS = {
  market: 'Market',
  purchase: 'Purchases',
  document: 'Documents',
  sale: 'Sales',
  health: 'Integration health',
  infrastructure: 'Infrastructure'
} satisfies Record<NotificationEventClass, string>;

const NON_MARKET_EVENT_TYPE_LABELS: Record<string, string> = {
  purchase_ingested: 'Purchase ingested',
  document_confirmed: 'Document confirmed',
  manual_sale_recorded: 'Sale recorded',
  health_degraded: 'Degraded',
  health_recovered: 'Recovered'
};

/**
 * Event types each class permits. `infrastructure` is seeded in the schema
 * CHECK but emits nothing yet, so it has no types and is not offered as a
 * rule class — a rule for it could never match.
 */
const NOTIFICATION_EVENT_TYPES_BY_CLASS = {
  market: MARKET_EVENT_TYPE_VALUES as readonly string[],
  purchase: ['purchase_ingested'],
  document: ['document_confirmed'],
  sale: ['manual_sale_recorded'],
  health: ['health_degraded', 'health_recovered'],
  infrastructure: []
} satisfies Record<NotificationEventClass, readonly string[]>;

export const NOTIFICATION_EVENT_CLASS_VALUES = (
  Object.keys(NOTIFICATION_EVENT_CLASS_LABELS) as NotificationEventClass[]
).filter((value) => NOTIFICATION_EVENT_TYPES_BY_CLASS[value].length > 0);

export const notificationEventClassOptions = NOTIFICATION_EVENT_CLASS_VALUES.map((value) => ({
  value,
  label: NOTIFICATION_EVENT_CLASS_LABELS[value]
}));

export function notificationEventClassLabel(eventClass: string): string {
  return NOTIFICATION_EVENT_CLASS_LABELS[eventClass as NotificationEventClass] ?? eventClass;
}

export function notificationEventTypeLabel(eventType: string): string {
  return (
    NON_MARKET_EVENT_TYPE_LABELS[eventType] ??
    MARKET_EVENT_TYPE_LABELS[eventType as MarketEventType] ??
    eventType
  );
}

/** Event types a rule of this class may filter on, labelled for the picker. */
export function notificationEventTypeOptionsFor(
  eventClass: string
): { value: string; label: string }[] {
  const types = NOTIFICATION_EVENT_TYPES_BY_CLASS[eventClass as NotificationEventClass];
  if (types === undefined) return [];
  return types.map((value) => ({
    value,
    label: notificationEventTypeLabel(value)
  }));
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
