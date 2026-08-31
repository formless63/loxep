/**
 * Decimal-string discipline for the Invoice Ninja boundary.
 *
 * Money is PostgreSQL `numeric` and never a JavaScript `number`
 * (implementation contract; the Services & Billing Schema Design uses
 * `numeric(20,6)` throughout for `invoices`/`invoice_lines`). Every amount
 * this package exports is therefore a DECIMAL STRING.
 *
 * ## Invoice Ninja v5 money representation — VERIFIED, not assumed
 *
 * SOURCE-VERIFIED: `App\Transformers\InvoiceTransformer::transform()` and
 * `App\Transformers\ClientTransformer::transform()`
 * (`invoiceninja/invoiceninja`, `v5-stable` branch, fetched 2026-08-13:
 * https://github.com/invoiceninja/invoiceninja/blob/v5-stable/app/Transformers/InvoiceTransformer.php,
 * https://github.com/invoiceninja/invoiceninja/blob/v5-stable/app/Transformers/ClientTransformer.php)
 * cast every money field with PHP's `(float)` before it enters the response
 * array — `'amount' => (float) $invoice->amount`, `'balance' => (float)
 * $invoice->balance`, `'paid_to_date' => (float) $client->paid_to_date`, and
 * so on. A `(float)`-cast PHP value serializes through `json_encode` as a
 * plain JSON number in the entity's stored MAJOR currency unit (Invoice
 * Ninja stores `$10.50` as `10.5`, not `1050`) — the same representation
 * style Medusa v2 uses (see `@loxep/integration-medusa`'s `money.ts`), and
 * unlike a minor-unit-integer convention (Stripe, Medusa v1).
 *
 * This is not yet authenticated-live-verified. The claim rests on the
 * transformer source, which is the ground truth for what the API serializes
 * (transformers are the last step before `json_encode`, with no further cast
 * applied downstream in `BaseController::response()`).
 *
 * ## The conversion, precisely
 *
 * An Invoice Ninja money field arrives as a JS `number` already denominated
 * in major units. {@link decimalFromNumber} converts it to a decimal string
 * through JavaScript's shortest-round-trip formatting (`String(value)`),
 * which recovers the exact JSON literal for any realistic money value and
 * returns `null` rather than guessing for a value that formats to
 * exponential notation — the identical technique
 * `@loxep/integration-medusa`'s `decimalFromNumber` uses.
 *
 * No currency-precision rounding table is offered here (contrast Medusa's
 * `MEDUSA_CURRENCY_DECIMAL_DIGITS`): Invoice Ninja's own currency-precision
 * behavior was not researched for this package, and inventing a table would
 * be exactly the kind of guessed fact the dependency policy forbids.
 * Callers that need it should verify against Invoice Ninja's own
 * `resources/static/currencies.json` before adding one.
 */

export const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

/**
 * Provider decimal string, passed through VERBATIM (trailing zeros and all —
 * scale is provider evidence). Returns null for anything not decimal-shaped.
 * Invoice Ninja's transformers send money as `(float)`, not as a string, but
 * this is kept for robustness the way the Medusa/WooCommerce adapters' dual
 * -path helpers are, in case a future endpoint (or a locale-aware export)
 * sends a decimal string instead.
 */
export function decimalFromProvider(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return DECIMAL_STRING.test(trimmed) ? trimmed : null;
}

/**
 * Convert a JSON number to a decimal string, or null when it cannot be
 * represented exactly in plain decimal notation (non-finite, or large/small
 * enough that JavaScript formats it with an exponent). This is the primary
 * path for Invoice Ninja money fields — see the module doc.
 */
export function decimalFromNumber(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const text = String(value);
  return DECIMAL_STRING.test(text) ? text : null;
}

/** Provider money that may arrive as either a number or a string. */
export function decimalFromUnknown(value: unknown): string | null {
  return decimalFromNumber(value) ?? decimalFromProvider(value);
}

/**
 * Format a Loxep-owned decimal-string amount for the OUTBOUND wire — Invoice
 * Ninja's `line_items[].cost` etc. expect a plain JSON number, matching the
 * inbound representation. Throws on a non-finite/non-decimal input rather
 * than silently sending `NaN`/`0` for a value this package cannot represent
 * safely as a JSON number (a value so large or precise that `Number()`
 * cannot round-trip it back to the same decimal string is rejected, not
 * truncated).
 */
export function numberFromDecimal(value: string): number {
  if (!DECIMAL_STRING.test(value)) {
    throw new RangeError(`"${value}" is not a decimal string`);
  }
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) {
    throw new RangeError(`"${value}" does not fit a finite JS number`);
  }
  return asNumber;
}
