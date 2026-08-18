/**
 * Unit tests for `shapeMovementsTrend` (loxep-8e2, priority 1). The server
 * function it feeds needs a real DB/session, so this exercises the pure
 * bucketing helper directly — same split as `market-functions.test.ts`'s
 * `shapePriceTrends` tests.
 */
import { describe, expect, test } from 'bun:test';
import { shapeMovementsTrend } from './movement-trend.ts';
import type { InventoryMovementTrendRowDto } from '@/server/inventory-functions';

function row(
  movementKind: string,
  quantity: string,
  occurredAt: string
): InventoryMovementTrendRowDto {
  return { movementKind, quantity, occurredAt };
}

describe('shapeMovementsTrend', () => {
  test('buckets by calendar day and by trend group, summing magnitude exactly', () => {
    const rows = [
      row('receipt', '10.000000', '2026-08-01T09:00:00.000Z'),
      row('receipt', '5.500000', '2026-08-01T15:00:00.000Z'),
      row('depletion_sale', '-3.000000', '2026-08-01T18:00:00.000Z'),
      row('shrinkage', '-1.250000', '2026-08-02T08:00:00.000Z')
    ];
    const result = shapeMovementsTrend(rows);
    expect(result).toEqual([
      {
        day: '2026-08-01',
        received: '15.500000',
        sold: '3.000000',
        shrinkage: '0.000000',
        adjusted: '0.000000',
        reversed: '0.000000'
      },
      {
        day: '2026-08-02',
        received: '0.000000',
        sold: '0.000000',
        shrinkage: '1.250000',
        adjusted: '0.000000',
        reversed: '0.000000'
      }
    ]);
  });

  test('strips sign so an outbound kind sums as positive magnitude, not a negative series', () => {
    const rows = [row('disposal', '-4.000000', '2026-08-05T00:00:00.000Z')];
    const result = shapeMovementsTrend(rows);
    expect(result[0]?.shrinkage).toBe('4.000000');
  });

  test('groups adjustment_in/adjustment_out/found/transfer_out/consumption under "adjusted"', () => {
    const rows = [
      row('adjustment_in', '2.000000', '2026-08-03T00:00:00.000Z'),
      row('adjustment_out', '-1.000000', '2026-08-03T00:00:00.000Z'),
      row('found', '1.000000', '2026-08-03T00:00:00.000Z'),
      row('transfer_out', '-2.000000', '2026-08-03T00:00:00.000Z'),
      row('consumption', '-0.500000', '2026-08-03T00:00:00.000Z')
    ];
    const result = shapeMovementsTrend(rows);
    expect(result).toEqual([
      {
        day: '2026-08-03',
        received: '0.000000',
        sold: '0.000000',
        shrinkage: '0.000000',
        adjusted: '6.500000',
        reversed: '0.000000'
      }
    ]);
  });

  test('empty input returns an empty array', () => {
    expect(shapeMovementsTrend([])).toEqual([]);
  });

  test('sorts days ascending regardless of input order', () => {
    const rows = [
      row('receipt', '1.000000', '2026-08-10T00:00:00.000Z'),
      row('receipt', '1.000000', '2026-08-01T00:00:00.000Z'),
      row('receipt', '1.000000', '2026-08-05T00:00:00.000Z')
    ];
    const result = shapeMovementsTrend(rows);
    expect(result.map((bucket) => bucket.day)).toEqual(['2026-08-01', '2026-08-05', '2026-08-10']);
  });
});
