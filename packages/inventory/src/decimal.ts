/**
 * Exact decimal-string arithmetic for inventory amounts and quantities.
 *
 * Money and quantities are both PostgreSQL `numeric(20,6)` and neither is ever
 * a JavaScript `number` (implementation contract). Every amount that crosses
 * this package's API is a DECIMAL STRING, and the places arithmetic happens in
 * TypeScript use scaled `BigInt`, never floats.
 *
 * ## What is imported and what is added
 *
 * `@loxep/inventory` already depends on `@loxep/commerce` (order and line
 * shapes are the thing allocations allocate against), so the primitives
 * `@loxep/commerce` already exports are IMPORTED and re-exported here rather
 * than copied — a third private implementation of `sumDecimals` in this repo
 * would be one too many.
 *
 * What this module adds is what cost allocation and pro-rata need and commerce
 * had no use for: exact multiplication, negation, and the LARGEST-REMAINDER
 * distribution that both the lot cost engine and the profitability read model
 * are specified in terms of.
 *
 * The one thing deliberately not re-exported is division without an exactness
 * flag. Every quotient in this package either lands in a largest-remainder
 * distribution (which is exact by construction) or is a per-unit cost share
 * whose caller must decide what an inexact result means.
 */
import {
  DECIMAL_STRING,
  MONEY_SCALE,
  absDecimal,
  compareDecimals,
  divideDecimals,
  isDecimalString,
  isZeroDecimal,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
} from "@loxep/commerce";
import { InventoryValidationError } from "./errors.ts";

export {
  DECIMAL_STRING,
  MONEY_SCALE,
  absDecimal,
  compareDecimals,
  divideDecimals,
  isDecimalString,
  isZeroDecimal,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
};

/** The canonical zero at `numeric(20,6)`'s scale, as PostgreSQL echoes it. */
export const ZERO = "0.000000";

interface Scaled {
  units: bigint;
  scale: number;
}

function parseScaled(value: string): Scaled {
  if (!DECIMAL_STRING.test(value)) {
    throw new InventoryValidationError(
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
    throw new InventoryValidationError(
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

/** Exact `-value`. */
export function negateDecimal(value: string): string {
  const parsed = parseScaled(value);
  return format(-parsed.units, parsed.scale);
}

/**
 * Exact `a * b`, rounded HALF-UP on the magnitude to `scale` digits (so `-x`
 * rounds like `x`, matching PostgreSQL's `numeric` rounding), plus a flag
 * saying whether the product was representable exactly.
 *
 * Callers that must not lose a fraction of a cent check `exact` and fall back
 * to a largest-remainder distribution instead.
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
    return { value: format(rescale({ units: product, scale: productScale }, scale), scale), exact: true };
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

/** True when `value` is strictly negative. */
export function isNegative(value: string): boolean {
  return parseScaled(value).units < 0n;
}

/** `max(value, 0)` — the weight-clamping rule, stated once. */
export function clampNonNegative(value: string): string {
  return isNegative(value) ? ZERO : value;
}

/**
 * Distribute `total` across `weights` so the shares SUM TO `total` EXACTLY,
 * using largest-remainder rounding.
 *
 * This one function is the concrete form of two separate design commitments:
 *
 * ```text
 * lot cost allocation   "Rounding uses a largest-remainder distribution so
 *                        that the allocated shares sum to the landed cost
 *                        exactly, with no residual cent left over or invented."
 *
 * read-model pro rata   "pro rata by line_total ... with largest-remainder
 *                        rounding so the allocated shares sum to the original
 *                        amount exactly." (design open question 7)
 * ```
 *
 * Rules, all load-bearing:
 *
 * - **A zero weight receives zero, never an equal share.** The design is
 *   explicit: "Where a line has no `line_total` to weight by (a zero-value
 *   promotional line), it receives no share rather than an equal share, and the
 *   shortfall stays with the paying lines."
 * - **Negative weights are rejected**, not clamped here. A negative line total
 *   is a real thing that a caller must decide about (see
 *   {@link clampNonNegative}); silently treating it as a weight would hand a
 *   NEGATIVE share of a cost to one line and inflate everyone else's.
 * - **When every weight is zero the result is all zeros** and the entire total
 *   is returned as `unallocated`. Nothing is invented, and the caller can
 *   surface the gap — which is what the cost engine does before it refuses to
 *   mark a lot `final`.
 * - **The sign of `total` is carried on the magnitude**, so distributing
 *   `-0.03` across three equal weights gives three `-0.01` shares, exactly
 *   mirroring `+0.03`. A credit must not round differently from a charge.
 * - **Ties in the remainder go to the earlier index**, so the distribution is
 *   deterministic and a test can hand-compute it.
 */
export function distributeByWeights(
  total: string,
  weights: readonly string[],
  scale = MONEY_SCALE,
): { shares: string[]; unallocated: string } {
  const totalParsed = parseScaled(total);
  const totalUnits = rescale(totalParsed, scale);
  if (weights.length === 0) {
    return { shares: [], unallocated: format(totalUnits, scale) };
  }

  // Weights share one working scale so the ratio arithmetic stays integral.
  const parsedWeights = weights.map((weight) => {
    const parsed = parseScaled(weight);
    if (parsed.units < 0n) {
      throw new InventoryValidationError(
        "allocation weights must be non-negative",
      );
    }
    return parsed;
  });
  const weightScale = parsedWeights.reduce(
    (max, weight) => Math.max(max, weight.scale),
    0,
  );
  const weightUnits = parsedWeights.map((weight) => rescale(weight, weightScale));
  const weightTotal = weightUnits.reduce((sum, weight) => sum + weight, 0n);

  if (weightTotal === 0n) {
    return {
      shares: weights.map(() => format(0n, scale)),
      unallocated: format(totalUnits, scale),
    };
  }

  const negative = totalUnits < 0n;
  const magnitude = negative ? -totalUnits : totalUnits;

  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let assigned = 0n;
  for (const weight of weightUnits) {
    const numerator = magnitude * weight;
    const share = numerator / weightTotal;
    floors.push(share);
    remainders.push(numerator % weightTotal);
    assigned += share;
  }

  // Hand out the leftover units one at a time, largest remainder first,
  // earlier index winning a tie.
  let leftover = magnitude - assigned;
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .filter((entry) => entry.remainder > 0n)
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  for (const entry of order) {
    if (leftover <= 0n) break;
    floors[entry.index] = (floors[entry.index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  const shares = floors.map((share) =>
    format(negative ? -share : share, scale),
  );
  return { shares, unallocated: format(0n, scale) };
}
