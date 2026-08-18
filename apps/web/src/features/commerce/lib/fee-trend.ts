/**
 * Pure shaping for the `/commerce/overview` fee-trend chart (loxep-8e2 item
 * 3 — "did eBay's rate change, and what is promoted-listing spend costing
 * me?"). Operates on `fetchOrderFeeTrends`'s already-fetched, already-bounded
 * result (`order_fees.charged_at >= now() - 90 days`, `fee_direction =
 * 'seller_charge'` only — see `orders-functions.ts`'s own doc on that
 * handler) — this module adds no query of its own.
 *
 * FALLBACK, not a take-rate (PROVISIONAL): the bead's preferred shape is fees
 * as a fraction of order revenue per period, but the single bounded read this
 * bead allows (`order_fees` only) carries no revenue figure, and
 * `orderSummary`/`entityAttributionReport` (the report already on this route)
 * are all-time totals, not the same per-month buckets — combining them would
 * either need a second new query or a fabricated period alignment. Per the
 * bead's own stated fallback: "a fee-amount-over-time line broken out by
 * feeType is an acceptable fallback" — that is what this module builds.
 *
 * `order_fees.fee_type` is a provider-extensible TypeScript union with no
 * `CHECK` (`packages/db/src/schema/commerce.ts`'s `FEE_TYPES`, 8 real values
 * once `buyer_surcharge` is excluded by the `seller_charge`-only read) —
 * more distinct values than there are `--chart-N` tokens (5). Rather than
 * assign colors in first-seen-in-data order (unstable across reloads once a
 * new fee type appears) this module maps every `feeType` to one of five
 * FIXED, stably-ordered categories up front — `chart-1`..`chart-4` are the
 * four fee types an operator actually asks after by name (final value,
 * insertion, promoted listing, payment processing), and every remaining
 * `feeType` (regulatory/operating, international, shipping label passthrough,
 * the schema's own `other`, and a stray `buyer_surcharge` row if one ever
 * reaches this direction) folds into a fifth `other` bucket on `chart-5`.
 * The mapping never reassigns a color based on what happens to be present in
 * a given 90-day window.
 */
import { sumMoneyBy } from '@/lib/aggregate';

export const FEE_TREND_CATEGORIES = [
  'marketplace_final_value',
  'marketplace_insertion',
  'promoted_listing_ad',
  'payment_processing',
  'other'
] as const;
export type FeeTrendCategory = (typeof FEE_TREND_CATEGORIES)[number];

const CATEGORY_LABELS = {
  marketplace_final_value: 'Final value fee',
  marketplace_insertion: 'Insertion fee',
  promoted_listing_ad: 'Promoted listing ad',
  payment_processing: 'Payment processing',
  other: 'Other fees'
} satisfies Record<FeeTrendCategory, string>;

export function feeTrendCategoryLabel(category: FeeTrendCategory): string {
  return CATEGORY_LABELS[category];
}

function categorize(feeType: string): FeeTrendCategory {
  switch (feeType) {
    case 'marketplace_final_value':
    case 'marketplace_insertion':
    case 'promoted_listing_ad':
    case 'payment_processing':
      return feeType;
    default:
      return 'other';
  }
}

export interface FeeTrendInputRow {
  feeType: string;
  currency: string;
  amount: string;
  chargedAt: string;
}

export type FeeTrendPeriodPoint = { period: string } & Record<FeeTrendCategory, number>;

export interface FeeTrendShapeResult {
  /** The single currency charted, or `null` when there is no data at all. */
  currency: string | null;
  points: FeeTrendPeriodPoint[];
  /**
   * Row count excluded because it was NOT in `currency` — `sumMoneyBy`'s own
   * "never sum across currencies" rule applied a level up: rather than fold
   * a second currency's fees into the same chart (a fabricated total) or
   * silently drop them, the count is surfaced so the chart's caller can
   * disclose it.
   */
  excludedCurrencyRowCount: number;
}

function periodOf(chargedAtIso: string): string {
  return chargedAtIso.slice(0, 7); // 'YYYY-MM-DDTHH:...' -> 'YYYY-MM'
}

/**
 * `Number(decimalString)` below feeds ONLY the chart's Y axis/line height —
 * every summed bucket is computed first via `sumMoneyBy`'s exact BigInt-micro
 * arithmetic, and only the already-summed result is converted, matching
 * Frontend Standards' "Standard formats" `Number(decimalString)`-for-a-
 * chart-axis exception.
 */
export function shapeFeeTrendByPeriod(rows: readonly FeeTrendInputRow[]): FeeTrendShapeResult {
  if (rows.length === 0) {
    return { currency: null, points: [], excludedCurrencyRowCount: 0 };
  }

  const rowCountByCurrency = new Map<string, number>();
  for (const row of rows) {
    rowCountByCurrency.set(row.currency, (rowCountByCurrency.get(row.currency) ?? 0) + 1);
  }
  // Most-represented currency wins the chart, ties broken by first-seen order
  // (`Map` iteration order) for determinism.
  let currency = rows[0]!.currency;
  let bestCount = 0;
  for (const [candidate, count] of rowCountByCurrency) {
    if (count > bestCount) {
      currency = candidate;
      bestCount = count;
    }
  }

  const includedRows = rows.filter((row) => row.currency === currency);
  const excludedCurrencyRowCount = rows.length - includedRows.length;

  const bucketed = sumMoneyBy(
    includedRows,
    (row) => row.amount,
    (row) => `${periodOf(row.chargedAt)}::${categorize(row.feeType)}`
  );

  const periods = [...new Set(includedRows.map((row) => periodOf(row.chargedAt)))].sort();
  const points: FeeTrendPeriodPoint[] = periods.map((period) => {
    const point = { period } as FeeTrendPeriodPoint;
    for (const category of FEE_TREND_CATEGORIES) {
      const total = bucketed.get(`${period}::${category}`) ?? '0.000000';
      point[category] = Number(total);
    }
    return point;
  });

  return { currency, points, excludedCurrencyRowCount };
}
