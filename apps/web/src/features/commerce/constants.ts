/**
 * Client-safe constants for the /commerce workspace (loxep-dgf.6, Flipping
 * M6).
 *
 * Every closed set here is duplicated as a local literal union rather than
 * imported from `@loxep/db/schema` — mirrors `@/features/inventory/constants.ts`'s
 * reasoning: a future addition to the schema's set fails typechecking HERE
 * instead of silently drifting, and it keeps `@loxep/db` out of the client
 * bundle. Values are copied verbatim from `packages/db/src/schema/commerce.ts`
 * (`CHANNEL_LISTING_STATUSES`, `MANUAL_LISTING_CHANNELS`) as of loxep-dgf.6.
 */
import type { VariantProps } from 'class-variance-authority';
import type { badgeVariants } from '@/components/ui/badge';

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

/** `channel_listings.status`. Provider-extensible; no `CHECK`. */
export type ChannelListingStatus = 'draft' | 'active' | 'ended' | 'sold_out' | 'unknown';

export const CHANNEL_LISTING_STATUS_VALUES: readonly ChannelListingStatus[] = [
  'draft',
  'active',
  'ended',
  'sold_out',
  'unknown'
];

const CHANNEL_LISTING_STATUS_LABELS = {
  draft: 'Draft',
  active: 'Active',
  ended: 'Ended',
  sold_out: 'Sold out',
  unknown: 'Unknown'
} satisfies Record<ChannelListingStatus, string>;

export function channelListingStatusLabel(status: string): string {
  return CHANNEL_LISTING_STATUS_LABELS[status as ChannelListingStatus] ?? status;
}

const CHANNEL_LISTING_STATUS_TONES = {
  draft: 'outline',
  active: 'success',
  ended: 'secondary',
  sold_out: 'default',
  unknown: 'outline'
} satisfies Record<ChannelListingStatus, BadgeVariant>;

export function channelListingStatusTone(status: string): BadgeVariant {
  return CHANNEL_LISTING_STATUS_TONES[status as ChannelListingStatus] ?? 'outline';
}

export const channelListingStatusOptions = CHANNEL_LISTING_STATUS_VALUES.map((value) => ({
  value,
  label: channelListingStatusLabel(value)
}));

/**
 * `channel_listings.channel` for `provider = 'manual'` (design 4a). `channel`
 * itself stays free text — this union is the UI's channel picker only, and
 * "other" is always a valid escape hatch.
 */
export type ManualListingChannel =
  | 'facebook_marketplace'
  | 'craigslist'
  | 'offerup'
  | 'in_person'
  | 'local_pickup'
  | 'consignment_shop'
  | 'other';

export const MANUAL_LISTING_CHANNEL_VALUES: readonly ManualListingChannel[] = [
  'facebook_marketplace',
  'craigslist',
  'offerup',
  'in_person',
  'local_pickup',
  'consignment_shop',
  'other'
];

const MANUAL_LISTING_CHANNEL_LABELS = {
  facebook_marketplace: 'Facebook Marketplace',
  craigslist: 'Craigslist',
  offerup: 'OfferUp',
  in_person: 'In person',
  local_pickup: 'Local pickup',
  consignment_shop: 'Consignment shop',
  other: 'Other'
} satisfies Record<ManualListingChannel, string>;

export function manualListingChannelLabel(channel: string): string {
  return MANUAL_LISTING_CHANNEL_LABELS[channel as ManualListingChannel] ?? channel;
}

export const manualListingChannelOptions = MANUAL_LISTING_CHANNEL_VALUES.map((value) => ({
  value,
  label: manualListingChannelLabel(value)
}));

/** `channel_listings.provider` value for a manual/offline listing (design 4a). */
export const MANUAL_PROVIDER = 'manual';

/** Adapter families with a real display name, rather than a capitalized guess. */
const KNOWN_PROVIDER_LABELS: Record<string, string> = {
  ebay: 'eBay',
  woocommerce: 'WooCommerce',
  medusa: 'Medusa'
};

export function providerLabel(provider: string): string {
  if (provider === MANUAL_PROVIDER) return 'Manual / offline';
  const known = KNOWN_PROVIDER_LABELS[provider];
  if (known !== undefined) return known;
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// ---------------------------------------------------------------------------
// Orders (loxep-i51) — `orders`, `order_fees`, `order_refunds`,
// `order_fulfillments`. Values copied verbatim from
// `packages/db/src/schema/commerce.ts` (`ORDER_STATUSES`,
// `ORDER_PAYMENT_STATUSES`, `ORDER_FULFILLMENT_STATUSES`, `FEE_SCOPES`,
// `FEE_DIRECTIONS`, `REFUND_KINDS`, `REFUND_STATUSES`,
// `FULFILLMENT_RECORD_STATUSES`), duplicated rather than imported for the
// same client-bundle/drift-visibility reason as the sets above.
// ---------------------------------------------------------------------------

/** Every provider Phase 3 ingestion knows about today, `manual` included — the orders filter's option list. */
export const ORDER_PROVIDER_VALUES: readonly string[] = ['ebay', 'woocommerce', 'medusa', 'manual'];

export const orderProviderOptions = ORDER_PROVIDER_VALUES.map((value) => ({
  value,
  label: providerLabel(value)
}));

/** `orders.status`. Provider-extensible; no `CHECK`. */
export type OrderStatus = 'pending' | 'open' | 'completed' | 'cancelled';

export const ORDER_STATUS_VALUES: readonly OrderStatus[] = [
  'pending',
  'open',
  'completed',
  'cancelled'
];

const ORDER_STATUS_LABELS = {
  pending: 'Pending',
  open: 'Open',
  completed: 'Completed',
  cancelled: 'Cancelled'
} satisfies Record<OrderStatus, string>;

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status as OrderStatus] ?? status;
}

const ORDER_STATUS_TONES = {
  pending: 'outline',
  open: 'default',
  completed: 'success',
  cancelled: 'destructive'
} satisfies Record<OrderStatus, BadgeVariant>;

export function orderStatusTone(status: string): BadgeVariant {
  return ORDER_STATUS_TONES[status as OrderStatus] ?? 'outline';
}

export const orderStatusOptions = ORDER_STATUS_VALUES.map((value) => ({
  value,
  label: orderStatusLabel(value)
}));

/** `orders.payment_status`. Provider-extensible; no `CHECK`. */
export type OrderPaymentStatus =
  | 'unpaid'
  | 'partially_paid'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'failed';

const ORDER_PAYMENT_STATUS_LABELS = {
  unpaid: 'Unpaid',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
  failed: 'Failed'
} satisfies Record<OrderPaymentStatus, string>;

export function orderPaymentStatusLabel(status: string): string {
  return ORDER_PAYMENT_STATUS_LABELS[status as OrderPaymentStatus] ?? status;
}

const ORDER_PAYMENT_STATUS_TONES = {
  unpaid: 'outline',
  partially_paid: 'warning',
  paid: 'success',
  partially_refunded: 'warning',
  refunded: 'secondary',
  failed: 'destructive'
} satisfies Record<OrderPaymentStatus, BadgeVariant>;

export function orderPaymentStatusTone(status: string): BadgeVariant {
  return ORDER_PAYMENT_STATUS_TONES[status as OrderPaymentStatus] ?? 'outline';
}

/**
 * `orders.fulfillment_status` and `order_fulfillments.status` share this
 * vocabulary (the design's `FULFILLMENT_RECORD_STATUSES` is the per-shipment
 * echo of the order-level union, both gaining `unknown` for a provider that
 * stopped telling us — see the schema design's provisional decision 3).
 */
export type OrderFulfillmentStatus =
  | 'unfulfilled'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'cancelled'
  | 'unknown';

const ORDER_FULFILLMENT_STATUS_LABELS = {
  unfulfilled: 'Unfulfilled',
  partially_fulfilled: 'Partially fulfilled',
  fulfilled: 'Fulfilled',
  cancelled: 'Cancelled',
  unknown: 'Unknown'
} satisfies Record<OrderFulfillmentStatus, string>;

export function orderFulfillmentStatusLabel(status: string): string {
  return ORDER_FULFILLMENT_STATUS_LABELS[status as OrderFulfillmentStatus] ?? status;
}

const ORDER_FULFILLMENT_STATUS_TONES = {
  unfulfilled: 'outline',
  partially_fulfilled: 'warning',
  fulfilled: 'success',
  cancelled: 'destructive',
  unknown: 'outline'
} satisfies Record<OrderFulfillmentStatus, BadgeVariant>;

export function orderFulfillmentStatusTone(status: string): BadgeVariant {
  return ORDER_FULFILLMENT_STATUS_TONES[status as OrderFulfillmentStatus] ?? 'outline';
}

/** `order_fulfillments.status` reuses the same label/tone maps as the order-level union above. */
export const fulfillmentRecordStatusLabel = orderFulfillmentStatusLabel;
export const fulfillmentRecordStatusTone = orderFulfillmentStatusTone;

/** `order_refunds.kind`. Provider-extensible; no `CHECK`. */
export type RefundKind = 'refund' | 'partial_refund' | 'cancellation' | 'adjustment';

const REFUND_KIND_LABELS = {
  refund: 'Refund',
  partial_refund: 'Partial refund',
  cancellation: 'Cancellation',
  adjustment: 'Adjustment'
} satisfies Record<RefundKind, string>;

export function refundKindLabel(kind: string): string {
  return REFUND_KIND_LABELS[kind as RefundKind] ?? kind;
}

/** `order_refunds.status`. Provider-extensible; no `CHECK`. */
export type RefundStatus = 'pending' | 'completed' | 'failed';

const REFUND_STATUS_LABELS = {
  pending: 'Pending',
  completed: 'Completed',
  failed: 'Failed'
} satisfies Record<RefundStatus, string>;

export function refundStatusLabel(status: string): string {
  return REFUND_STATUS_LABELS[status as RefundStatus] ?? status;
}

const REFUND_STATUS_TONES = {
  pending: 'outline',
  completed: 'success',
  failed: 'destructive'
} satisfies Record<RefundStatus, BadgeVariant>;

export function refundStatusTone(status: string): BadgeVariant {
  return REFUND_STATUS_TONES[status as RefundStatus] ?? 'outline';
}

/**
 * `order_fees.fee_direction` (PROVISIONAL, ratified by owner review — see
 * the schema design doc). `seller_charge` is a deduction from proceeds;
 * `buyer_surcharge` is already inside `orders.total` and must never be
 * subtracted.
 */
export type FeeDirection = 'seller_charge' | 'buyer_surcharge';

const FEE_DIRECTION_LABELS = {
  seller_charge: 'Charged to seller',
  buyer_surcharge: 'Charged to buyer'
} satisfies Record<FeeDirection, string>;

export function feeDirectionLabel(direction: string): string {
  return FEE_DIRECTION_LABELS[direction as FeeDirection] ?? direction;
}

/** Turns a `snake_case` fact (a fee type, a provider fee code, a carrier code) into a readable label, without a per-value map. */
export function humanizeSnakeCase(value: string): string {
  if (value.length === 0) return value;
  const spaced = value.replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * ADR-0021 retention state on a `provider_objects` snapshot linked to an
 * order. Never derived from the payload — only from whether `redacted_at`
 * is set.
 */
export type ProvenanceRetention = 'retained' | 'redacted';

const PROVENANCE_RETENTION_LABELS = {
  retained: 'Retained',
  redacted: 'Redacted'
} satisfies Record<ProvenanceRetention, string>;

export function provenanceRetentionLabel(retention: string): string {
  return PROVENANCE_RETENTION_LABELS[retention as ProvenanceRetention] ?? retention;
}

const PROVENANCE_RETENTION_TONES = {
  retained: 'secondary',
  redacted: 'outline'
} satisfies Record<ProvenanceRetention, BadgeVariant>;

export function provenanceRetentionTone(retention: string): BadgeVariant {
  return PROVENANCE_RETENTION_TONES[retention as ProvenanceRetention] ?? 'outline';
}
