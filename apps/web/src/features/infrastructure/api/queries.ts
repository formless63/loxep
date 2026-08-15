import { queryOptions } from '@tanstack/react-query';
import {
  fetchDiscoveredFleetResources,
  fetchDnsConnectionOptions,
  fetchDockhandHostView,
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

/** The operator-confirmed attach picker's candidate list (loxep-y64 slice 3), scoped to one provider. */
export const discoveredFleetResourcesQuery = (provider: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'discovered-fleet-resources', provider],
    queryFn: () => fetchDiscoveredFleetResources({ data: { provider } })
  });

/**
 * The Dockhand containers/stacks panel's live, request-scoped read
 * (loxep-hb7 Milestone B). Not suspense-preloaded in the fleet-detail
 * route's own loader — it is enabled only once the caller knows a dockhand
 * link exists, and its `null` result (no link) is a valid, expected answer
 * rather than a loading error.
 */
export const dockhandHostViewQuery = (hostingTargetId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'fleet', hostingTargetId, 'dockhand-host-view'],
    queryFn: () => fetchDockhandHostView({ data: { hostingTargetId } })
  });
