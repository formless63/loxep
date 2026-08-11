/**
 * @loxep/accounting — expenses, their flexible cost attribution, and the seam a
 * future ledger will post them through.
 *
 * ## This package is a deliberate fraction of Phase 5
 *
 * The [Financial Foundation Schema Design](../../../apps/docs) specifies
 * twenty-two tables across four domains. This package ships **two**, and stops
 * exactly where that document's three OWNER-REVIEW-CRITICAL open questions
 * begin. There is no `accounting_books`, no chart of accounts, no dimension, no
 * fiscal period, no journal, no posting rule, no payout, no bank import, no
 * reconciliation, and no sales-tax fact — and their absence is a decision, not
 * a backlog:
 *
 * ```text
 * OQ1  book granularity and whether book_entity_links ROUTE or DESCRIBE
 * OQ2  posting-rule mutability, and reverse-and-repost versus mutation
 * OQ3  functional currency, and whether it can ever change
 * ```
 *
 * Each is unrecoverable after a single entry posts. Expenses are the one part
 * of Phase 5 whose usefulness does not depend on any of them: an expense is an
 * operational fact about money that left the business, it is worth recording
 * whether or not a book exists to post it to, and the ledger — when it arrives
 * — reads it through an unenforced source-fact stamp rather than a foreign key.
 * See `posting.ts`, which is this package's entire statement about the ledger.
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
 * ## What this package does NOT do
 *
 * No double entry, no debits or credits, no trial balance, no statements, no
 * period close, no tax calculation or filing, no reimbursement workflow, no
 * vendor bills, no AP, no OCR, and no currency conversion anywhere. A grouped
 * total always carries its currency; nothing is ever summed across two.
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
