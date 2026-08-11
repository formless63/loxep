/**
 * Decimal-string discipline for the WooCommerce boundary.
 *
 * Money is PostgreSQL `numeric` and never a JavaScript `number` (implementation
 * contract; Commerce Schema Design uses `numeric(20,6)` throughout). Every
 * amount this package exports is therefore a DECIMAL STRING, and the two
 * places arithmetic is unavoidable use scaled `BigInt`, never floats.
 *
 * Where arithmetic is unavoidable, and why:
 *
 * 1. `orders.subtotal_amount` — WooCommerce reports NO order-level subtotal.
 *    It reports `total`, `total_tax`, `shipping_total`, `shipping_tax`,
 *    `cart_tax`, `discount_total`, `discount_tax`, and per-line `subtotal`.
 *    The design's `subtotal_amount` is `not null`, so the adapter sums the
 *    line subtotals exactly.
 * 2. `order_lines.discount_amount` — Woo reports line `subtotal` (pre-discount)
 *    and line `total` (post-discount) but not the difference.
 *
 * Both are exact decimal operations on provider-reported decimal strings, not
 * estimates, and both are flagged as derived on the exported types.
 *
 * The one provider field that is NOT a decimal string is
 * `line_items[].price`, which WooCommerce serializes as a JSON **number**
 * (verified live against WooCommerce 10.9.3 — `"price": 179.99` while every
 * sibling money field is `"179.99"`). {@link decimalFromNumber} converts it
 * through JavaScript's shortest-round-trip formatting, which recovers the
 * original JSON literal for any realistic money value, and returns `null`
 * rather than guessing for anything that formats to exponential notation.
 */

export const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

/**
 * Provider decimal string, passed through VERBATIM (trailing zeros and all —
 * scale is provider evidence). Returns null for anything not decimal-shaped,
 * including `""`, which WooCommerce uses for "no value".
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
 * scale, so summing 2-decimal Woo amounts yields a 2-decimal string. Non-
 * decimal inputs are a programming error and are ignored by the caller before
 * reaching here; `empty` is returned for an empty list.
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

/** Magnitude of a decimal string (`"-12.50"` → `"12.50"`). */
export function absDecimal(value: string): string {
  return value.startsWith("-") ? value.slice(1) : value;
}

/** True when the decimal string represents exactly zero. */
export function isZeroDecimal(value: string): boolean {
  const { units } = parseScaled(value);
  return units === 0n;
}
