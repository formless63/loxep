/**
 * Client-safe constants for the /inventory workspace (loxep-dgf.2, M2).
 *
 * Every closed set here is duplicated as a local literal union rather than
 * imported from `@loxep/db/schema` — mirrors `@/features/finance/constants.ts`'s
 * reasoning: a future addition to the schema's `CHECK`ed sets fails
 * typechecking HERE instead of silently drifting, and it keeps `@loxep/db`
 * out of the client bundle. Values are copied verbatim from
 * `packages/db/src/schema/inventory.ts` (`ITEM_STATUSES`,
 * `ITEM_CONDITION_CODES`, `ACQUISITION_SOURCE_KINDS`, `ACQUISITION_STATUSES`,
 * `COST_ALLOCATION_BASES`, `COST_ALLOCATION_STATUSES`, `MOVEMENT_KINDS`) as
 * of loxep-dgf.2.
 */
import type { VariantProps } from 'class-variance-authority';
import type { badgeVariants } from '@/components/ui/badge';

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

/**
 * `inventory_items.status` — a workflow label, NOT an authority (quantities
 * and movements are); no database `CHECK`. `intake` is the create-time
 * default and the state the intake review screen filters on.
 */
export type ItemStatus =
  | 'intake'
  | 'available'
  | 'listed'
  | 'reserved'
  | 'partially_depleted'
  | 'depleted'
  | 'written_off'
  | 'archived';

export const ITEM_STATUS_VALUES: readonly ItemStatus[] = [
  'intake',
  'available',
  'listed',
  'reserved',
  'partially_depleted',
  'depleted',
  'written_off',
  'archived'
];

const ITEM_STATUS_LABELS = {
  intake: 'Intake',
  available: 'Available',
  listed: 'Listed',
  reserved: 'Reserved',
  partially_depleted: 'Partially depleted',
  depleted: 'Depleted',
  written_off: 'Written off',
  archived: 'Archived'
} satisfies Record<ItemStatus, string>;

export function itemStatusLabel(status: string): string {
  return ITEM_STATUS_LABELS[status as ItemStatus] ?? status;
}

const ITEM_STATUS_TONES = {
  intake: 'warning',
  available: 'success',
  listed: 'default',
  reserved: 'secondary',
  partially_depleted: 'outline',
  depleted: 'outline',
  written_off: 'destructive',
  archived: 'secondary'
} satisfies Record<ItemStatus, BadgeVariant>;

export function itemStatusTone(status: string): BadgeVariant {
  return ITEM_STATUS_TONES[status as ItemStatus] ?? 'outline';
}

export const itemStatusOptions = ITEM_STATUS_VALUES.map((value) => ({
  value,
  label: itemStatusLabel(value)
}));

/**
 * The "Stock by status" mini-bar's segment colors (loxep-0g4 D4) — the same
 * tone `ITEM_STATUS_TONES` already maps each status to, expressed as the CSS
 * var its `Badge` variant renders (`success`/`warning`/`destructive`/
 * `secondary`, or `primary` for `default`). `outline` has no fill of its own
 * (a bordered, transparent badge), so those two statuses fall back to a
 * `--chart-N` token instead of a fabricated fill.
 */
const ITEM_STATUS_BAR_COLORS = {
  intake: 'var(--warning)',
  available: 'var(--success)',
  listed: 'var(--primary)',
  reserved: 'var(--secondary)',
  partially_depleted: 'var(--chart-1)',
  depleted: 'var(--chart-2)',
  written_off: 'var(--destructive)',
  archived: 'var(--secondary)'
} satisfies Record<ItemStatus, string>;

export function itemStatusBarColor(status: string): string {
  return ITEM_STATUS_BAR_COLORS[status as ItemStatus] ?? 'var(--muted-foreground)';
}

/** `inventory_items.condition_code` — Loxep-owned closed set, `CHECK`ed. */
export type ItemConditionCode =
  | 'new_sealed'
  | 'new_open_box'
  | 'like_new'
  | 'very_good'
  | 'good'
  | 'acceptable'
  | 'for_parts'
  | 'damaged'
  | 'unknown';

export const ITEM_CONDITION_CODE_VALUES: readonly ItemConditionCode[] = [
  'new_sealed',
  'new_open_box',
  'like_new',
  'very_good',
  'good',
  'acceptable',
  'for_parts',
  'damaged',
  'unknown'
];

const ITEM_CONDITION_LABELS = {
  new_sealed: 'New, sealed',
  new_open_box: 'New, open box',
  like_new: 'Like new',
  very_good: 'Very good',
  good: 'Good',
  acceptable: 'Acceptable',
  for_parts: 'For parts',
  damaged: 'Damaged',
  unknown: 'Unknown'
} satisfies Record<ItemConditionCode, string>;

export function itemConditionLabel(code: string): string {
  return ITEM_CONDITION_LABELS[code as ItemConditionCode] ?? code;
}

export const itemConditionOptions = ITEM_CONDITION_CODE_VALUES.map((value) => ({
  value,
  label: itemConditionLabel(value)
}));

/** `acquisitions.source_kind` — Loxep-owned closed set, `CHECK`ed. */
export type AcquisitionSourceKind =
  | 'auction_lot'
  | 'estate_sale'
  | 'thrift_retail'
  | 'retail_arbitrage'
  | 'liquidation_pallet'
  | 'wholesale_purchase'
  | 'online_marketplace'
  | 'trade_in'
  | 'consignment_intake'
  | 'personal_conversion'
  | 'customer_return'
  | 'found_stock'
  | 'other';

export const ACQUISITION_SOURCE_KIND_VALUES: readonly AcquisitionSourceKind[] = [
  'auction_lot',
  'estate_sale',
  'thrift_retail',
  'retail_arbitrage',
  'liquidation_pallet',
  'wholesale_purchase',
  'online_marketplace',
  'trade_in',
  'consignment_intake',
  'personal_conversion',
  'customer_return',
  'found_stock',
  'other'
];

const ACQUISITION_SOURCE_KIND_LABELS = {
  auction_lot: 'Auction lot',
  estate_sale: 'Estate sale',
  thrift_retail: 'Thrift / retail',
  retail_arbitrage: 'Retail arbitrage',
  liquidation_pallet: 'Liquidation pallet',
  wholesale_purchase: 'Wholesale purchase',
  online_marketplace: 'Online marketplace',
  trade_in: 'Trade-in',
  consignment_intake: 'Consignment intake',
  personal_conversion: 'Personal conversion',
  customer_return: 'Customer return',
  found_stock: 'Found stock',
  other: 'Other'
} satisfies Record<AcquisitionSourceKind, string>;

export function acquisitionSourceKindLabel(kind: string): string {
  return ACQUISITION_SOURCE_KIND_LABELS[kind as AcquisitionSourceKind] ?? kind;
}

export const acquisitionSourceKindOptions = ACQUISITION_SOURCE_KIND_VALUES.map((value) => ({
  value,
  label: acquisitionSourceKindLabel(value)
}));

/** `acquisitions.status` — TypeScript union, no `CHECK` (a workflow label likely to grow). */
export type AcquisitionStatus = 'draft' | 'open' | 'receiving' | 'costed' | 'closed' | 'cancelled';

export const ACQUISITION_STATUS_VALUES: readonly AcquisitionStatus[] = [
  'draft',
  'open',
  'receiving',
  'costed',
  'closed',
  'cancelled'
];

const ACQUISITION_STATUS_LABELS = {
  draft: 'Draft',
  open: 'Open',
  receiving: 'Receiving',
  costed: 'Costed',
  closed: 'Closed',
  cancelled: 'Cancelled'
} satisfies Record<AcquisitionStatus, string>;

export function acquisitionStatusLabel(status: string): string {
  return ACQUISITION_STATUS_LABELS[status as AcquisitionStatus] ?? status;
}

export const acquisitionStatusOptions = ACQUISITION_STATUS_VALUES.map((value) => ({
  value,
  label: acquisitionStatusLabel(value)
}));

const ACQUISITION_STATUS_TONES = {
  draft: 'outline',
  open: 'default',
  receiving: 'secondary',
  costed: 'secondary',
  closed: 'success',
  cancelled: 'destructive'
} satisfies Record<AcquisitionStatus, BadgeVariant>;

export function acquisitionStatusTone(status: string): BadgeVariant {
  return ACQUISITION_STATUS_TONES[status as AcquisitionStatus] ?? 'outline';
}

/** `acquisitions.cost_allocation_status` — closed, `CHECK`ed; the cost engine branches on it. */
export type CostAllocationStatus = 'pending' | 'provisional' | 'final';

const COST_ALLOCATION_STATUS_LABELS = {
  pending: 'Pending',
  provisional: 'Provisional',
  final: 'Final'
} satisfies Record<CostAllocationStatus, string>;

export function costAllocationStatusLabel(status: string): string {
  return COST_ALLOCATION_STATUS_LABELS[status as CostAllocationStatus] ?? status;
}

const COST_ALLOCATION_STATUS_TONES = {
  pending: 'outline',
  provisional: 'warning',
  final: 'success'
} satisfies Record<CostAllocationStatus, BadgeVariant>;

export function costAllocationStatusTone(status: string): BadgeVariant {
  return COST_ALLOCATION_STATUS_TONES[status as CostAllocationStatus] ?? 'outline';
}

/** `acquisitions.cost_allocation_basis` / `inventory_items.cost_allocation_basis` — closed, `CHECK`ed. */
export type CostAllocationBasis = 'equal' | 'relative_value' | 'weight' | 'manual' | 'direct';

export const COST_ALLOCATION_BASIS_VALUES: readonly CostAllocationBasis[] = [
  'equal',
  'relative_value',
  'weight',
  'manual',
  'direct'
];

const COST_ALLOCATION_BASIS_LABELS = {
  equal: 'Equal (per unit)',
  relative_value: 'Relative value (recommended)',
  weight: 'Weight',
  manual: 'Manual',
  direct: 'Direct (item-scoped costs only)'
} satisfies Record<CostAllocationBasis, string>;

export function costAllocationBasisLabel(basis: string): string {
  return COST_ALLOCATION_BASIS_LABELS[basis as CostAllocationBasis] ?? basis;
}

export const costAllocationBasisOptions = COST_ALLOCATION_BASIS_VALUES.map((value) => ({
  value,
  label: costAllocationBasisLabel(value)
}));

/** `inventory_movements.movement_kind` — closed, `CHECK`ed. */
export type MovementKind =
  | 'receipt'
  | 'transfer_in'
  | 'return_in'
  | 'adjustment_in'
  | 'found'
  | 'transfer_out'
  | 'depletion_sale'
  | 'adjustment_out'
  | 'shrinkage'
  | 'disposal'
  | 'consumption'
  | 'reversal';

const MOVEMENT_KIND_LABELS = {
  receipt: 'Receipt',
  transfer_in: 'Transfer in',
  return_in: 'Return in',
  adjustment_in: 'Adjustment in',
  found: 'Found',
  transfer_out: 'Transfer out',
  depletion_sale: 'Depletion (sale)',
  adjustment_out: 'Adjustment out',
  shrinkage: 'Shrinkage',
  disposal: 'Disposal',
  consumption: 'Consumption',
  reversal: 'Reversal'
} satisfies Record<MovementKind, string>;

export function movementKindLabel(kind: string): string {
  return MOVEMENT_KIND_LABELS[kind as MovementKind] ?? kind;
}

const INBOUND_MOVEMENT_KINDS = new Set<MovementKind>([
  'receipt',
  'transfer_in',
  'return_in',
  'adjustment_in',
  'found'
]);

/** True for movements that increase on-hand — used to sign-color the movements timeline. */
export function movementIsInbound(kind: string): boolean {
  return INBOUND_MOVEMENT_KINDS.has(kind as MovementKind);
}

/**
 * PROVISIONAL (loxep-8e2, priority 1): collapses the twelve `MovementKind`
 * values into five chart series for `/inventory/movements`' stacked area.
 * Frontend Standards caps chart series colors at `--chart-1`..`--chart-5`
 * (only five tokens exist in the theme) — a literal one-series-per-kind
 * chart would need twelve, which is renderable only by inventing colors
 * (banned) or reusing tokens across series (banned: "never skipped
 * around"). This grouping is chosen to answer the two questions the bead
 * poses directly, not to minimize kinds for their own sake: `received` vs.
 * `sold` answers "receiving faster than selling?", and `shrinkage` is its
 * own isolated series (not folded into a generic "outbound" bucket)
 * because "is shrinkage trending up" is exactly the signal the schema
 * keeps `shrinkage`/`disposal` separate from other outbound kinds to
 * preserve.
 */
export type MovementTrendGroup = 'received' | 'sold' | 'shrinkage' | 'adjusted' | 'reversed';

export const MOVEMENT_TREND_GROUP_VALUES: readonly MovementTrendGroup[] = [
  'received',
  'sold',
  'shrinkage',
  'adjusted',
  'reversed'
];

const MOVEMENT_TREND_GROUPS = {
  receipt: 'received',
  transfer_in: 'received',
  return_in: 'received',
  adjustment_in: 'adjusted',
  found: 'adjusted',
  transfer_out: 'adjusted',
  depletion_sale: 'sold',
  adjustment_out: 'adjusted',
  shrinkage: 'shrinkage',
  disposal: 'shrinkage',
  consumption: 'adjusted',
  reversal: 'reversed'
} satisfies Record<MovementKind, MovementTrendGroup>;

export function movementTrendGroup(kind: string): MovementTrendGroup {
  return MOVEMENT_TREND_GROUPS[kind as MovementKind] ?? 'adjusted';
}

const MOVEMENT_TREND_GROUP_LABELS = {
  received: 'Received',
  sold: 'Sold',
  shrinkage: 'Shrinkage / disposal',
  adjusted: 'Adjustments',
  reversed: 'Reversals'
} satisfies Record<MovementTrendGroup, string>;

export function movementTrendGroupLabel(group: MovementTrendGroup): string {
  return MOVEMENT_TREND_GROUP_LABELS[group];
}

/** `inventory_locations.kind` — closed, `CHECK`ed. */
export type InventoryLocationKind =
  | 'site'
  | 'room'
  | 'area'
  | 'shelf'
  | 'bin'
  | 'container'
  | 'vehicle'
  | 'in_transit';

export const INVENTORY_LOCATION_KIND_VALUES: readonly InventoryLocationKind[] = [
  'site',
  'room',
  'area',
  'shelf',
  'bin',
  'container',
  'vehicle',
  'in_transit'
];

const LOCATION_KIND_LABELS = {
  site: 'Site',
  room: 'Room',
  area: 'Area',
  shelf: 'Shelf',
  bin: 'Bin',
  container: 'Container',
  vehicle: 'Vehicle',
  in_transit: 'In transit'
} satisfies Record<InventoryLocationKind, string>;

export function locationKindLabel(kind: string): string {
  return LOCATION_KIND_LABELS[kind as InventoryLocationKind] ?? kind;
}

export const locationKindOptions = INVENTORY_LOCATION_KIND_VALUES.map((value) => ({
  value,
  label: locationKindLabel(value)
}));

/** `acquisition_costs.cost_class` — closed, `CHECK`ed: capitalized `goods` vs. `ancillary`. */
export type AcquisitionCostClass = 'goods' | 'ancillary';

/**
 * Phase 4's one label for realized profitability — never "profit". As of
 * loxep-7fs (A11), `/inventory/profitability` renders this figure and
 * reads the authoritative label off `InventoryProfitabilityDto.contributionLabel`
 * (sourced from `@loxep/inventory/profitability.ts`'s own `CONTRIBUTION_LABEL`
 * export at request time), not this constant — this copy is kept only as a
 * fallback/reference for any future surface that needs the exact wording
 * before its own request has resolved.
 */
export const CONTRIBUTION_LABEL = 'contribution after goods, fees, and shipping';

/**
 * `inventory_items.sale_mode` (M3, loxep-dgf.3) — Loxep-owned closed set,
 * `CHECK`ed. Duplicated as a local literal union rather than imported from
 * `@loxep/db/schema`, the same reasoning as every other closed set in this
 * file. `'parted_out'` is included here (for LABELING an already-parted-out
 * item) but deliberately excluded from {@link SETTABLE_SALE_MODE_VALUES},
 * the operator-choosable subset — it is written once by the part-out
 * operation, never picked at intake or edited afterward.
 */
export type ItemSaleMode =
  | 'unit'
  | 'lot'
  | 'set'
  | 'parts_donor'
  | 'parted_out'
  | 'bundle_component';

export const SETTABLE_SALE_MODE_VALUES: readonly Exclude<ItemSaleMode, 'parted_out'>[] = [
  'unit',
  'lot',
  'set',
  'parts_donor',
  'bundle_component'
];

const ITEM_SALE_MODE_LABELS = {
  unit: 'Unit — one thing, sold as one thing',
  lot: 'Lot — several things, sold together',
  set: 'Set — a matched group, parting it destroys value',
  parts_donor: 'Parts donor — acquired to harvest from',
  parted_out: 'Parted out',
  bundle_component: 'Bundle component — held to combine later'
} satisfies Record<ItemSaleMode, string>;

export function itemSaleModeLabel(mode: string): string {
  return ITEM_SALE_MODE_LABELS[mode as ItemSaleMode] ?? mode;
}

export const settableSaleModeOptions = SETTABLE_SALE_MODE_VALUES.map((value) => ({
  value,
  label: itemSaleModeLabel(value)
}));

/**
 * `media_links.purpose` values for `resource_type = 'inventory_item'` (M3).
 * `purpose` never gains a `'primary'` value — primary is whichever `gallery`
 * row sorts first, per the design's gallery rule.
 */
export type ItemMediaPurpose = 'gallery' | 'condition_evidence' | 'supporting_document';

const ITEM_MEDIA_PURPOSE_LABELS = {
  gallery: 'Gallery',
  condition_evidence: 'Condition evidence',
  supporting_document: 'Supporting document'
} satisfies Record<ItemMediaPurpose, string>;

export function itemMediaPurposeLabel(purpose: string): string {
  return ITEM_MEDIA_PURPOSE_LABELS[purpose as ItemMediaPurpose] ?? purpose;
}

/**
 * `inventory_allocations.allocation_kind` — CLOSED, `CHECK`ed
 * (`inventory_allocations_kind_check`, `packages/db/src/schema/inventory.ts`).
 * Copied verbatim per this file's own module-doc convention.
 */
export type AllocationKind = 'order_line' | 'manual_hold' | 'transfer' | 'project';

const ALLOCATION_KIND_LABELS = {
  order_line: 'Order line',
  manual_hold: 'Manual hold',
  transfer: 'Transfer',
  project: 'Project'
} satisfies Record<AllocationKind, string>;

export function allocationKindLabel(kind: string): string {
  return ALLOCATION_KIND_LABELS[kind as AllocationKind] ?? kind;
}

/**
 * `inventory_allocations.status` — CLOSED, `CHECK`ed
 * (`inventory_allocations_status_check`).
 */
export type AllocationStatus = 'reserved' | 'fulfilled' | 'released' | 'cancelled' | 'expired';

const ALLOCATION_STATUS_LABELS = {
  reserved: 'Reserved',
  fulfilled: 'Fulfilled',
  released: 'Released',
  cancelled: 'Cancelled',
  expired: 'Expired'
} satisfies Record<AllocationStatus, string>;

export function allocationStatusLabel(status: string): string {
  return ALLOCATION_STATUS_LABELS[status as AllocationStatus] ?? status;
}

const ALLOCATION_STATUS_TONE = {
  reserved: 'warning',
  fulfilled: 'success',
  released: 'outline',
  cancelled: 'outline',
  expired: 'destructive'
} as const satisfies Record<AllocationStatus, BadgeVariant>;

/** `reserved` is `warning`, not neutral: it is stock the item's own on-hand count no longer covers as available. `expired` is `destructive`: a stale `manual_hold` past `expires_at` that nobody released — the exact gap the audit named. */
export function allocationStatusTone(status: string): BadgeVariant {
  return ALLOCATION_STATUS_TONE[status as AllocationStatus] ?? 'outline';
}
