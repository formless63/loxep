import { queryOptions } from '@tanstack/react-query';
import {
  fetchExpense,
  fetchExpenses,
  fetchMissingReceipts,
  fetchUnallocatedExpenses
} from '@/server/expense-functions';
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
