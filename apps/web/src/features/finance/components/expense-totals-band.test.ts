/**
 * Unit tests for the pure shaping helpers in `expense-totals-band.tsx`
 * (loxep-8e2, item 5 — expenses by month/category on `/finance/overview`).
 * Mirrors `market-functions.test.ts`'s `shapePriceTrends` pattern — no DB/
 * session, exercises grouping/labeling/bucketing directly.
 */
import { describe, expect, test } from 'bun:test';
import { groupByCurrency, monthLabel, topCategorySlices } from './expense-totals-band.tsx';
import type { ExpenseTotalRowDto } from '@/server/expense-functions';

function totalRow(
  overrides: Partial<ExpenseTotalRowDto> & { groupKey: string }
): ExpenseTotalRowDto {
  return {
    currency: 'USD',
    totalAmount: '0',
    totalTaxAmount: '0',
    expenseCount: 0,
    ...overrides
  };
}

describe('monthLabel', () => {
  test('formats a YYYY-MM groupKey as "MMM yyyy"', () => {
    expect(monthLabel('2026-01')).toBe('Jan 2026');
    expect(monthLabel('2026-12')).toBe('Dec 2026');
  });

  test('returns the raw groupKey unchanged when it does not parse as YYYY-MM', () => {
    expect(monthLabel('not-a-month')).toBe('not-a-month');
  });
});

describe('groupByCurrency', () => {
  test('buckets rows by currency, preserving first-seen order', () => {
    const groups = groupByCurrency([
      totalRow({ groupKey: '2026-01', currency: 'USD' }),
      totalRow({ groupKey: '2026-01', currency: 'EUR' }),
      totalRow({ groupKey: '2026-02', currency: 'USD' })
    ]);

    expect([...groups.keys()]).toEqual(['USD', 'EUR']);
    expect(groups.get('USD')).toHaveLength(2);
    expect(groups.get('EUR')).toHaveLength(1);
  });

  test('empty input yields an empty map', () => {
    expect(groupByCurrency([]).size).toBe(0);
  });
});

describe('topCategorySlices', () => {
  test('keeps every category as its own slice when four or fewer', () => {
    const slices = topCategorySlices([
      totalRow({ groupKey: 'Shipping', totalAmount: '30' }),
      totalRow({ groupKey: 'Supplies', totalAmount: '50' })
    ]);

    expect(slices).toEqual([
      { key: 'cat-0', label: 'Supplies', totalAmount: '50' },
      { key: 'cat-1', label: 'Shipping', totalAmount: '30' }
    ]);
  });

  test('sorted descending by magnitude, top 4 kept, remainder folded into an exact "Other" bucket', () => {
    const slices = topCategorySlices([
      totalRow({ groupKey: 'A', totalAmount: '10' }),
      totalRow({ groupKey: 'B', totalAmount: '50' }),
      totalRow({ groupKey: 'C', totalAmount: '30' }),
      totalRow({ groupKey: 'D', totalAmount: '20' }),
      totalRow({ groupKey: 'E', totalAmount: '5.10' }),
      totalRow({ groupKey: 'F', totalAmount: '0.05' })
    ]);

    expect(slices).toHaveLength(5);
    expect(slices.slice(0, 4).map((slice) => slice.label)).toEqual(['B', 'C', 'D', 'A']);
    // "Other" folds E + F exactly (5.10 + 0.05 = 5.15), never a JS float add.
    expect(slices[4]).toEqual({ key: 'cat-other', label: 'Other (2)', totalAmount: '5.150000' });
  });

  test('empty input yields no slices', () => {
    expect(topCategorySlices([])).toEqual([]);
  });
});
