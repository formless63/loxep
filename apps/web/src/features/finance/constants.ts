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

/**
 * Mirrors `EXPENSE_LINE_UNITS` (`@loxep/accounting`/`packages/db/src/schema/expenses.ts`)
 * — closed, CHECKed, nullable (expense entry v2, loxep-zk5). A modest
 * practical set: count, weight, length, area, time.
 */
export type ExpenseLineUnit =
  | 'each'
  | 'pair'
  | 'pack'
  | 'box'
  | 'case'
  | 'lot'
  | 'lb'
  | 'oz'
  | 'kg'
  | 'g'
  | 'ft'
  | 'in'
  | 'm'
  | 'cm'
  | 'sqft'
  | 'hr'
  | 'day'
  | 'mi'
  | 'km';

const EXPENSE_LINE_UNIT_LABELS = {
  each: 'each',
  pair: 'pair',
  pack: 'pack',
  box: 'box',
  case: 'case',
  lot: 'lot',
  lb: 'lb',
  oz: 'oz',
  kg: 'kg',
  g: 'g',
  ft: 'ft',
  in: 'in',
  m: 'm',
  cm: 'cm',
  sqft: 'sq ft',
  hr: 'hr',
  day: 'day',
  mi: 'mi',
  km: 'km'
} satisfies Record<ExpenseLineUnit, string>;

export const EXPENSE_LINE_UNIT_VALUES = Object.keys(
  EXPENSE_LINE_UNIT_LABELS
) as readonly ExpenseLineUnit[];

export function expenseLineUnitLabel(unit: string): string {
  return EXPENSE_LINE_UNIT_LABELS[unit as ExpenseLineUnit] ?? unit;
}

/** The select's own "no unit" sentinel — a plain string field value cannot carry `null` directly. */
export const NO_UNIT_VALUE = '__no_unit__';

export const expenseLineUnitOptions = [
  { value: NO_UNIT_VALUE, label: '—' },
  ...EXPENSE_LINE_UNIT_VALUES.map((value) => ({ value, label: expenseLineUnitLabel(value) }))
];

// -----------------------------------------------------------------------
// Trading partners (`/finance/partners`, loxep-l49) — mirrors
// `@loxep/counterparties`' closed sets as local literal unions, same
// reasoning as the expense unions above.
// -----------------------------------------------------------------------

/** Mirrors `counterparties.kind` (`@loxep/db/schema/counterparties.ts`) — closed, CHECKed. */
export type PartnerKind = 'person' | 'organization';

const PARTNER_KIND_LABELS = {
  person: 'Person',
  organization: 'Organization'
} satisfies Record<PartnerKind, string>;

export function partnerKindLabel(kind: string): string {
  return PARTNER_KIND_LABELS[kind as PartnerKind] ?? kind;
}

export const partnerKindOptions = (Object.keys(PARTNER_KIND_LABELS) as PartnerKind[]).map(
  (value) => ({ value, label: partnerKindLabel(value) })
);

/** Mirrors `counterparties.status` — closed, CHECKed. Distinct from `ExpenseStatus` above. */
export type PartnerStatus = 'active' | 'inactive' | 'archived';

const PARTNER_STATUS_LABELS = {
  active: 'Active',
  inactive: 'Inactive',
  archived: 'Archived'
} satisfies Record<PartnerStatus, string>;

export function partnerStatusLabel(status: string): string {
  return PARTNER_STATUS_LABELS[status as PartnerStatus] ?? status;
}

const PARTNER_STATUS_TONES = {
  active: 'success',
  inactive: 'outline',
  archived: 'secondary'
} satisfies Record<PartnerStatus, BadgeVariant>;

export function partnerStatusTone(status: string): BadgeVariant {
  return PARTNER_STATUS_TONES[status as PartnerStatus] ?? 'outline';
}

export const partnerStatusOptions = (Object.keys(PARTNER_STATUS_LABELS) as PartnerStatus[]).map(
  (value) => ({ value, label: partnerStatusLabel(value) })
);

/** Mirrors `counterparty_entity_roles.role` (`@loxep/db/schema/counterparties.ts`) — closed, CHECKed. */
export type PartnerRole =
  | 'customer'
  | 'vendor'
  | 'payer'
  | 'payee'
  | 'consignor'
  | 'subcontractor'
  | 'partner'
  | 'other';

export const PARTNER_ROLE_VALUES: readonly PartnerRole[] = [
  'customer',
  'vendor',
  'payer',
  'payee',
  'consignor',
  'subcontractor',
  'partner',
  'other'
];

const PARTNER_ROLE_LABELS = {
  customer: 'Customer',
  vendor: 'Vendor',
  payer: 'Payer',
  payee: 'Payee',
  consignor: 'Consignor',
  subcontractor: 'Subcontractor',
  partner: 'Partner',
  other: 'Other'
} satisfies Record<PartnerRole, string>;

export function partnerRoleLabel(role: string): string {
  return PARTNER_ROLE_LABELS[role as PartnerRole] ?? role;
}

export const partnerRoleOptions = PARTNER_ROLE_VALUES.map((value) => ({
  value,
  label: partnerRoleLabel(value)
}));

// -----------------------------------------------------------------------
// Chart of accounts (`/finance/books/$id`'s Accounts section, loxep-l49) —
// mirrors `LEDGER_ACCOUNT_TYPES` (`@loxep/db/schema/accounting.ts`).
// -----------------------------------------------------------------------

export type LedgerAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export const LEDGER_ACCOUNT_TYPE_VALUES: readonly LedgerAccountType[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense'
];

const LEDGER_ACCOUNT_TYPE_LABELS = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expense'
} satisfies Record<LedgerAccountType, string>;

export function ledgerAccountTypeLabel(type: string): string {
  return LEDGER_ACCOUNT_TYPE_LABELS[type as LedgerAccountType] ?? type;
}

export const ledgerAccountTypeOptions = LEDGER_ACCOUNT_TYPE_VALUES.map((value) => ({
  value,
  label: ledgerAccountTypeLabel(value)
}));

// -----------------------------------------------------------------------
// Journal (`/finance/books/$id`'s Journal section, loxep-l49) — mirrors
// `journal_entries.status`/`entry_source` (`@loxep/db/schema/accounting.ts`).
// -----------------------------------------------------------------------

export type JournalEntryStatus = 'draft' | 'posted' | 'reversed' | 'void';

const JOURNAL_ENTRY_STATUS_LABELS = {
  draft: 'Draft',
  posted: 'Posted',
  reversed: 'Reversed',
  void: 'Void'
} satisfies Record<JournalEntryStatus, string>;

export function journalEntryStatusLabel(status: string): string {
  return JOURNAL_ENTRY_STATUS_LABELS[status as JournalEntryStatus] ?? status;
}

const JOURNAL_ENTRY_STATUS_TONES = {
  draft: 'outline',
  posted: 'success',
  reversed: 'secondary',
  void: 'destructive'
} satisfies Record<JournalEntryStatus, BadgeVariant>;

export function journalEntryStatusTone(status: string): BadgeVariant {
  return JOURNAL_ENTRY_STATUS_TONES[status as JournalEntryStatus] ?? 'outline';
}

export const journalEntryStatusOptions = (
  Object.keys(JOURNAL_ENTRY_STATUS_LABELS) as JournalEntryStatus[]
).map((value) => ({ value, label: journalEntryStatusLabel(value) }));

const JOURNAL_ENTRY_SOURCE_LABELS = {
  posting_rule: 'Posting rule',
  manual: 'Manual',
  import: 'Import',
  opening_balance: 'Opening balance'
} satisfies Record<string, string>;

export function journalEntrySourceLabel(source: string): string {
  return JOURNAL_ENTRY_SOURCE_LABELS[source as keyof typeof JOURNAL_ENTRY_SOURCE_LABELS] ?? source;
}
