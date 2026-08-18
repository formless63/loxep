import { queryOptions } from '@tanstack/react-query';
import {
  fetchExpense,
  fetchExpenseCategories,
  fetchExpenses,
  fetchExpenseTotals,
  fetchMissingReceipts,
  fetchUnallocatedExpenses
} from '@/server/expense-functions';
import type { ExpenseGroupingDto } from '@/server/expense-functions';
import {
  checkDraftInvoicePushStatus,
  listInvoiceNinjaConnections,
  searchCounterpartiesForBilling
} from '@/server/finance-billing-functions';
import { searchTradingPartners } from '@/server/trading-partner-functions';
import type { ExpenseStatus } from '@/features/finance/constants';

export interface ExpenseFilterParams {
  economicEntityId?: string | null;
  category?: string;
  statuses?: ExpenseStatus[];
  from?: string;
  to?: string;
  /** "Search receipt text" — see `fetchExpenses`'s own doc; distinct from every field filter above. */
  q?: string | null;
}

export const expensesQuery = (filter: ExpenseFilterParams) =>
  queryOptions({
    queryKey: ['finance', 'expenses', filter],
    queryFn: () => fetchExpenses({ data: filter })
  });

/**
 * `q`, when given, both filters `/finance/expenses`'s own list (via
 * `expensesQuery`) AND is forwarded to the detail fetch so a snippet can
 * render on arrival from a search — see `fetchExpense`'s own doc for why the
 * snippet is arrival-gated rather than always computed.
 */
export const expenseQuery = (id: string, q?: string | null) =>
  queryOptions({
    queryKey: ['finance', 'expense', id, q ?? null],
    queryFn: () => fetchExpense({ data: { id, q: q ?? null } })
  });

/** Distinct categories already used in this installation — see `fetchExpenseCategories`'s own doc; feeds the category combobox alongside `SUGGESTED_EXPENSE_CATEGORIES`. */
export const expenseCategoriesQuery = queryOptions({
  queryKey: ['finance', 'expense-categories'],
  queryFn: () => fetchExpenseCategories()
});

export const missingReceiptsQuery = queryOptions({
  queryKey: ['finance', 'missing-receipts'],
  queryFn: () => fetchMissingReceipts()
});

export const unallocatedExpensesQuery = queryOptions({
  queryKey: ['finance', 'unallocated-expenses'],
  queryFn: () => fetchUnallocatedExpenses()
});

// ---------------------------------------------------------------------------
// Totals (`/finance/overview`'s Spending band, loxep-8e2 item 5) — see
// `fetchExpenseTotals`'s own doc: one shipped aggregate, three groupings.
// ---------------------------------------------------------------------------

export interface ExpenseTotalsParams {
  grouping: ExpenseGroupingDto;
  economicEntityId?: string | null;
  from?: string;
  to?: string;
  category?: string;
  statuses?: ExpenseStatus[];
}

export const expenseTotalsQuery = (params: ExpenseTotalsParams) =>
  queryOptions({
    queryKey: ['finance', 'expense-totals', params],
    queryFn: () => fetchExpenseTotals({ data: params })
  });

// ---------------------------------------------------------------------------
// Invoice Ninja draft-invoice push (loxep-v5r.5)
// ---------------------------------------------------------------------------

export const invoiceNinjaConnectionsQuery = queryOptions({
  queryKey: ['finance', 'invoiceninja-connections'],
  queryFn: () => listInvoiceNinjaConnections()
});

export const counterpartyBillingSearchQuery = (query: string) =>
  queryOptions({
    queryKey: ['finance', 'counterparty-billing-search', query],
    queryFn: () => searchCounterpartiesForBilling({ data: { query } })
  });

// ---------------------------------------------------------------------------
// Trading partners: counterparties as expense payees (loxep-cd3.1, M1)
// ---------------------------------------------------------------------------

export const tradingPartnersSearchQuery = (params: {
  search: string;
  economicEntityId: string | null;
}) =>
  queryOptions({
    queryKey: ['finance', 'trading-partners', params.search, params.economicEntityId],
    queryFn: () =>
      searchTradingPartners({
        data: { search: params.search, economicEntityId: params.economicEntityId }
      })
  });

export const draftInvoicePushStatusQuery = (params: {
  counterpartyId: string | null;
  projectId: string | null;
}) =>
  queryOptions({
    queryKey: ['finance', 'draft-invoice-push-status', params.counterpartyId, params.projectId],
    queryFn: () =>
      params.counterpartyId === null
        ? Promise.resolve(null)
        : checkDraftInvoicePushStatus({
            data: { counterpartyId: params.counterpartyId, projectId: params.projectId }
          }),
    enabled: params.counterpartyId !== null
  });
