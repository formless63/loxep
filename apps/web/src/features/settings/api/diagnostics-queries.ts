import { queryOptions } from '@tanstack/react-query';
import { fetchJobDiagnostics, fetchJobStats } from '@/server/diagnostics-functions';

export const jobStatsQuery = queryOptions({
  queryKey: ['settings', 'diagnostics', 'job-stats'],
  queryFn: () => fetchJobStats()
});

export const jobDiagnosticsQuery = queryOptions({
  queryKey: ['settings', 'diagnostics', 'jobs'],
  queryFn: () => fetchJobDiagnostics()
});
