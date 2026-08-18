/**
 * Unit tests for `shapeFeeTrendByPeriod` (loxep-8e2 item 3), following the
 * same pure-shaping-helper test pattern as
 * `apps/web/src/server/market-functions.test.ts`'s `shapePriceTrends`.
 */
import { describe, expect, test } from 'bun:test';
import { FEE_TREND_CATEGORIES, shapeFeeTrendByPeriod } from './fee-trend.ts';

function row(feeType: string, currency: string, amount: string, chargedAt: string) {
  return { feeType, currency, amount, chargedAt };
}

describe('shapeFeeTrendByPeriod', () => {
  test('empty input yields no currency and no points', () => {
    const result = shapeFeeTrendByPeriod([]);
    expect(result).toEqual({ currency: null, points: [], excludedCurrencyRowCount: 0 });
  });

  test('buckets by month and maps known fee types to their own category', () => {
    const rows = [
      row('marketplace_final_value', 'USD', '10.00', '2026-06-05T00:00:00.000Z'),
      row('marketplace_final_value', 'USD', '5.00', '2026-06-20T00:00:00.000Z'),
      row('marketplace_insertion', 'USD', '1.00', '2026-06-05T00:00:00.000Z'),
      row('promoted_listing_ad', 'USD', '3.50', '2026-07-01T00:00:00.000Z')
    ];
    const result = shapeFeeTrendByPeriod(rows);
    expect(result.currency).toBe('USD');
    expect(result.excludedCurrencyRowCount).toBe(0);
    expect(result.points).toEqual([
      {
        period: '2026-06',
        marketplace_final_value: 15,
        marketplace_insertion: 1,
        promoted_listing_ad: 0,
        payment_processing: 0,
        other: 0
      },
      {
        period: '2026-07',
        marketplace_final_value: 0,
        marketplace_insertion: 0,
        promoted_listing_ad: 3.5,
        payment_processing: 0,
        other: 0
      }
    ]);
  });

  test('folds unrecognized/long-tail fee types into the "other" category', () => {
    const rows = [
      row('marketplace_regulatory_operating', 'USD', '0.30', '2026-06-01T00:00:00.000Z'),
      row('international', 'USD', '2.00', '2026-06-01T00:00:00.000Z'),
      row('shipping_label_charge', 'USD', '4.00', '2026-06-01T00:00:00.000Z'),
      row('other', 'USD', '0.10', '2026-06-01T00:00:00.000Z')
    ];
    const result = shapeFeeTrendByPeriod(rows);
    expect(result.points).toEqual([
      {
        period: '2026-06',
        marketplace_final_value: 0,
        marketplace_insertion: 0,
        promoted_listing_ad: 0,
        payment_processing: 0,
        other: 6.4
      }
    ]);
  });

  test('the dominant currency wins the chart; the minority currency is counted, not blended in', () => {
    const rows = [
      row('marketplace_final_value', 'USD', '10.00', '2026-06-01T00:00:00.000Z'),
      row('marketplace_final_value', 'USD', '10.00', '2026-06-02T00:00:00.000Z'),
      row('marketplace_final_value', 'EUR', '9.00', '2026-06-01T00:00:00.000Z')
    ];
    const result = shapeFeeTrendByPeriod(rows);
    expect(result.currency).toBe('USD');
    expect(result.excludedCurrencyRowCount).toBe(1);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.marketplace_final_value).toBe(20);
  });

  test('every category key is always present, even at zero', () => {
    const result = shapeFeeTrendByPeriod([
      row('marketplace_final_value', 'USD', '1.00', '2026-06-01T00:00:00.000Z')
    ]);
    for (const category of FEE_TREND_CATEGORIES) {
      expect(result.points[0]).toHaveProperty(category);
    }
  });
});
