import { queryOptions } from '@tanstack/react-query';
import { fetchJobDiagnostics, fetchJobStats } from '@/server/diagnostics-functions';
import { fetchPendingProviderOperations } from '@/server/admin-functions';

export const jobStatsQuery = queryOptions({
  queryKey: ['settings', 'diagnostics', 'job-stats'],
  queryFn: () => fetchJobStats()
});

export const jobDiagnosticsQuery = queryOptions({
  queryKey: ['settings', 'diagnostics', 'jobs'],
  queryFn: () => fetchJobDiagnostics()
});

/** `provider_operations.status = 'pending'` worklist (loxep-rh0) — read-only, see `fetchPendingProviderOperations`'s own doc for why there is no adjudication verb. */
export const pendingProviderOperationsQuery = queryOptions({
  queryKey: ['settings', 'diagnostics', 'pending-provider-operations'],
  queryFn: () => fetchPendingProviderOperations()
});
