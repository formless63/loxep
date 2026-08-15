/**
 * Client-safe constants for the /finance workspace (loxep-dgf.1, M1).
 *
 * `ExpenseStatus`/`ExpensePaymentMethod`/expense category values are
 * deliberately local literal unions, not imports of `@loxep/db/schema` —
 * mirrors `@/features/market/constants.ts`'s reasoning: a future addition to
 * the schema's unions fails typechecking HERE (the `satisfies` below)
 * instead of silently drifting, and it keeps `@loxep/db` out of the client
 * bundle.
 */
import type { VariantProps } from 'class-variance-authority';
import type { badgeVariants } from '@/components/ui/badge';

/** No dedicated `BadgeVariant` export exists yet; derived from the cva config. */
export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

/** Mirrors `EXPENSE_STATUSES` minus `posted` — unreachable in this slice (no posting engine caller exists). */
export type ExpenseStatus = 'draft' | 'recorded' | 'void';

export const EXPENSE_STATUS_VALUES: readonly ExpenseStatus[] = ['draft', 'recorded', 'void'];

const EXPENSE_STATUS_LABELS = {
  draft: 'Draft',
  recorded: 'Recorded',
  void: 'Void'
} satisfies Record<ExpenseStatus, string>;

export function expenseStatusLabel(status: string): string {
  return EXPENSE_STATUS_LABELS[status as ExpenseStatus] ?? status;
}

/** `recorded` is a LOCK (the design's rule) — success, not a neutral default, because it is the completed state. */
const EXPENSE_STATUS_TONES = {
  draft: 'outline',
  recorded: 'success',
  void: 'secondary'
} satisfies Record<ExpenseStatus, BadgeVariant>;

export function expenseStatusTone(status: string): BadgeVariant {
  return EXPENSE_STATUS_TONES[status as ExpenseStatus] ?? 'outline';
}

export const expenseStatusOptions = EXPENSE_STATUS_VALUES.map((value) => ({
  value,
  label: expenseStatusLabel(value)
}));

/** Mirrors `EXPENSE_PAYMENT_METHODS` (`@loxep/db/schema/expenses.ts`) — closed, CHECKed. */
export type ExpensePaymentMethod =
  | 'card'
  | 'cash'
  | 'bank_transfer'
  | 'marketplace_balance'
  | 'direct_debit'
  | 'other';

const PAYMENT_METHOD_LABELS = {
  card: 'Card',
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  marketplace_balance: 'Marketplace balance',
  direct_debit: 'Direct debit',
  other: 'Other'
} satisfies Record<ExpensePaymentMethod, string>;

export const PAYMENT_METHOD_VALUES = Object.keys(
  PAYMENT_METHOD_LABELS
) as readonly ExpensePaymentMethod[];

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method as ExpensePaymentMethod] ?? method;
}

export const paymentMethodOptions = PAYMENT_METHOD_VALUES.map((value) => ({
  value,
  label: paymentMethodLabel(value)
}));

/**
 * Starter vocabulary — `expenses.category` is a genuinely OPEN set (no
 * `CHECK`, "the operator's own vocabulary", per the design) mirroring
 * `EXPENSE_CATEGORIES` (`@loxep/db/schema/expenses.ts`). Offered as
 * autocomplete suggestions only; the quick-entry field stays free text.
 */
export const SUGGESTED_EXPENSE_CATEGORIES = [
  'supplies',
  'shipping_supplies',
  'postage',
  'software_subscription',
  'marketplace_subscription',
  'advertising',
  'professional_services',
  'bank_fees',
  'insurance',
  'rent',
  'utilities',
  'vehicle_mileage',
  'travel',
  'meals',
  'equipment',
  'repairs_maintenance',
  'storage',
  'education',
  'taxes_licenses',
  'other'
] as const;

/** The sentinel the entity picker submits as an EXPLICIT `economicEntityId: null` — "Unattributed", distinct from omission (`resolveExpenseAttribution`). */
export const UNATTRIBUTED_ENTITY_VALUE = '__unattributed__';

/**
 * Receipt/invoice/supporting-document purposes on `media_links` for an
 * expense's attachments (`ReceiptsService` / `EXPENSE_MEDIA_PURPOSES`).
 */
export type ExpenseMediaPurpose = 'receipt' | 'invoice' | 'supporting_document';

const RECEIPT_PURPOSE_LABELS = {
  receipt: 'Receipt',
  invoice: 'Invoice',
  supporting_document: 'Supporting document'
} satisfies Record<ExpenseMediaPurpose, string>;

export function receiptPurposeLabel(purpose: string): string {
  return RECEIPT_PURPOSE_LABELS[purpose as ExpenseMediaPurpose] ?? purpose;
}

/**
 * Mirrors `EXPENSE_LINE_KINDS` (`@loxep/accounting`/`packages/db/src/schema/expenses.ts`)
 * — closed, CHECKed. `expense_lines`, not `expense_allocations`: what was
 * bought, not where the money is charged (loxep-cd3.3, M3).
 */
export type ExpenseLineKind = 'item' | 'shipping' | 'tax' | 'fee' | 'discount' | 'other';

const EXPENSE_LINE_KIND_LABELS = {
  item: 'Item',
  shipping: 'Shipping',
  tax: 'Tax',
  fee: 'Fee',
  discount: 'Discount',
  other: 'Other'
} satisfies Record<ExpenseLineKind, string>;

export const EXPENSE_LINE_KIND_VALUES = Object.keys(
  EXPENSE_LINE_KIND_LABELS
) as readonly ExpenseLineKind[];

export function expenseLineKindLabel(kind: string): string {
  return EXPENSE_LINE_KIND_LABELS[kind as ExpenseLineKind] ?? kind;
}

export const expenseLineKindOptions = EXPENSE_LINE_KIND_VALUES.map((value) => ({
  value,
  label: expenseLineKindLabel(value)
}));
