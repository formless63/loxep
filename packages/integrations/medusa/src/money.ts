/**
 * Decimal-string discipline for the Medusa boundary.
 *
 * Money is PostgreSQL `numeric` and never a JavaScript `number`
 * (implementation contract; Commerce Schema Design uses `numeric(20,6)`
 * throughout). Every amount this package exports is therefore a DECIMAL
 * STRING.
 *
 * ## Medusa v2 money representation — verified, and a real behavior change
 * from v1
 *
 * The task that produced this module explicitly asked to verify Medusa's
 * money format rather than assume it, because **v1 and v2 disagree**:
 *
 * - Medusa v1 stored amounts as integers in the currency's smallest unit
 *   (cents): `$10.00` was `1000`.
 * - Medusa v2 stores and serializes amounts in the currency's MAJOR unit:
 *   `$10.00` is `10`. Verified via the v1→v2 migration guide
 *   (https://docs.medusajs.com/learn/introduction/from-v1-to-v2, fetched
 *   2026-08-11): "In Medusa v1, prices were stored in the smallest currency
 *   unit. For example, a price of $10.00 was stored as `1000` (cents). In
 *   Medusa v2, prices are stored in the major unit. For example, a price of
 *   $10.00 is stored as `10` (dollars)."
 *
 * Internally, v2 typed money fields as `BigNumberValue` — a union of
 * `BigNumberJS | number | string | IBigNumber` — and the `IBigNumber`
 * interface declares `toJSON(): number`
 * (https://github.com/medusajs/medusa/blob/develop/packages/core/types/src/totals/big-number.ts,
 * `develop` branch, fetched 2026-08-11). Standard `JSON.stringify` invokes
 * `toJSON()` when present, so every money field on an Admin API JSON
 * response — `total`, `subtotal`, `item_total`, a line item's `unit_price`,
 * a payment's `amount`, a refund's `amount`, a variant price's `amount` — is
 * a plain JSON **number** in the order's major currency unit, confirmed
 * directly on the HTTP-layer types
 * (https://github.com/medusajs/medusa/blob/develop/packages/core/types/src/http/order/common.ts,
 * same fetch: `BaseOrder`/`BaseOrderLineItem` type every total as `number`,
 * not `BigNumberValue`).
 *
 * **LIVE-CONFIRMED** against Medusa 2.18.0 on 2026-08-12 (loxep-xh9.4.1).
 * A €10.00 variant priced at `10` produced, on a real Admin API order
 * payload: `unit_price: 10`, `item.total: 10`, order `subtotal: 20`,
 * `total: 20`, `shipping_total: 10`, refund `amount: 5`, and variant prices
 * `[{currency_code:"eur",amount:10},{currency_code:"usd",amount:15}]` —
 * every one a plain JSON `number` (`typeof === "number"`), every one in the
 * MAJOR unit. Nothing came back as a minor-unit integer, a string, or an
 * object. (Medusa's `summary` does additionally carry `raw_*` twins shaped
 * `{value: "20", precision: 20}` — a string-valued decimal — but those live
 * only under `summary`, never on the money fields this module converts.)
 *
 * ## The conversion, precisely
 *
 * A Medusa money field arrives as a JS `number` already denominated in major
 * units (dollars, not cents). {@link decimalFromNumber} converts it to a
 * decimal string through JavaScript's shortest-round-trip formatting
 * (`String(value)`), which recovers the exact JSON literal for any
 * realistic money value and returns `null` rather than guessing for a value
 * that formats to exponential notation — the same technique
 * `@loxep/integration-woo`'s `decimalFromNumber` uses for the one float
 * field WooCommerce sends.
 *
 * **This module does deliberately NOT round to the currency's nominal
 * decimal-digit count.** Medusa's own currency-precision table is
 * documentation, not enforcement: `calculateTaxTotal` has a filed, unfixed
 * upstream defect where intermediate tax totals carry sub-cent precision
 * that is never rounded to the currency's scale
 * (https://github.com/medusajs/medusa/issues/14818, found via search, not
 * independently verified against a running backend). Rounding here would
 * silently discard whatever precision the provider actually reported —
 * exactly the kind of invented fact the design's "amounts are
 * provider-reported facts, not computed" rule forbids. {@link
 * decimalFromNumber} therefore passes through the exact value Medusa sent,
 * and {@link excessPrecisionDigits} is offered as a DIAGNOSTIC (not a
 * correction) for a caller that wants to flag when a reported amount has
 * more fractional digits than {@link medusaCurrencyDecimalDigits} expects.
 *
 * ## The currency exponent table
 *
 * {@link MEDUSA_CURRENCY_DECIMAL_DIGITS} is extracted verbatim from Medusa's
 * own `defaultCurrencies` table —
 * https://github.com/medusajs/medusa/blob/develop/packages/core/utils/src/defaults/currencies.ts
 * (`develop` branch, fetched 2026-08-11; 126 currencies) — which is exactly
 * what `@medusajs/framework/utils` seeds into a fresh installation's
 * `currency` table via
 * https://github.com/medusajs/medusa/blob/develop/packages/modules/currency/src/loaders/initial-data.ts.
 * Mirroring Medusa's OWN table (rather than an external ISO 4217 reference)
 * matters: this is the precision Medusa itself assumes when it computes and
 * rounds an order's totals, and it genuinely diverges from strict ISO 4217
 * in places — e.g. Medusa's table gives `IQD` (Iraqi Dinar) 0 decimal
 * digits, where ISO 4217 specifies 3. Loxep must interpret a Medusa-reported
 * number the way MEDUSA interpreted it, not the way an independent standard
 * would.
 */

export const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

/**
 * Provider decimal string, passed through VERBATIM (trailing zeros and all —
 * scale is provider evidence). Returns null for anything not decimal-shaped.
 * Medusa's Admin API does not normally send money as a string, but the
 * Pricing module's raw/rule-evaluation paths sometimes do, so this is kept
 * for robustness the way `@loxep/integration-woo`'s dual-path helper is.
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
 * path for Medusa money fields — see the module doc.
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
 * scale; `empty` is returned for an empty list.
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

/**
 * Medusa's own currency decimal-digit table (`defaultCurrencies`), keyed by
 * uppercase ISO 4217 code. Extracted verbatim from
 * https://github.com/medusajs/medusa/blob/develop/packages/core/utils/src/defaults/currencies.ts
 * — see the module doc for why this table, not an external ISO reference.
 */
export const MEDUSA_CURRENCY_DECIMAL_DIGITS: Readonly<Record<string, number>> = {
  AED: 2, AFN: 0, ALL: 0, AMD: 0, AOA: 2, ARS: 2,
  AUD: 2, AZN: 2, BAM: 2, BDT: 2, BGN: 2, BHD: 3,
  BIF: 0, BND: 2, BOB: 2, BRL: 2, BWP: 2, BYN: 2,
  BZD: 2, CAD: 2, CDF: 2, CHF: 2, CLP: 0, CNY: 2,
  COP: 0, CRC: 0, CVE: 2, CZK: 2, DJF: 0, DKK: 2,
  DOP: 2, DZD: 2, EEK: 2, EGP: 2, ERN: 2, ETB: 2,
  EUR: 2, GBP: 2, GEL: 2, GHS: 2, GMD: 2, GNF: 0,
  GTQ: 2, HKD: 2, HNL: 2, HRK: 2, HUF: 0, IDR: 0,
  ILS: 2, INR: 2, IQD: 0, IRR: 0, IRT: 0, ISK: 0,
  JMD: 2, JOD: 3, JPY: 0, KES: 2, KHR: 2, KMF: 0,
  KRW: 0, KWD: 3, KZT: 2, LBP: 0, LKR: 2, LTL: 2,
  LVL: 2, LYD: 3, MAD: 2, MDL: 2, MGA: 0, MKD: 2,
  MMK: 0, MNT: 0, MOP: 2, MUR: 0, MWK: 2, MXN: 2,
  MYR: 2, MZN: 2, NAD: 2, NGN: 2, NIO: 2, NOK: 2,
  NPR: 2, NZD: 2, OMR: 3, PAB: 2, PEN: 2, PHP: 2,
  PKR: 0, PLN: 2, PYG: 0, QAR: 2, RON: 2, RSD: 0,
  RUB: 2, RWF: 0, SAR: 2, SDG: 2, SEK: 2, SGD: 2,
  SOS: 0, SYP: 0, THB: 2, TJS: 2, TND: 3, TOP: 2,
  TRY: 2, TTD: 2, TWD: 2, TZS: 0, UAH: 2, UGX: 0,
  USD: 2, UYU: 2, UZS: 0, VEF: 2, VND: 0, XAF: 0,
  XOF: 0, XPF: 0, YER: 0, ZAR: 2, ZMK: 0, ZWL: 0,
};

/** Fallback used for a currency code absent from Medusa's own table. */
const DEFAULT_DECIMAL_DIGITS = 2;

/**
 * Medusa's own assumed decimal precision for `currencyCode` (uppercased),
 * or {@link DEFAULT_DECIMAL_DIGITS} for a code the table does not list —
 * most currencies use 2, so an unlisted code is far more likely to be a
 * typo or a currency added upstream after this table was extracted than a
 * genuine 0- or 3-decimal currency.
 */
export function medusaCurrencyDecimalDigits(currencyCode: string): number {
  const code = currencyCode.trim().toUpperCase();
  return MEDUSA_CURRENCY_DECIMAL_DIGITS[code] ?? DEFAULT_DECIMAL_DIGITS;
}

/**
 * How many MORE fractional digits `value` carries than `currencyCode`'s
 * nominal precision expects, or `0` when it carries no more (including when
 * it carries fewer, e.g. a whole-dollar `"10"` for USD). A positive result
 * is a diagnostic signal — see the module doc — not something this package
 * corrects.
 */
export function excessPrecisionDigits(
  value: string,
  currencyCode: string,
): number {
  const { scale } = parseScaled(value);
  const expected = medusaCurrencyDecimalDigits(currencyCode);
  return Math.max(0, scale - expected);
}

/** Uppercase and trim a Medusa currency code (`"usd"` → `"USD"`). */
export function normalizeMedusaCurrencyCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}
