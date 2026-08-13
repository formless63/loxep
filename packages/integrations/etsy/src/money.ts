/**
 * Money normalization for the Etsy boundary — the load-bearing divergence
 * from every other Loxep integration (eBay/WooCommerce/Medusa/Invoice Ninja
 * all report a decimal STRING already; Etsy does not).
 *
 * ## Etsy's `Money` shape — SOURCE-VERIFIED
 *
 * `{ amount: <integer>, divisor: <integer>, currency_code: <ISO 4217> }` —
 * e.g. `{"amount": 2999, "divisor": 100, "currency_code": "USD"}` means
 * $29.99. Confirmed against `anitabyte/etsyv3` (`main` branch, fetched
 * 2026-08-13, `tests/test_listing.py`, a request-body fixture using exactly
 * `{"amount": 0, "divisor": 0, "currency_code": "string"}`) and the binding
 * design (`etsy-integration-design.md`, "Money: integer + divisor, not a
 * decimal string"), which is itself sourced from Etsy's Payments tutorial
 * and Open API v3 docs.
 *
 * This is structurally different from eBay's `{value: "29.99", currency:
 * "USD"}` decimal-string `Amount` — the raw wire format here genuinely IS a
 * JSON number, so `packages/integrations/ebay/src/money.ts`'s "pass the
 * string through verbatim" discipline cannot apply. `divisor` is not
 * guaranteed to be a power of ten for every legacy currency Etsy has ever
 * supported, so `amount / divisor` is computed as an EXACT division over
 * `BigInt`s — never JS `number` division, which would introduce binary
 * floating-point error into a value the implementation contract requires be
 * exact (`numeric(20,6)` columns, "money is never JS `number` arithmetic").
 *
 * ## The conversion, in words
 *
 * 1. When `divisor` is a power of ten (true for every currency this
 *    document has evidence for — USD/EUR/GBP divisor 100, JPY divisor 1),
 *    `amount` IS the value already scaled by `10^places` where
 *    `places = log10(divisor)`. Un-scaling it is pure string surgery on the
 *    decimal digits of `amount` (identical in spirit to
 *    `@loxep/integration-ebay/money.ts`'s `formatScaled`) — no division, no
 *    rounding, no floating point, and the result always carries exactly
 *    `places` fractional digits (so `{amount: 0, divisor: 100}` normalizes
 *    to `"0.00"`, not `"0"`).
 * 2. When `divisor` is NOT a power of ten (a currency this document has no
 *    evidence Etsy actually reports, but the design explicitly warns not to
 *    assume it never happens), the exact quotient is computed by long
 *    division over `BigInt`s, terminating at up to {@link MAX_QUOTIENT_SCALE}
 *    fractional digits. If the division does not terminate within that
 *    bound, `null` is returned rather than a rounded guess — the same
 *    "never guess" discipline as eBay's `divideDecimals`.
 */
import { EtsyAdapterError } from "./errors.ts";

export const MAX_QUOTIENT_SCALE = 6;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

/**
 * How many trailing decimal digits `divisor` implies when it is an exact
 * power of ten (100 -> 2, 1 -> 0, 1000 -> 3). Returns `null` when `divisor`
 * is not a power of ten (0 excluded — a zero divisor is nonsensical money).
 */
function decimalPlacesForPowerOfTen(divisor: bigint): number | null {
  if (divisor <= 0n) return null;
  let remaining = divisor;
  let places = 0;
  while (remaining % 10n === 0n) {
    remaining /= 10n;
    places += 1;
  }
  return remaining === 1n ? places : null;
}

/** Un-scale an integer already expressed in units of `10^-places`. */
function formatFixedScale(amount: bigint, places: number): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const digits = magnitude.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places) || "0";
  const fraction = places === 0 ? "" : `.${digits.slice(digits.length - places)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * Exact long division `numerator / denominator` as a decimal string,
 * terminating at up to `maxScale` fractional digits. Returns `null` when the
 * quotient does not terminate within that bound — never a rounded guess.
 */
function bigintDivideToDecimal(
  numerator: bigint,
  denominator: bigint,
  maxScale: number,
): string | null {
  if (denominator === 0n) return null;
  const negative = numerator < 0n !== denominator < 0n;
  const num = numerator < 0n ? -numerator : numerator;
  const den = denominator < 0n ? -denominator : denominator;
  const whole = num / den;
  let remainder = num % den;
  if (remainder === 0n) {
    return `${negative && whole !== 0n ? "-" : ""}${whole.toString()}`;
  }
  let digits = "";
  let scale = 0;
  while (remainder !== 0n && scale < maxScale) {
    remainder *= 10n;
    digits += (remainder / den).toString();
    remainder %= den;
    scale += 1;
  }
  if (remainder !== 0n) return null;
  return `${negative ? "-" : ""}${whole.toString()}.${digits}`;
}

/**
 * Convert an Etsy `Money` object's `{amount, divisor}` pair into an exact
 * decimal string. Returns `null` when the input is not shaped like a Money
 * object, `amount`/`divisor` are not safe integers, `divisor` is not
 * positive, or (only for a non-power-of-ten divisor) the division does not
 * terminate within {@link MAX_QUOTIENT_SCALE} places.
 */
export function decimalFromEtsyMoney(value: unknown): string | null {
  const record = asRecord(value);
  if (record === null) return null;
  const amount = asSafeInteger(record["amount"]);
  const divisor = asSafeInteger(record["divisor"]);
  if (amount === null || divisor === null || divisor <= 0) return null;

  const amountBig = BigInt(amount);
  const divisorBig = BigInt(divisor);
  const places = decimalPlacesForPowerOfTen(divisorBig);
  if (places !== null) {
    return formatFixedScale(amountBig, places);
  }
  return bigintDivideToDecimal(amountBig, divisorBig, MAX_QUOTIENT_SCALE);
}

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/** Read the ISO-4217 `currency_code` out of an Etsy `Money` object. */
export function etsyMoneyCurrency(value: unknown): string | null {
  const record = asRecord(value);
  if (record === null) return null;
  const code = record["currency_code"];
  return typeof code === "string" && CURRENCY_CODE.test(code)
    ? code.toUpperCase()
    : null;
}

/** Normalized Loxep-owned money shape — the boundary's exported form. */
export interface EtsyMoney {
  /** Exact decimal string (never a JS float). */
  value: string;
  /** ISO-4217 currency code. */
  currency: string;
}

/**
 * Normalize an Etsy `Money` object into the Loxep-owned {@link EtsyMoney}
 * shape, or `null` when either half is unusable (absent, malformed, or a
 * non-terminating division — see {@link decimalFromEtsyMoney}).
 */
export function normalizeEtsyMoney(value: unknown): EtsyMoney | null {
  const decimalValue = decimalFromEtsyMoney(value);
  const currency = etsyMoneyCurrency(value);
  if (decimalValue === null || currency === null) return null;
  return { value: decimalValue, currency };
}

/** Thrown only by call sites that need money and treat its absence as fatal. */
export function requireEtsyMoney(
  value: unknown,
  context: string,
): EtsyMoney {
  const money = normalizeEtsyMoney(value);
  if (money === null) {
    throw new EtsyAdapterError(
      "provider_unavailable",
      `Etsy returned an unusable Money value for ${context}`,
    );
  }
  return money;
}
