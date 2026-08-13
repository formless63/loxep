/**
 * Exact decimal-string arithmetic for commerce amounts.
 *
 * Money is PostgreSQL `numeric(20,6)` and never a JavaScript `number`
 * (implementation contract). Every amount that crosses this package's API is a
 * DECIMAL STRING, and the rare places arithmetic happens in TypeScript use
 * scaled `BigInt`, never floats.
 *
 * Almost all commerce arithmetic happens in PostgreSQL, where `numeric` is
 * already exact — the read models sum in SQL and return strings. These helpers
 * exist for the three places that cannot:
 *
 * 1. normalizing provider-reported amounts to a canonical scale before
 *    persistence, so `"12.5"` and `"12.500000"` compare equal in tests;
 * 2. deriving a line's `discount_amount` / an order's rollups when a provider
 *    reports the operands but not the result;
 * 3. the profitability fixtures' hand-computed expectations.
 *
 * This is a deliberate re-declaration of the same discipline
 * `@loxep/integration-woo/money` applies at the provider boundary. It is NOT
 * imported from there: a domain package must not take a provider integration
 * as the source of its arithmetic (ADR-0009's boundary direction), and the
 * same reasoning is why `@loxep/market` re-declares eBay's filter shape rather
 * than importing it.
 */
import { CommerceValidationError } from "./errors.ts";

/** Plain decimal notation, optionally signed. No exponents, ever. */
export const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

/** The scale of `numeric(20,6)`; the canonical persisted scale. */
export const MONEY_SCALE = 6;

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

interface ScaledDecimal {
  units: bigint;
  scale: number;
}

function parseScaled(value: string): ScaledDecimal {
  if (!DECIMAL_STRING.test(value)) {
    throw new CommerceValidationError(
      "expected a plain decimal string (no exponent notation)",
    );
  }
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
  if (scale < value.scale) {
    throw new CommerceValidationError(
      "refusing to reduce a decimal's scale: that would round money",
    );
  }
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
 * Widen a decimal string to `numeric(20,6)`'s scale, which is exactly how
 * PostgreSQL will echo it back. Never narrows: a provider amount with more
 * than six decimal places is a data problem to surface, not to round away.
 */
export function toMoneyString(value: string): string {
  const parsed = parseScaled(value);
  if (parsed.scale > MONEY_SCALE) {
    throw new CommerceValidationError(
      `amount has scale ${parsed.scale}, which numeric(20,6) cannot store exactly`,
    );
  }
  return formatScaled(rescale(parsed, MONEY_SCALE), MONEY_SCALE);
}

/** Exact sum; the result carries the greatest input scale. */
export function sumDecimals(values: readonly string[], empty = "0"): string {
  if (values.length === 0) return empty;
  const parsed = values.map(parseScaled);
  const scale = parsed.reduce((max, item) => Math.max(max, item.scale), 0);
  const total = parsed.reduce((acc, item) => acc + rescale(item, scale), 0n);
  return formatScaled(total, scale);
}

/** Exact `a - b`. */
export function subtractDecimals(a: string, b: string): string {
  const left = parseScaled(a);
  const right = parseScaled(b);
  const scale = Math.max(left.scale, right.scale);
  return formatScaled(rescale(left, scale) - rescale(right, scale), scale);
}

/**
 * Exact `a * b`, widened to `numeric(20,6)` (design 4a/OQ7's manual sale
 * recorder: `unitPrice * quantity` for a line the operator typed in, where
 * both operands are exact and the product must be too — never a `Number`
 * multiplication).
 */
export function multiplyDecimals(a: string, b: string): string {
  const left = parseScaled(a);
  const right = parseScaled(b);
  const product = left.units * right.units;
  return toMoneyString(formatScaled(product, left.scale + right.scale));
}

/** Magnitude (`"-12.50"` → `"12.50"`). */
export function absDecimal(value: string): string {
  return value.startsWith("-") ? value.slice(1) : value;
}

/** True when the decimal string represents exactly zero. */
export function isZeroDecimal(value: string): boolean {
  return parseScaled(value).units === 0n;
}

/**
 * Divide two decimal strings at `scale` digits, reporting whether the result
 * is EXACT.
 *
 * The only division in this package, and it exists for one reason: a provider
 * that reports a line's subtotal and quantity but no usable unit price. The
 * caller is expected to check `exact` and to record that it used a rounded
 * value; nothing derived from an inexact quotient may ever be summed into a
 * total, because provider-reported totals are always available instead.
 *
 * Rounding is half-up on the magnitude (so `-x` rounds like `x`), matching
 * PostgreSQL's `numeric` rounding.
 */
export function divideDecimals(
  a: string,
  b: string,
  scale = MONEY_SCALE,
): { value: string; exact: boolean } {
  const left = parseScaled(a);
  const right = parseScaled(b);
  if (right.units === 0n) {
    throw new CommerceValidationError("division by zero");
  }
  // (left / 10^ls) / (right / 10^rs) * 10^scale, computed in integers.
  const numerator =
    left.units * 10n ** BigInt(right.scale + scale) * (right.units < 0n ? -1n : 1n);
  const denominator = (right.units < 0n ? -right.units : right.units) * 10n ** BigInt(left.scale);
  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const quotient = absNumerator / denominator;
  const remainder = absNumerator % denominator;
  const exact = remainder === 0n;
  // Half-up on the magnitude.
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return {
    value: formatScaled(negative ? -rounded : rounded, scale),
    exact,
  };
}

/** Exact numeric comparison independent of trailing zeros. */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  const left = parseScaled(a);
  const right = parseScaled(b);
  const scale = Math.max(left.scale, right.scale);
  const l = rescale(left, scale);
  const r = rescale(right, scale);
  return l < r ? -1 : l > r ? 1 : 0;
}
