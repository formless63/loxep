/**
 * Client-side aggregation for DataTable summary/footer rows (loxep-egl E2).
 *
 * Every consumer here works over an already-fetched, UNPAGINATED result set
 * (the same "unbounded fetch, honest client-side work" exception Frontend
 * Standards documents for sort/filter — see book-trial-balance.tsx,
 * expenses-table, items-table (stock), and order-detail.tsx's fee subtotals).
 * This module adds nothing to the network; it only totals what the page
 * already has in memory.
 *
 * Decimal-safe by construction, mirroring
 * `features/finance/lib/line-item-derive.ts`: every persisted money/quantity
 * value is `numeric(20,6)`, so summation NEVER touches a JS `number` —
 * amounts are parsed to integer micro-unit (`10^-6`) `BigInt`s, summed as
 * exact integer arithmetic, and formatted back to a plain 6dp decimal
 * string. There is no rounding step (unlike `multiplyMicros`/`divideMicros`
 * in that module) because integer addition is already exact.
 *
 * **Never sum across currencies** — every grouped helper below groups by
 * caller-supplied key (typically currency) precisely so a mixed-currency
 * result set never collapses into one meaningless total. Group first, then
 * render one total per group.
 */

const DECIMAL_SCALE = 6;
const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/**
 * Parses a plain decimal string to an integer micro-unit `BigInt`, rounding
 * half-up if given more than 6 fractional digits. `null` for anything not a
 * plain decimal (including `''`, whitespace-only, `'NaN'`, `'1e5'`) — the
 * non-numeric guard every caller below relies on.
 */
function parseMicros(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (trimmed === '' || !DECIMAL_STRING_RE.test(trimmed)) return null;
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dotIndex = unsigned.indexOf('.');
  const wholeDigits = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fracDigits = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1);

  let magnitude: bigint;
  if (fracDigits.length <= DECIMAL_SCALE) {
    magnitude = BigInt(wholeDigits + fracDigits.padEnd(DECIMAL_SCALE, '0'));
  } else {
    const kept = fracDigits.slice(0, DECIMAL_SCALE);
    const roundUp = Number(fracDigits[DECIMAL_SCALE]) >= 5;
    magnitude = BigInt(wholeDigits + kept) + (roundUp ? 1n : 0n);
  }
  return negative ? -magnitude : magnitude;
}

/** The inverse of {@link parseMicros}. */
function formatMicros(micros: bigint): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  const digits = magnitude.toString().padStart(DECIMAL_SCALE + 1, '0');
  const whole = digits.slice(0, digits.length - DECIMAL_SCALE);
  const fraction = digits.slice(digits.length - DECIMAL_SCALE);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Sums a list of money/quantity decimal strings, exactly, at 6dp.
 *
 * - Empty input sums to `'0.000000'`.
 * - `null`/`undefined` entries are skipped — they contribute nothing, same
 *   as absent data anywhere else in the app.
 * - An entry that fails to parse as a plain decimal (the non-numeric guard —
 *   e.g. `''`, `'abc'`, `'1e5'`) is also skipped rather than throwing or
 *   poisoning the whole total; a single malformed row must not blank a
 *   totals row for every other row on the page.
 * - Mixed signs net correctly (a positive charge and a negative refund/
 *   discount sum to their true difference).
 */
export function sumMoney(values: readonly (string | null | undefined)[]): string {
  let total = 0n;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const micros = parseMicros(value);
    if (micros === null) continue;
    total += micros;
  }
  return formatMicros(total);
}

/**
 * Groups `rows` by `keyOf(row)` and sums `amountOf(row)` (via {@link
 * sumMoney}'s exact/skip rules) within each group. A row whose key is
 * `null`/`undefined` is excluded from every group — there is no group to
 * attribute it to (typically: a row with no currency). Iteration order of
 * the returned `Map` is first-seen-key order, so a caller can render groups
 * in a stable order without a separate sort.
 *
 * This is the one sanctioned path for a per-currency (or per-direction,
 * per-status, …) totals row — group by the dimension that must never be
 * summed across (currency, above all), then render one total per group.
 */
export function sumMoneyBy<T, K>(
  rows: readonly T[],
  amountOf: (row: T) => string | null | undefined,
  keyOf: (row: T) => K | null | undefined
): Map<K, string> {
  const buckets = new Map<K, (string | null | undefined)[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(amountOf(row));
    else buckets.set(key, [amountOf(row)]);
  }
  const totals = new Map<K, string>();
  for (const [key, amounts] of buckets) {
    totals.set(key, sumMoney(amounts));
  }
  return totals;
}

/**
 * Groups `rows` by `keyOf(row)` and counts rows per group. A row whose key
 * is `null`/`undefined` is excluded, matching {@link sumMoneyBy}'s rule —
 * "unattributed" is a state a caller should surface explicitly, not fold
 * into a group silently.
 */
export function countByKey<T, K>(
  rows: readonly T[],
  keyOf: (row: T) => K | null | undefined
): Map<K, number> {
  const counts = new Map<K, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
