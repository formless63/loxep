/**
 * Client-safe constants for the Documents intake/import surfaces
 * (loxep-dgf.4, M4). Mirrors `LINE_DISPOSITIONS`/`DOCUMENT_STATUSES`
 * (`@loxep/db/schema/documents.ts`) as local literal unions rather than an
 * import, matching `@/features/finance/constants.ts`'s own reasoning: a
 * future addition to the schema's unions fails typechecking HERE instead of
 * silently drifting, and it keeps `@loxep/db` out of the client bundle.
 */
import type { VariantProps } from 'class-variance-authority';
import type { badgeVariants } from '@/components/ui/badge';

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export type LineDisposition =
  | 'pending'
  | 'expense'
  | 'acquisition_cost'
  | 'inventory_intake'
  | 'supplies'
  | 'personal'
  | 'not_mine'
  | 'duplicate'
  | 'discarded';

const DISPOSITION_LABELS = {
  pending: 'Needs review',
  expense: 'Expense',
  acquisition_cost: 'Cost of a lot',
  inventory_intake: 'Stock (inventory)',
  supplies: 'Supplies (expense)',
  personal: 'Personal — not business',
  not_mine: 'Not mine',
  duplicate: 'Duplicate',
  discarded: 'Discard'
} satisfies Record<LineDisposition, string>;

export function dispositionLabel(disposition: string): string {
  return DISPOSITION_LABELS[disposition as LineDisposition] ?? disposition;
}

/**
 * `acquisition_cost`/`inventory_intake` are OFFERED (the schema and the
 * review model support them fully) but this milestone's confirm action only
 * writes `expenses` — see `documents-functions.ts`'s
 * `CONFIRMABLE_AS_EXPENSE`. Picking one of the two here stages the intent
 * correctly; a lot/acquisition-cost or intake CONFIRM action is deferred
 * (needs an acquisition-lot picker this milestone does not build).
 */
export const DISPOSITION_VALUES: readonly LineDisposition[] = [
  'pending',
  'expense',
  'acquisition_cost',
  'inventory_intake',
  'supplies',
  'personal',
  'not_mine',
  'duplicate',
  'discarded'
];

export const dispositionOptions = DISPOSITION_VALUES.map((value) => ({
  value,
  label: dispositionLabel(value)
}));

/** Dispositions this milestone can actually confirm into a domain record (expenses only). */
export const CONFIRMABLE_DISPOSITIONS = new Set<LineDisposition>(['expense', 'supplies']);

export type DocumentStatus =
  | 'pending'
  | 'parsing'
  | 'review'
  | 'partially_confirmed'
  | 'confirmed'
  | 'discarded'
  | 'failed';

const DOCUMENT_STATUS_LABELS = {
  pending: 'Pending',
  parsing: 'Parsing',
  review: 'Needs review',
  partially_confirmed: 'Partially confirmed',
  confirmed: 'Confirmed',
  discarded: 'Discarded',
  failed: 'Failed'
} satisfies Record<DocumentStatus, string>;

export function documentStatusLabel(status: string): string {
  return DOCUMENT_STATUS_LABELS[status as DocumentStatus] ?? status;
}

const DOCUMENT_STATUS_TONES = {
  pending: 'outline',
  parsing: 'outline',
  review: 'secondary',
  partially_confirmed: 'secondary',
  confirmed: 'success',
  discarded: 'outline',
  failed: 'destructive'
} satisfies Record<DocumentStatus, BadgeVariant>;

export function documentStatusTone(status: string): BadgeVariant {
  return DOCUMENT_STATUS_TONES[status as DocumentStatus] ?? 'outline';
}
