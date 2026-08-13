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

export function providerLabel(provider: string): string {
  if (provider === MANUAL_PROVIDER) return 'Manual / offline';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
