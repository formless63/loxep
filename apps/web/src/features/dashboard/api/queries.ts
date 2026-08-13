import { queryOptions } from '@tanstack/react-query';
import {
  fetchDashboardFinancial,
  fetchDashboardMarketPulse,
  fetchDashboardMoney,
  fetchDashboardOperations
} from '@/server/dashboard-functions';

/**
 * One query per dashboard band, so each streams into its own `<Suspense>`
 * boundary instead of waiting on the slowest read.
 *
 * Refetch cadence is set per band by what actually moves:
 *
 * ```text
 * money        30s  order ingestion runs on a 15-minute sync cadence
 * marketPulse  30s  matches /market/overview, whose reads this shares
 * operations   15s  the "is anything broken right now" band
 * financial    none a posted ledger does not change while you look at it
 * ```
 */
export const dashboardMoneyQuery = queryOptions({
  queryKey: ['dashboard', 'money'],
  queryFn: () => fetchDashboardMoney(),
  refetchInterval: 30_000
});

export const dashboardMarketPulseQuery = queryOptions({
  queryKey: ['dashboard', 'market-pulse'],
  queryFn: () => fetchDashboardMarketPulse(),
  refetchInterval: 30_000
});

export const dashboardOperationsQuery = queryOptions({
  queryKey: ['dashboard', 'operations'],
  queryFn: () => fetchDashboardOperations(),
  refetchInterval: 15_000
});

export const dashboardFinancialQuery = queryOptions({
  queryKey: ['dashboard', 'financial'],
  queryFn: () => fetchDashboardFinancial()
});
