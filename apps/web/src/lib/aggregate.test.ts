import { describe, expect, test } from 'bun:test';
import { countByKey, sumMoney, sumMoneyBy } from './aggregate';

describe('sumMoney', () => {
  test('empty input sums to zero at 6dp', () => {
    expect(sumMoney([])).toBe('0.000000');
  });

  test('sums exact decimals precisely', () => {
    expect(sumMoney(['10', '5.5', '0.25'])).toBe('15.750000');
  });

  test('skips null and undefined entries', () => {
    expect(sumMoney(['10', null, undefined, '5'])).toBe('15.000000');
    expect(sumMoney([null, undefined])).toBe('0.000000');
  });

  test('nets mixed signs correctly (a refund/discount against a charge)', () => {
    expect(sumMoney(['100', '-30', '-20'])).toBe('50.000000');
    expect(sumMoney(['-10', '-5'])).toBe('-15.000000');
  });

  test('is exact at 6dp — no floating-point drift', () => {
    // 0.1 + 0.2 famously != 0.3 in IEEE754; this must be exact here.
    expect(sumMoney(['0.1', '0.2'])).toBe('0.300000');
    expect(sumMoney(['0.000001', '0.000002'])).toBe('0.000003');
    // A sum that would lose precision if routed through JS `number`.
    expect(sumMoney(['99999999999.999999', '0.000001'])).toBe('100000000000.000000');
  });

  test('non-numeric guard: skips unparseable entries rather than throwing or poisoning the total', () => {
    expect(sumMoney(['10', 'abc', '5'])).toBe('15.000000');
    expect(sumMoney(['10', '', '5'])).toBe('15.000000');
    expect(sumMoney(['10', '1e5', '5'])).toBe('15.000000'); // exponential notation is not a plain decimal
    expect(sumMoney(['10', 'NaN', '5'])).toBe('15.000000');
    expect(sumMoney(['abc', 'def'])).toBe('0.000000');
  });

  test('rounds an over-precise input half-up at 6dp before summing', () => {
    expect(sumMoney(['0.0000005', '0'])).toBe('0.000001');
    expect(sumMoney(['0.0000004', '0'])).toBe('0.000000');
  });

  test('tolerates surrounding whitespace', () => {
    expect(sumMoney([' 10 ', '5'])).toBe('15.000000');
  });
});

interface Row {
  amount: string | null;
  currency: string | null;
}

describe('sumMoneyBy', () => {
  test('groups and sums by key, preserving first-seen key order', () => {
    const rows: Row[] = [
      { amount: '10', currency: 'USD' },
      { amount: '5', currency: 'EUR' },
      { amount: '2.5', currency: 'USD' }
    ];
    const totals = sumMoneyBy(
      rows,
      (r) => r.amount,
      (r) => r.currency
    );
    expect([...totals.entries()]).toEqual([
      ['USD', '12.500000'],
      ['EUR', '5.000000']
    ]);
  });

  test('empty input yields an empty map', () => {
    expect(
      sumMoneyBy<Row, string>(
        [],
        (r) => r.amount,
        (r) => r.currency
      ).size
    ).toBe(0);
  });

  test('excludes rows whose key is null or undefined — never a fabricated "unattributed" total', () => {
    const rows: Row[] = [
      { amount: '10', currency: 'USD' },
      { amount: '999', currency: null }
    ];
    const totals = sumMoneyBy(
      rows,
      (r) => r.amount,
      (r) => r.currency
    );
    expect([...totals.entries()]).toEqual([['USD', '10.000000']]);
  });

  test('never sums across currencies — mixed-currency input stays split', () => {
    const rows: Row[] = [
      { amount: '100', currency: 'USD' },
      { amount: '100', currency: 'GBP' }
    ];
    const totals = sumMoneyBy(
      rows,
      (r) => r.amount,
      (r) => r.currency
    );
    expect(totals.get('USD')).toBe('100.000000');
    expect(totals.get('GBP')).toBe('100.000000');
    expect(totals.size).toBe(2);
  });

  test('a null/non-numeric amount within a group is skipped, not fatal to the group', () => {
    const rows: Row[] = [
      { amount: '10', currency: 'USD' },
      { amount: null, currency: 'USD' },
      { amount: 'garbage', currency: 'USD' }
    ];
    const totals = sumMoneyBy(
      rows,
      (r) => r.amount,
      (r) => r.currency
    );
    expect(totals.get('USD')).toBe('10.000000');
  });

  test('mixed signs within a group net correctly', () => {
    const rows: Row[] = [
      { amount: '100', currency: 'USD' },
      { amount: '-40', currency: 'USD' }
    ];
    const totals = sumMoneyBy(
      rows,
      (r) => r.amount,
      (r) => r.currency
    );
    expect(totals.get('USD')).toBe('60.000000');
  });
});

describe('countByKey', () => {
  test('counts rows per key', () => {
    const rows: Row[] = [
      { amount: '10', currency: 'USD' },
      { amount: '5', currency: 'EUR' },
      { amount: '2.5', currency: 'USD' }
    ];
    const counts = countByKey(rows, (r) => r.currency);
    expect(counts.get('USD')).toBe(2);
    expect(counts.get('EUR')).toBe(1);
  });

  test('empty input yields an empty map', () => {
    expect(countByKey<Row, string>([], (r) => r.currency).size).toBe(0);
  });

  test('excludes rows whose key is null or undefined', () => {
    const rows: Row[] = [
      { amount: '10', currency: 'USD' },
      { amount: '5', currency: null }
    ];
    const counts = countByKey(rows, (r) => r.currency);
    expect(counts.get('USD')).toBe(1);
    expect(counts.has(null as unknown as string)).toBe(false);
    expect(counts.size).toBe(1);
  });
});
