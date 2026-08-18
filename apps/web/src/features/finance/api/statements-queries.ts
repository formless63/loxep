import { queryOptions } from '@tanstack/react-query';
import {
  fetchAccountActivity,
  fetchBalanceSheet,
  fetchIncomeStatement
} from '@/server/statements-functions';

export const incomeStatementQuery = (accountingBookId: string, from: string, to: string) =>
  queryOptions({
    queryKey: ['finance', 'statements', 'income', accountingBookId, from, to],
    queryFn: () => fetchIncomeStatement({ data: { accountingBookId, from, to } })
  });

export const balanceSheetQuery = (accountingBookId: string, asOf: string) =>
  queryOptions({
    queryKey: ['finance', 'statements', 'balance-sheet', accountingBookId, asOf],
    queryFn: () => fetchBalanceSheet({ data: { accountingBookId, asOf } })
  });

export const accountActivityQuery = (
  accountingBookId: string,
  ledgerAccountId: string,
  from?: string,
  to?: string
) =>
  queryOptions({
    queryKey: [
      'finance',
      'statements',
      'account-activity',
      accountingBookId,
      ledgerAccountId,
      from,
      to
    ],
    queryFn: () =>
      fetchAccountActivity({
        data: {
          accountingBookId,
          ledgerAccountId,
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to })
        }
      })
  });
