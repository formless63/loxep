import { queryOptions } from '@tanstack/react-query';
import {
  fetchContainerHostRegistration,
  fetchDiscoveredFleetResources,
  fetchDnsConnectionOptions,
  fetchDockhandConnectionOptions,
  fetchDockhandHostView,
  fetchHostingTarget,
  fetchHostingTargetOptions,
  fetchHostingTargets,
  fetchInfrastructureOverview,
  fetchIpAliases,
  fetchMailConnectionOptions,
  fetchManagedDomain,
  fetchManagedDomains,
  fetchPangolinConnectionOptions,
  fetchReconcileRun,
  fetchReconcileRuns,
  fetchTermixHostSessions,
  fetchUnmatchedTailscaleDevices
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

/** The fleet LIST page's opt-in unmatched-devices candidates panel (loxep-50t §4). */
export const unmatchedTailscaleDevicesQuery = queryOptions({
  queryKey: ['infrastructure', 'fleet', 'unmatched-tailscale-devices'],
  queryFn: () => fetchUnmatchedTailscaleDevices()
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

/**
 * The Termix per-session panel's live, request-scoped read (loxep-4ah,
 * owner-approved). Same "not suspense-preloaded, `null` is a valid answer"
 * discipline as {@link dockhandHostViewQuery} — enabled only once the caller
 * knows a termix/host link exists, never persisted.
 */
export const termixHostSessionsQuery = (hostingTargetId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'fleet', hostingTargetId, 'termix-host-sessions'],
    queryFn: () => fetchTermixHostSessions({ data: { hostingTargetId } })
  });

/** Dockhand connections for the "register in Dockhand" section's connection picker (loxep-hb7 Milestone C). */
export const dockhandConnectionOptionsQuery = queryOptions({
  queryKey: ['infrastructure', 'connection-options', 'dockhand'],
  queryFn: () => fetchDockhandConnectionOptions()
});

/** The fleet-detail "Container host registration" panel's read model (loxep-hb7 Milestone C). */
export const containerHostRegistrationQuery = (hostingTargetId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'fleet', hostingTargetId, 'container-host-registration'],
    queryFn: () => fetchContainerHostRegistration({ data: { hostingTargetId } })
  });

/** Pangolin connections for the "link a proxy connection" control's picker (Pangolin chain design M2, loxep-acj.2). */
export const pangolinConnectionOptionsQuery = queryOptions({
  queryKey: ['infrastructure', 'connection-options', 'pangolin'],
  queryFn: () => fetchPangolinConnectionOptions()
});

/** Named dynamic-IP aliases (Pangolin chain design M5, loxep-acj.5). */
export const ipAliasesQuery = queryOptions({
  queryKey: ['infrastructure', 'ip-aliases'],
  queryFn: () => fetchIpAliases()
});
