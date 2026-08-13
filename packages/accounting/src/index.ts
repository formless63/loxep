/**
 * @loxep/accounting — the general ledger, and the expenses that feed it.
 *
 * ## What this package now owns
 *
 * ```text
 * books.ts           accounting books, the effective-dated entity link, and
 *                    the routing rule (including the parent roll-up)
 * chart.ts           the per-book chart of accounts
 * chart-template.ts  the code-owned starter chart, copied once per book
 * periods.ts         fiscal periods, generation, and the four-state close
 * journal.ts         drafting, posting, idempotency, and reversal
 * ledger-reports.ts  trial balance, account balances, activity, entity slice
 * expenses.ts        expenses and their flexible cost attribution
 * receipts.ts        receipt evidence through media_links
 * reports.ts         the expense read models
 * posting.ts         the source-fact seam between a fact and an entry
 * ```
 *
 * ## Two of Phase 5's four milestones
 *
 * The [Financial Foundation Schema Design](../../../apps/docs) specifies
 * twenty-two tables across four domains. Eleven exist: expenses and their
 * allocations, then books, the chart, dimensions, periods, and the journal.
 * The rest are later milestones and their absence is still a decision:
 *
 * ```text
 * posting_rules / versions / lines        the declarative rule model
 * journal_entry_source_links              multi-fact provenance
 * financial_accounts / payouts / banking  money movement
 * reconciliation_matches                  match state
 * sales_tax_facts                         the facilitator distinction
 * ```
 *
 * The three OWNER-REVIEW-CRITICAL questions that blocked the ledger were
 * answered on 2026-08-12, and every one of them is physical here: books are
 * toggleable per entity with a child's book rolling up to its parent's;
 * corrections are reversal plus repost and posted entries are immutable; the
 * build is USD-only with the per-line conversion seam kept intact.
 *
 * ## Why expenses live here and not in `@loxep/domain`
 *
 * Phase 5's own open question 14 recommended `@loxep/domain` "alongside the
 * other cross-cutting facts". Phase 6's design revisited it with the general
 * domain-to-package rule it proposes, and reached the opposite answer: under
 * that rule's second test (an acyclic inbound edge), expenses belong in
 * `@loxep/accounting`, because Accounting depends on expenses and nothing else
 * does. Both documents flag this as the reviewer's first test of the proposed
 * rule. It is implemented the second way, PROVISIONALLY, and moving it is a
 * file move plus import churn.
 *
 * ## Everything here is PROVISIONAL
 *
 * Written under an explicit owner directive to implement the recommendations
 * this slice touches and mark the result PROVISIONAL for review:
 *
 * ```text
 * expenses.category is an OPEN set; payment_method/status are CHECKed
 * payee stays denormalized text — no counterparty FK, even though
 *   counterparties ship in the same migration
 * sum(allocations) = amount is a service rule and a report, never a trigger;
 *   OVER-allocation is refused, under-allocation is a draft
 * an expense with no allocations is valid and complete
 * receipts are media_links rows; no receipts table exists
 * non-capitalized acquisition_costs are NOT copied into expenses
 * only `draft` is mutable; there is no reopen
 * ```
 *
 * ## What this package still does NOT do
 *
 * No declarative posting rules and therefore no automatic posting from
 * operational facts; no payouts, banking, or reconciliation; no tax
 * calculation or filing; no reimbursement workflow, vendor bills, or AP; no
 * OCR; no balance sheet or P&L statement objects (the trial balance and
 * account balances are the read models this milestone ships); no stored
 * closing entries or retained-earnings roll; and **no currency conversion
 * anywhere** — the seam exists, unused, and every expense total still carries
 * its own currency rather than being summed across two.
 */

export {
  AccountingError,
  AccountingValidationError,
  AccountingNotFoundError,
  AccountingConflictError,
  ExpenseNotEditableError,
  ExpenseOverAllocatedError,
} from "./errors.ts";

export {
  DECIMAL_STRING,
  MONEY_SCALE,
  ZERO,
  absDecimal,
  compareDecimals,
  fromUnits,
  isDecimalString,
  isNegative,
  isZeroDecimal,
  negateDecimal,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
  toUnits,
} from "./decimal.ts";

export {
  ACCOUNTING_SETTINGS_PREFIX,
  DEFAULT_ENTITY_SETTING_KEY,
  REATTRIBUTABLE_SOURCES,
  resolveExpenseAttribution,
} from "./attribution.ts";
export type { ResolvedExpenseAttribution } from "./attribution.ts";

export {
  expenseReferenceCode,
  isUniqueViolation,
  withCodeRetry,
} from "./codes.ts";

export {
  EXPENSE_SOURCE_FACT_TYPE,
  POSTED_STATUS,
  expenseSourceFact,
  isPostable,
} from "./posting.ts";
export type { SourceFactIdentity } from "./posting.ts";

export {
  allocationsFit,
  createExpensesService,
  unallocatedRemainder,
} from "./expenses.ts";
export type {
  AllocationInput,
  AllocationSummary,
  CreateExpenseInput,
  ExpenseAllocationRow,
  ExpenseRow,
  ExpenseStatus,
  ExpensesService,
  UpdateExpenseInput,
} from "./expenses.ts";

export { createReceiptsService } from "./receipts.ts";
export type { AttachReceiptInput, ReceiptsService } from "./receipts.ts";

export { createExpenseReports } from "./reports.ts";
export type {
  ExpenseFilter,
  ExpenseGrouping,
  ExpenseListRow,
  ExpenseReports,
  ExpenseTotalRow,
  UnallocatedExpenseRow,
} from "./reports.ts";

/* ------------------------------------------------------------ the ledger */

export {
  BookRoutingError,
  FiscalPeriodClosedError,
  LedgerImmutableError,
  UnbalancedEntryError,
  UnsupportedCurrencyError,
} from "./errors.ts";

export {
  DEFAULT_FUNCTIONAL_CURRENCY,
  SUPPORTED_FUNCTIONAL_CURRENCIES,
  assertSupportedCurrency,
  isSupportedCurrency,
  normalizeCurrency,
} from "./currency.ts";
export type { SupportedFunctionalCurrency } from "./currency.ts";

export { DEFAULT_CHART_TEMPLATE } from "./chart-template.ts";
export type { ChartTemplateAccount } from "./chart-template.ts";

export {
  ACCOUNTING_SETTING_KEYS,
  DEFAULT_BOOK_SETTING_KEY,
  createBooksService,
} from "./books.ts";
export type {
  AccountingBookRow,
  BookEntityLinkRow,
  BookRouting,
  BooksService,
  CreateBookInput,
  LinkEntityInput,
  PostingBookSource,
} from "./books.ts";

export { createAccountsService, normalBalanceOf } from "./chart.ts";
export type {
  AccountsService,
  CreateAccountInput,
  LedgerAccountRow,
  UpdateAccountInput,
} from "./chart.ts";

export {
  assertPeriodAcceptsPosting,
  createFiscalPeriodsService,
  fiscalYearFor,
  fiscalYearStartDate,
  isExclusionViolation,
  noPeriodError,
  periodCodeFor,
} from "./periods.ts";
export type {
  FiscalPeriodRow,
  FiscalPeriodsService,
  GenerateFiscalYearInput,
} from "./periods.ts";

export { assertBalanced, createJournalService } from "./journal.ts";
export type {
  CreateDraftInput,
  JournalEntryFilter,
  JournalEntryRow,
  JournalLineInput,
  JournalLineRow,
  JournalService,
  PostEntryInput,
  PostedEntry,
} from "./journal.ts";

export { createLedgerReports } from "./ledger-reports.ts";
export type {
  AccountActivityRow,
  AccountBalance,
  LedgerReportFilter,
  LedgerReports,
  TrialBalance,
  TrialBalanceRow,
} from "./ledger-reports.ts";
