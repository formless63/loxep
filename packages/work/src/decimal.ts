/**
 * Exact decimal-string arithmetic for @loxep/work amounts.
 *
 * Money and quantities are both PostgreSQL `numeric(20,6)` and neither is
 * ever a JavaScript `number` (implementation contract). Every derived amount
 * this package computes — a time entry's billable value, a material use's
 * line total — is computed here in scaled `BigInt`, never floats, and
 * returned as a plain decimal string.
 *
 * `@loxep/inventory` has an equivalent module built over primitives it
 * imports from `@loxep/commerce`. `@loxep/work` declares no dependency on
 * either package (only `@loxep/db` and `zod`), so this is a small, deliberately
 * self-contained reimplementation of exactly what the rate-resolution and
 * material-use math need: exact multiplication, exact division by a small
 * integer (minutes / 60), and summation. It is not a general ledger-grade
 * decimal library and does not try to be.
 */
import { WorkValidationError } from "./errors.ts";

/** A plain decimal string: optional sign, digits, optional fractional part. No exponent notation. */
export const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

/** `numeric(20,6)`'s scale — the scale every money and quantity column in this schema shares. */
export const MONEY_SCALE = 6;

/** The canonical zero at `numeric(20,6)`'s scale, as PostgreSQL echoes it. */
export const ZERO = "0.000000";

export function isDecimalString(value: string): boolean {
  return DECIMAL_STRING.test(value);
}

interface Scaled {
  units: bigint;
  scale: number;
}

function parseScaled(value: string): Scaled {
  if (!DECIMAL_STRING.test(value)) {
    throw new WorkValidationError(
      `expected a plain decimal string (no exponent notation), got "${value}"`,
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

function rescale(value: Scaled, scale: number): bigint {
  if (scale === value.scale) return value.units;
  if (scale < value.scale) {
    throw new WorkValidationError(
      "refusing to reduce a decimal's scale: that would round money",
    );
  }
  return value.units * 10n ** BigInt(scale - value.scale);
}

function format(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Scale a decimal string to `numeric(20,6)` units, exactly. */
export function toUnits(value: string, scale = MONEY_SCALE): bigint {
  return rescale(parseScaled(value), scale);
}

/** The inverse of {@link toUnits}. */
export function fromUnits(units: bigint, scale = MONEY_SCALE): string {
  return format(units, scale);
}

/** True when `value` is strictly negative. */
export function isNegativeDecimal(value: string): boolean {
  return parseScaled(value).units < 0n;
}

/**
 * Exact `a * b`, rounded HALF-UP on the magnitude to `scale` digits (matching
 * PostgreSQL `numeric`'s rounding), plus a flag saying whether the product was
 * representable exactly at that scale.
 */
export function multiplyDecimals(
  a: string,
  b: string,
  scale = MONEY_SCALE,
): { value: string; exact: boolean } {
  const left = parseScaled(a);
  const right = parseScaled(b);
  const product = left.units * right.units;
  const productScale = left.scale + right.scale;
  if (productScale <= scale) {
    return {
      value: format(rescale({ units: product, scale: productScale }, scale), scale),
      exact: true,
    };
  }
  const divisor = 10n ** BigInt(productScale - scale);
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return {
    value: format(negative ? -rounded : rounded, scale),
    exact: remainder === 0n,
  };
}

/**
 * Exact `numerator / divisor` for a small non-negative integer divisor
 * (this package's only division: minutes / 60), rounded HALF-UP on the
 * magnitude to `scale` digits.
 */
export function divideByInteger(
  numerator: string,
  divisor: number,
  scale = MONEY_SCALE,
): { value: string; exact: boolean } {
  if (!Number.isInteger(divisor) || divisor <= 0) {
    throw new WorkValidationError("divisor must be a positive integer");
  }
  const parsed = parseScaled(numerator);
  const numeratorUnits = rescale(parsed, scale);
  const negative = numeratorUnits < 0n;
  const magnitude = negative ? -numeratorUnits : numeratorUnits;
  const divisorBig = BigInt(divisor);
  const quotient = magnitude / divisorBig;
  const remainder = magnitude % divisorBig;
  const rounded = remainder * 2n >= divisorBig ? quotient + 1n : quotient;
  return {
    value: format(negative ? -rounded : rounded, scale),
    exact: remainder === 0n,
  };
}

/** Exact sum of decimal strings, at `scale`. Empty input sums to {@link ZERO}. */
export function sumDecimals(
  values: readonly string[],
  scale = MONEY_SCALE,
): string {
  let total = 0n;
  for (const value of values) {
    total += toUnits(value, scale);
  }
  return format(total, scale);
}

/** Exact `a - b`, at `scale`. */
export function subtractDecimals(
  a: string,
  b: string,
  scale = MONEY_SCALE,
): string {
  return format(toUnits(a, scale) - toUnits(b, scale), scale);
}
