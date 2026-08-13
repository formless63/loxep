/**
 * Exact decimal-string arithmetic for expense amounts.
 *
 * Money is PostgreSQL `numeric(20,6)` and is never a JavaScript `number`
 * (implementation contract). Every amount crossing this package's API is a
 * DECIMAL STRING, and the arithmetic that happens in TypeScript uses scaled
 * `BigInt`.
 *
 * ## Why this is re-declared rather than imported
 *
 * `@loxep/commerce` exports these primitives and `@loxep/inventory` imports
 * them, because inventory already depends on commerce for the order shapes its
 * allocations allocate against. `@loxep/accounting` has no such dependency and
 * should not acquire one: expenses do not read orders, order lines, fees, or
 * refunds, and adding `@loxep/commerce` to this manifest to reach six pure
 * functions would create a package edge that exists only for arithmetic. This
 * is the same trade `@loxep/inventory/src/sql.ts` records for the SQL literal
 * helpers — re-declared rather than reaching into another domain package's
 * private surface.
 *
 * What is NOT here, deliberately: division, multiplication, and any rounding
 * distribution. Expenses need to add, subtract, and compare; an expense split
 * is a set of amounts the operator typed, never a computed pro rata. When a
 * posting engine needs largest-remainder distribution, it can have one — and
 * that will be the moment to decide where the shared implementation lives.
 */
import { AccountingValidationError } from "./errors.ts";

/** A plain decimal string: optional sign, digits, optional fraction. No exponent. */
export const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

/** `numeric(20,6)`. */
export const MONEY_SCALE = 6;

/** The canonical zero at that scale, as PostgreSQL echoes it back. */
export const ZERO = "0.000000";

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

interface Scaled {
  units: bigint;
  scale: number;
}

function parseScaled(value: string): Scaled {
  if (!DECIMAL_STRING.test(value)) {
    throw new AccountingValidationError(
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
    throw new AccountingValidationError(
      "refusing to reduce a decimal's scale: that would round money",
    );
  }
  return value.units * 10n ** BigInt(scale - value.scale);
}

function format(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
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

/** Render at `numeric(20,6)`'s scale, exactly as PostgreSQL will echo it. */
export function toMoneyString(value: string): string {
  return format(toUnits(value), MONEY_SCALE);
}

/** Exact `a + b + …`, at money scale. */
export function sumDecimals(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) total += toUnits(value);
  return format(total, MONEY_SCALE);
}

/** Exact `a − b`, at money scale. */
export function subtractDecimals(a: string, b: string): string {
  return format(toUnits(a) - toUnits(b), MONEY_SCALE);
}

/** `-1 | 0 | 1`, comparing exactly rather than through `Number`. */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  const left = toUnits(a);
  const right = toUnits(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Exact `|value|`. */
export function absDecimal(value: string): string {
  const units = toUnits(value);
  return format(units < 0n ? -units : units, MONEY_SCALE);
}

/** Exact `-value`. */
export function negateDecimal(value: string): string {
  return format(-toUnits(value), MONEY_SCALE);
}

/**
 * `value × multiplier` at money scale, rounding half away from zero.
 *
 * This is the one place in the package that rounds, and it exists because a
 * posting-rule line is `amount_source × amount_multiplier`: a `-1` multiplier
 * (how a credit line is expressed) is exact, and a `0.5` multiplier on an odd
 * number of micro-units genuinely is not. Refusing the inexact case would make
 * a half-split rule unauthorable; rounding silently in several places would
 * make two reports disagree. So it rounds, once, here, the same way PostgreSQL
 * `numeric` rounds — and the rule engine's `remainder` line is what absorbs the
 * residue so a rounded template still balances to the micro-unit.
 */
export function multiplyDecimals(value: string, multiplier: string): string {
  const scaled = toUnits(value) * toUnits(multiplier);
  const divisor = 10n ** BigInt(MONEY_SCALE);
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return format(negative ? -rounded : rounded, MONEY_SCALE);
}

/**
 * `total × part ÷ whole`, at money scale, as a LARGEST-REMAINDER share.
 *
 * The second — and, deliberately, last — rounding function in this package, and
 * the one this file's own header predicted: *"When a posting engine needs
 * largest-remainder distribution, it can have one — and that will be the moment
 * to decide where the shared implementation lives."* That moment is COGS
 * posting, and the shared implementation lives here rather than being reached
 * for across a package edge, for the reason the header already gives: this
 * package does not depend on `@loxep/inventory` and must not acquire the
 * dependency to reach one function.
 *
 * It is the TWO-BUCKET case of `@loxep/inventory`'s `distributeByWeights`,
 * computed identically so that a basis this package posts and a basis
 * `profitability.ts` reports are the same number rather than two numbers that
 * usually agree. With weights `[part, whole − part]` that function's leftover
 * unit is zero or one and goes to the larger remainder with the earlier index
 * winning a tie — which is exactly `round(|total| × part ÷ whole)` rounded half
 * up on the magnitude, with the sign carried.
 *
 * A `part` at or beyond `whole` returns `total` unchanged, so the shares of a
 * fully consumed quantity sum to the whole EXACTLY and the asset it relieves
 * returns to zero rather than to a micro-unit of permanent residue.
 */
export function proRataShare(
  total: string,
  part: string,
  whole: string,
): string {
  const wholeUnits = toUnits(whole);
  const partUnits = toUnits(part);
  if (wholeUnits <= 0n) return ZERO;
  if (partUnits <= 0n) return ZERO;
  if (partUnits >= wholeUnits) return toMoneyString(total);

  const totalUnits = toUnits(total);
  const negative = totalUnits < 0n;
  const magnitude = negative ? -totalUnits : totalUnits;
  const numerator = magnitude * partUnits;
  const quotient = numerator / wholeUnits;
  const remainder = numerator % wholeUnits;
  const rounded = remainder * 2n >= wholeUnits ? quotient + 1n : quotient;
  return format(negative ? -rounded : rounded, MONEY_SCALE);
}

export function isZeroDecimal(value: string): boolean {
  return toUnits(value) === 0n;
}

export function isNegative(value: string): boolean {
  return toUnits(value) < 0n;
}
