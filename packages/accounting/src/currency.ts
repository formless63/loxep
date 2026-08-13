/**
 * The one-currency answer, and the seam that keeps it from being permanent.
 *
 * Owner answer 3 (2026-08-12): **USD-only for the initial build, defaulted per
 * book, with the multi-currency seam kept in the schema so other currencies can
 * be wired later without restatement.** That is a product decision about what
 * this build supports, not a claim that money is always dollars, and the
 * difference between those two statements is the whole reason this module is
 * three functions rather than a hardcoded string.
 *
 * ## Where the seam physically is
 *
 * ```text
 * accounting_books.functional_currency   the book's reporting currency
 * journal_lines.currency + amount        the TRANSACTION currency and amount
 * journal_lines.functional_amount        the same money in the book's currency
 * journal_lines.fx_rate / _source / _at  the rate used, FROZEN at posting
 * ```
 *
 * Every one of those columns exists today and every one is populated: a USD
 * line in a USD book carries `fx_rate = 1` and `fx_rate_source = 'unity'`
 * rather than nulls, precisely so that no read path has to branch on a null
 * when the second currency arrives. Adding EUR later means allowing the value
 * here and computing a real `functional_amount`; it means changing no column,
 * rewriting no row, and restating no statement.
 *
 * ## Why this is not a CHECK constraint
 *
 * A `CHECK (currency = 'USD')` would have to be dropped by the very migration
 * that enables the feature the surrounding columns were designed for. A
 * constraint whose removal is a planned step is not a safety rail; it is a
 * comment with downtime. The refusal belongs where the product decision is —
 * the service boundary — and the database keeps enforcing the invariants that
 * are true regardless of currency: balance per currency, the unity pairing, and
 * a positive rate.
 */
import { UnsupportedCurrencyError } from "./errors.ts";

/**
 * The currencies this build accepts as a book's functional currency, and
 * therefore as a journal line's currency.
 *
 * One member, by owner decision. The array shape is not decoration: it is what
 * makes enabling a second currency a one-line change in one file with a test
 * that already covers the multi-member case.
 */
export const SUPPORTED_FUNCTIONAL_CURRENCIES = ["USD"] as const;
export type SupportedFunctionalCurrency =
  (typeof SUPPORTED_FUNCTIONAL_CURRENCIES)[number];

/** The currency a book gets when the caller does not name one. */
export const DEFAULT_FUNCTIONAL_CURRENCY: SupportedFunctionalCurrency = "USD";

/** ISO-4217 alphabetic, normalized to upper case so `usd` is never a second currency. */
export function normalizeCurrency(value: string): string {
  const trimmed = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(trimmed)) {
    throw new UnsupportedCurrencyError(
      `"${value}" is not an ISO-4217 alphabetic currency code`,
    );
  }
  return trimmed;
}

export function isSupportedCurrency(value: string): boolean {
  return (SUPPORTED_FUNCTIONAL_CURRENCIES as readonly string[]).includes(
    value.trim().toUpperCase(),
  );
}

/**
 * Normalize, then refuse anything this build does not support — naming the
 * seam, so the reader of the error learns what would have to change rather than
 * only that something is unsupported.
 */
export function assertSupportedCurrency(value: string, context: string): string {
  const currency = normalizeCurrency(value);
  if (isSupportedCurrency(currency)) return currency;
  throw new UnsupportedCurrencyError(
    `${context}: ${currency} is not supported — this build is ` +
      `${SUPPORTED_FUNCTIONAL_CURRENCIES.join("/")}-only by owner decision ` +
      "(financial-schema-design.md, owner answer 3). The multi-currency SEAM " +
      "is already in the schema and unused: journal_lines carries " +
      "currency/amount alongside functional_currency/functional_amount/" +
      "fx_rate/fx_rate_source, with the rate frozen per line at posting. " +
      "Enabling another currency means widening " +
      "SUPPORTED_FUNCTIONAL_CURRENCIES and computing a real functional " +
      "amount — it restates nothing that is already posted.",
  );
}
