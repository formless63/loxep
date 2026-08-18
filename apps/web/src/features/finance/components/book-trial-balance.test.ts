/**
 * Unit tests for `accountTypeSubtotals` in `book-trial-balance.tsx`
 * (loxep-759 — trial balance grouping "for free," zero new query). Mirrors
 * `market-functions.test.ts`'s `shapePriceTrends` pattern: exercises the pure
 * grouping helper directly, no DB/session.
 */
import { describe, expect, test } from 'bun:test';
import { accountTypeSubtotals } from './book-trial-balance.tsx';
import type { TrialBalanceRowDto } from '@/server/books-functions';

function row(
  overrides: Partial<TrialBalanceRowDto> & { ledgerAccountId: string }
): TrialBalanceRowDto {
  return {
    code: '1000',
    name: 'Account',
    accountType: 'asset',
    accountSubtype: null,
    isContra: false,
    systemKey: null,
    balance: '0',
    debit: '0',
    credit: '0',
    lineCount: 0,
    ...overrides
  };
}

describe('accountTypeSubtotals', () => {
  test('sums balances per accountType, exactly (BigInt-safe, not JS float)', () => {
    const subtotals = accountTypeSubtotals([
      row({ ledgerAccountId: 'a1', accountType: 'asset', balance: '10.10' }),
      row({ ledgerAccountId: 'a2', accountType: 'asset', balance: '0.20' }),
      row({ ledgerAccountId: 'l1', accountType: 'liability', balance: '-5.30' })
    ]);

    expect(subtotals).toEqual([
      { accountType: 'asset', balance: '10.300000' },
      { accountType: 'liability', balance: '-5.300000' }
    ]);
  });

  test('orders groups in statement order (asset, liability, equity, revenue, expense) regardless of row order', () => {
    const subtotals = accountTypeSubtotals([
      row({ ledgerAccountId: 'e1', accountType: 'expense', balance: '1' }),
      row({ ledgerAccountId: 'r1', accountType: 'revenue', balance: '1' }),
      row({ ledgerAccountId: 'q1', accountType: 'equity', balance: '1' }),
      row({ ledgerAccountId: 'l1', accountType: 'liability', balance: '1' }),
      row({ ledgerAccountId: 'a1', accountType: 'asset', balance: '1' })
    ]);

    expect(subtotals.map((entry) => entry.accountType)).toEqual([
      'asset',
      'liability',
      'equity',
      'revenue',
      'expense'
    ]);
  });

  test('omits an accountType with no rows rather than showing a zero group', () => {
    const subtotals = accountTypeSubtotals([row({ ledgerAccountId: 'a1', accountType: 'asset' })]);

    expect(subtotals).toEqual([{ accountType: 'asset', balance: '0.000000' }]);
  });

  test('empty input yields an empty list', () => {
    expect(accountTypeSubtotals([])).toEqual([]);
  });
});
