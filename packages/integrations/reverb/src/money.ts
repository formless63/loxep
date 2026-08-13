/**
 * Money normalization for the Reverb boundary — VERIFIED, not assumed, per
 * the task that scoped this package.
 *
 * ## Reverb's `Money` shape — SOURCE-VERIFIED
 *
 * A listing's `price` is `{amount: "5000.00", currency: "USD"}` — `amount`
 * is ALREADY a decimal STRING, confirmed against the literal example on
 * https://www.reverb-api.com/docs/create-listings (fetched 2026-08-13).
 * Order-context money objects are richer —
 * `{amount, amount_cents, currency, symbol, display}`, e.g.
 * `{"amount": "95.00", "amount_cents": 9500, "currency": "USD",
 * "symbol": "$", "display": "$95"}` — confirmed against
 * https://www.reverb-api.com/docs/retrieve-orders and
 * https://www.reverb-api.com/docs/manage-refund-requests, but `amount` is
 * still the authoritative decimal string in every case observed;
 * `amount_cents` is a convenience integer duplicate, never a second source
 * of truth, and `symbol`/`display` are presentation strings this module
 * never parses as data.
 *
 * This is structurally the SAME shape as eBay's `{value, currency}` Amount
 * (a decimal string), and simpler than Etsy's `{amount: <integer>, divisor}`
 * Money, which needs exact `BigInt` division to un-scale. Reverb needs no
 * such conversion: the wire format already IS the exact decimal string the
 * implementation contract requires (`numeric(20,6)` columns, "money is never
 * JS `number` arithmetic"), so this module's job is validation and
 * pass-through, never arithmetic.
 */

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Validate and pass through Reverb's decimal-string `amount` — never
 * `parseFloat`, never JS `number` arithmetic on it. Returns `null` when the
 * value is absent or not shaped like a decimal string.
 */
export function decimalFromReverbMoney(value: unknown): string | null {
  const record = asRecord(value);
  if (record === null) return null;
  const amount = record["amount"];
  return typeof amount === "string" && DECIMAL_STRING.test(amount) ? amount : null;
}

/** Read the ISO-4217 `currency` out of a Reverb Money object. */
export function reverbMoneyCurrency(value: unknown): string | null {
  const record = asRecord(value);
  if (record === null) return null;
  const currency = record["currency"];
  return typeof currency === "string" && CURRENCY_CODE.test(currency)
    ? currency.toUpperCase()
    : null;
}

/** Normalized Loxep-owned money shape — the boundary's exported form. */
export interface ReverbMoney {
  /** Exact decimal string, passed through verbatim (never a JS float). */
  value: string;
  /** ISO-4217 currency code. */
  currency: string;
}

/**
 * Normalize a Reverb Money object into the Loxep-owned {@link ReverbMoney}
 * shape, or `null` when either half is unusable (absent or malformed).
 */
export function normalizeReverbMoney(value: unknown): ReverbMoney | null {
  const decimalValue = decimalFromReverbMoney(value);
  const currency = reverbMoneyCurrency(value);
  if (decimalValue === null || currency === null) return null;
  return { value: decimalValue, currency };
}
