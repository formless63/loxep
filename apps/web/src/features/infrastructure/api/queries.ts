import { queryOptions } from '@tanstack/react-query';
import {
  fetchDnsConnectionOptions,
  fetchHostingTarget,
  fetchHostingTargetOptions,
  fetchHostingTargets,
  fetchInfrastructureOverview,
  fetchMailConnectionOptions,
  fetchManagedDomain,
  fetchManagedDomains,
  fetchReconcileRun,
  fetchReconcileRuns
} from '@/server/infrastructure-functions';

export const infrastructureOverviewQuery = queryOptions({
  queryKey: ['infrastructure', 'overview'],
  queryFn: () => fetchInfrastructureOverview()
});

export const managedDomainsQuery = queryOptions({
  queryKey: ['infrastructure', 'domains'],
  queryFn: () => fetchManagedDomains()
});

export const managedDomainQuery = (name: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'domains', name],
    queryFn: () => fetchManagedDomain({ data: { name } })
  });

export const hostingTargetsQuery = queryOptions({
  queryKey: ['infrastructure', 'fleet'],
  queryFn: () => fetchHostingTargets()
});

export const hostingTargetQuery = (name: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'fleet', name],
    queryFn: () => fetchHostingTarget({ data: { name } })
  });

export const reconcileRunsQuery = queryOptions({
  queryKey: ['infrastructure', 'runs'],
  queryFn: () => fetchReconcileRuns()
});

export const reconcileRunQuery = (id: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'runs', id],
    queryFn: () => fetchReconcileRun({ data: { id } })
  });

export const dnsConnectionOptionsQuery = queryOptions({
  queryKey: ['infrastructure', 'connection-options', 'dns'],
  queryFn: () => fetchDnsConnectionOptions()
});

export const mailConnectionOptionsQuery = queryOptions({
  queryKey: ['infrastructure', 'connection-options', 'mail'],
  queryFn: () => fetchMailConnectionOptions()
});

export const hostingTargetOptionsQuery = queryOptions({
  queryKey: ['infrastructure', 'hosting-target-options'],
  queryFn: () => fetchHostingTargetOptions()
});
