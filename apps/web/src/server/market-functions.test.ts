/**
 * Unit tests for `shapePriceTrends` in `market-functions.ts` (loxep-0g4 D4
 * items-table sparkline). `fetchMarketItems` itself needs a real DB/session
 * (`requireSession` via `@/server/admin`), so this exercises the pure
 * grouping/bounding helper it delegates to instead — same split as
 * `admin-functions.test.ts`'s `normalizeFleetBaseUrl`/`settingJsonSchema`.
 */
import { describe, expect, test } from 'bun:test';
import { PRICE_TREND_POINTS, shapePriceTrends } from './market-functions.ts';

const ITEM_A = '11111111-1111-1111-1111-111111111111';
const ITEM_B = '22222222-2222-2222-2222-222222222222';

function row(itemId: string, observedAt: string, price: string) {
  return { marketplace_item_id: itemId, observed_at: observedAt, price };
}

describe('shapePriceTrends', () => {
  test('groups rows by item id, preserving arrival order', () => {
    const rows = [
      row(ITEM_A, '2026-08-01T00:00:00.000Z', '10.00'),
      row(ITEM_B, '2026-08-01T00:00:00.000Z', '5.00'),
      row(ITEM_A, '2026-08-02T00:00:00.000Z', '11.00')
    ];
    const result = shapePriceTrends(rows, [ITEM_A, ITEM_B]);
    expect(result.get(ITEM_A)).toEqual([
      { observedAt: '2026-08-01T00:00:00.000Z', price: '10.00' },
      { observedAt: '2026-08-02T00:00:00.000Z', price: '11.00' }
    ]);
    expect(result.get(ITEM_B)).toEqual([{ observedAt: '2026-08-01T00:00:00.000Z', price: '5.00' }]);
  });

  test('every requested item id gets an entry, even with no observations', () => {
    const result = shapePriceTrends([], [ITEM_A, ITEM_B]);
    expect(result.get(ITEM_A)).toEqual([]);
    expect(result.get(ITEM_B)).toEqual([]);
  });

  test('ignores rows for item ids outside the requested page (defensive)', () => {
    const strangerId = '33333333-3333-3333-3333-333333333333';
    const result = shapePriceTrends(
      [row(strangerId, '2026-08-01T00:00:00.000Z', '1.00')],
      [ITEM_A]
    );
    expect(result.get(ITEM_A)).toEqual([]);
    expect(result.has(strangerId)).toBe(false);
  });

  test('bounds each item to maxPoints even if more rows arrive (defense in depth over the SQL LIMIT)', () => {
    const rows = Array.from({ length: PRICE_TREND_POINTS + 5 }, (_, i) =>
      row(ITEM_A, `2026-08-01T00:${String(i).padStart(2, '0')}:00.000Z`, String(i))
    );
    const result = shapePriceTrends(rows, [ITEM_A]);
    expect(result.get(ITEM_A)).toHaveLength(PRICE_TREND_POINTS);
    // Keeps the first PRICE_TREND_POINTS rows in arrival order (SQL already
    // orders oldest-first per item), not an arbitrary subset.
    expect(result.get(ITEM_A)?.[0]?.price).toBe('0');
  });

  test('respects an explicit maxPoints override', () => {
    const rows = [
      row(ITEM_A, '2026-08-01T00:00:00.000Z', '1.00'),
      row(ITEM_A, '2026-08-02T00:00:00.000Z', '2.00'),
      row(ITEM_A, '2026-08-03T00:00:00.000Z', '3.00')
    ];
    const result = shapePriceTrends(rows, [ITEM_A], 2);
    expect(result.get(ITEM_A)).toHaveLength(2);
  });
});
