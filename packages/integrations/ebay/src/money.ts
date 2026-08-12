/**
 * Decimal-string discipline for the eBay boundary.
 *
 * Money is PostgreSQL `numeric(20,6)` and never a JavaScript `number`
 * (implementation contract; Commerce Schema Design uses `numeric(20,6)`
 * throughout). Every amount this package exports is therefore a DECIMAL
 * STRING, and the few places arithmetic is unavoidable use scaled `BigInt`,
 * never floats.
 *
 * This is a deliberate re-declaration of `@loxep/integration-woo/money`'s
 * discipline, NOT an import of it: integration packages must not depend on
 * each other (a shared `@loxep/integration-core` would make every provider's
 * arithmetic a common upgrade hazard), and `@loxep/commerce` re-declares the
 * same helpers again for the same reason.
 *
 * ## eBay's money shape
 *
 * Every monetary field in the Sell Fulfillment API is an `Amount`/
 * `SimpleAmount` object — `{ value: "12.34", currency: "USD" }` — where
 * `value` is a STRING. Verified against `ebay-api@10.0.0`'s bundled OpenAPI
 * types (`lib/types/restful/specs/sell_fulfillment_v1_oas3.d.ts`, schema
 * `Amount`). Unlike WooCommerce, eBay has **no float money field**: the one
 * numeric field on a line item is `quantity`, an integer count.
 *
 * `Amount` may additionally carry `convertedFromValue`/`convertedFromCurrency`
 * when eBay converted the buyer's currency. Loxep stores the settled
 * `value`/`currency` pair and leaves the conversion evidence in the retained
 * payload — Phase 3 does no FX (design open question 4).
 *
 * Where arithmetic is unavoidable, and why:
 *
 * 1. `order_lines.unit_price` — eBay reports `lineItemCost` (the extended
 *    line cost) and `quantity`, never a unit price. {@link divideDecimals}
 *    computes it exactly and returns `null` rather than rounding when the
 *    quotient does not terminate.
 * 2. `order_lines.discount_amount` — eBay reports `lineItemCost` and
 *    `discountedLineItemCost` but not their difference.
 * 3. `orders.discount_amount` — the sum of the price and delivery discounts.
 * 4. per-line and per-order refund rollups — eBay reports refunds as a list,
 *    not a total.
 *
 * All are exact decimal operations on provider-reported decimal strings.
 */

export const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

/**
 * Provider decimal string, passed through VERBATIM (trailing zeros and all —
 * scale is provider evidence). Returns null for anything not decimal-shaped,
 * including `""`.
 */
export function decimalFromProvider(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return DECIMAL_STRING.test(trimmed) ? trimmed : null;
}

/**
 * Convert a JSON number to a decimal string, or null when it cannot be
 * represented exactly in plain decimal notation (non-finite, or large/small
 * enough that JavaScript formats it with an exponent).
 *
 * eBay uses JSON numbers only for counts (`quantity`, `total`, `limit`), but
 * a payload is untrusted input and a provider may change a shape.
 */
export function decimalFromNumber(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const text = String(value);
  return DECIMAL_STRING.test(text) ? text : null;
}

/** Provider money that may arrive as either a string or a number. */
export function decimalFromUnknown(value: unknown): string | null {
  return decimalFromProvider(value) ?? decimalFromNumber(value);
}

/**
 * Read the `value` out of an eBay `Amount`/`SimpleAmount` container. Returns
 * null when the container is absent or its value is not decimal-shaped, which
 * is the normal "eBay omitted this amount" case — every money field in the
 * Fulfillment schema is optional.
 */
export function amountValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return decimalFromUnknown((value as Record<string, unknown>)["value"]);
}

/** Read the ISO-4217 `currency` out of an eBay `Amount`/`SimpleAmount`. */
export function amountCurrency(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const currency = (value as Record<string, unknown>)["currency"];
  return typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)
    ? currency.toUpperCase()
    : null;
}

interface ScaledDecimal {
  units: bigint;
  scale: number;
}

function parseScaled(value: string): ScaledDecimal {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf(".");
  const digits =
    dot === -1 ? unsigned : unsigned.slice(0, dot) + unsigned.slice(dot + 1);
  const scale = dot === -1 ? 0 : unsigned.length - dot - 1;
  const units = BigInt(digits);
  return { units: negative ? -units : units, scale };
}

function rescale(value: ScaledDecimal, scale: number): bigint {
  if (scale === value.scale) return value.units;
  return value.units * 10n ** BigInt(scale - value.scale);
}

function formatScaled(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * Exact sum of decimal strings. The result's scale is the greatest input
 * scale, so summing 2-decimal eBay amounts yields a 2-decimal string.
 * `empty` is returned for an empty list.
 */
export function sumDecimals(values: readonly string[], empty = "0.00"): string {
  if (values.length === 0) return empty;
  const parsed = values.map(parseScaled);
  const scale = parsed.reduce((max, item) => Math.max(max, item.scale), 0);
  const total = parsed.reduce((acc, item) => acc + rescale(item, scale), 0n);
  return formatScaled(total, scale);
}

/** Exact `a - b` for decimal strings. */
export function subtractDecimals(a: string, b: string): string {
  const left = parseScaled(a);
  const right = parseScaled(b);
  const scale = Math.max(left.scale, right.scale);
  return formatScaled(rescale(left, scale) - rescale(right, scale), scale);
}

/**
 * EXACT `a / b`, or null when the quotient does not terminate within
 * {@link MAX_QUOTIENT_SCALE} decimal places.
 *
 * Returning null rather than rounding is the whole point: `unit_price` is the
 * only order field eBay does not report, and a silently rounded unit price
 * that no longer multiplies back to the provider's line cost is worse than an
 * absent one. The translator decides what to do with the null; this function
 * never guesses.
 */
export const MAX_QUOTIENT_SCALE = 6;

export function divideDecimals(a: string, b: string): string | null {
  const left = parseScaled(a);
  const right = parseScaled(b);
  if (right.units === 0n) return null;
  // Align both to a common scale so the ratio is a plain integer ratio.
  const scale = Math.max(left.scale, right.scale);
  let numerator = rescale(left, scale);
  const denominator = rescale(right, scale);
  const negative = numerator < 0n !== denominator < 0n;
  if (numerator < 0n) numerator = -numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  for (let quotientScale = 0; quotientScale <= MAX_QUOTIENT_SCALE; quotientScale++) {
    const scaled = numerator * 10n ** BigInt(quotientScale);
    if (scaled % absDenominator === 0n) {
      const units = scaled / absDenominator;
      return formatScaled(negative ? -units : units, quotientScale);
    }
  }
  return null;
}

/** Magnitude of a decimal string (`"-12.50"` → `"12.50"`). */
export function absDecimal(value: string): string {
  return value.startsWith("-") ? value.slice(1) : value;
}

/** True when the decimal string represents exactly zero. */
export function isZeroDecimal(value: string): boolean {
  const { units } = parseScaled(value);
  return units === 0n;
}
