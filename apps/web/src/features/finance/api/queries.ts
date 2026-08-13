import { queryOptions } from '@tanstack/react-query';
import {
  fetchExpense,
  fetchExpenses,
  fetchMissingReceipts,
  fetchUnallocatedExpenses
} from '@/server/expense-functions';
import type { ExpenseStatus } from '@/features/finance/constants';

export interface ExpenseFilterParams {
  economicEntityId?: string | null;
  category?: string;
  statuses?: ExpenseStatus[];
  from?: string;
  to?: string;
}

export const expensesQuery = (filter: ExpenseFilterParams) =>
  queryOptions({
    queryKey: ['finance', 'expenses', filter],
    queryFn: () => fetchExpenses({ data: filter })
  });

export const expenseQuery = (id: string) =>
  queryOptions({
    queryKey: ['finance', 'expense', id],
    queryFn: () => fetchExpense({ data: { id } })
  });

export const missingReceiptsQuery = queryOptions({
  queryKey: ['finance', 'missing-receipts'],
  queryFn: () => fetchMissingReceipts()
});

export const unallocatedExpensesQuery = queryOptions({
  queryKey: ['finance', 'unallocated-expenses'],
  queryFn: () => fetchUnallocatedExpenses()
});
