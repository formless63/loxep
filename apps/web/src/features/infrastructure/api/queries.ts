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
  fetchMailboxTemplates,
  fetchManagedDomain,
  fetchManagedDomainOptions,
  fetchManagedDomains,
  fetchPangolinConnectionOptions,
  fetchReconcileRun,
  fetchReconcileRuns,
  fetchTermixHostSessions,
  fetchUnmatchedTailscaleDevices
} from '@/server/infrastructure-functions';
import {
  fetchProvisioningTemplate,
  fetchProvisioningTemplateRun,
  fetchProvisioningTemplates
} from '@/server/provisioning-functions';
import {
  fetchPangolinEstateOverview,
  fetchPangolinEstateResourceDetail
} from '@/server/pangolin-estate-functions';
import {
  fetchPurelymailAccountFacts,
  fetchPurelymailEstateDomains,
  fetchPurelymailEstateMailboxes,
  fetchPurelymailEstateRoutingRules
} from '@/server/purelymail-estate-functions';
import {
  fetchCloudflareEstateRecords,
  fetchCloudflareEstateZones
} from '@/server/cloudflare-estate-functions';
import { fetchTailscaleEstateDevices } from '@/server/tailscale-estate-functions';
import { fetchBeszelEstateHub, fetchBeszelEstateSystems } from '@/server/beszel-estate-functions';
import {
  fetchTermixEstateHosts,
  fetchTermixEstateSessions
} from '@/server/termix-estate-functions';
import {
  fetchDockhandEstateEnvironmentDetail,
  fetchDockhandEstateEnvironments
} from '@/server/dockhand-estate-functions';
import {
  fetchGatusEstateEndpointUptime,
  fetchGatusEstateEndpoints,
  fetchGatusEstateInstance
} from '@/server/gatus-estate-functions';

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

/** Read-only mailbox templates (name + entries) — the mail panel's "Templates" view (loxep-4xo). */
export const mailboxTemplatesQuery = queryOptions({
  queryKey: ['infrastructure', 'mailbox-templates'],
  queryFn: () => fetchMailboxTemplates()
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

/** Every managed domain, name only — the estate browser's (loxep-pq2) adopt-dialog domain picker. */
export const managedDomainOptionsQuery = queryOptions({
  queryKey: ['infrastructure', 'domain-options'],
  queryFn: () => fetchManagedDomainOptions()
});

/**
 * The Pangolin estate browser's (loxep-pq2) whole-connection LIVE read —
 * sites, resources (cross-referenced against Loxep's own declared
 * `proxy_resources`), and org domains. Not suspense-preloaded with a long
 * `staleTime`: same "live, request-scoped, never persisted" discipline
 * {@link dockhandHostViewQuery} documents, so a refetch always shows the
 * CURRENT provider state, never a stale cache.
 */
export const pangolinEstateOverviewQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'pangolin-estate', connectionId],
    queryFn: () => fetchPangolinEstateOverview({ data: { connectionId } })
  });

/**
 * One resource's live `listTargets`/`listRules` — fetched only when its row
 * is expanded (see `pangolin-estate-functions.ts`'s own rate-budget doc).
 * The caller enables this per-row, never eagerly.
 */
export const pangolinEstateResourceDetailQuery = (connectionId: string, resourceId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'pangolin-estate', connectionId, 'resource', resourceId],
    queryFn: () => fetchPangolinEstateResourceDetail({ data: { connectionId, resourceId } })
  });

/**
 * The Purelymail estate browser's (loxep-47o.3) three sections — Domains,
 * Mailboxes, Routing rules — each its OWN query (Rule P4: each section
 * stamps its own clock), together the fixed three-call overview (Rule P7).
 * Same "live, never a long `staleTime`" discipline as
 * {@link pangolinEstateOverviewQuery}.
 */
export const purelymailEstateDomainsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'purelymail-estate', connectionId, 'domains'],
    queryFn: () => fetchPurelymailEstateDomains({ data: { connectionId } })
  });

export const purelymailEstateMailboxesQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'purelymail-estate', connectionId, 'mailboxes'],
    queryFn: () => fetchPurelymailEstateMailboxes({ data: { connectionId } })
  });

export const purelymailEstateRoutingRulesQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'purelymail-estate', connectionId, 'routing-rules'],
    queryFn: () => fetchPurelymailEstateRoutingRules({ data: { connectionId } })
  });

/**
 * Account facts (credit, ownership code) — a drill-in, not part of the
 * overview (Rule P7's three-call budget). The caller sets `enabled` on
 * explicit header expand, never eagerly.
 */
export const purelymailAccountFactsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'purelymail-estate', connectionId, 'account'],
    queryFn: () => fetchPurelymailAccountFacts({ data: { connectionId } })
  });

/**
 * The Cloudflare estate browser's (loxep-47o.2) zones overview — one
 * `listZones` call per page, `maxPages` growing by one per operator "Load
 * more" click (Rule P8; `maxPages` is IN the query key because each page
 * count is a genuinely different read, never served from a smaller page's
 * cache). Same live/never-cached discipline as every other estate query.
 */
export const cloudflareEstateZonesQuery = (connectionId: string, maxPages: number) =>
  queryOptions({
    queryKey: ['infrastructure', 'cloudflare-estate', connectionId, 'zones', maxPages],
    queryFn: () => fetchCloudflareEstateZones({ data: { connectionId, maxPages } })
  });

/**
 * One zone's live DNS records — the per-zone drill-in (Rule P6), fetched
 * only once an operator expands that zone. `externalZoneId` and `maxPages`
 * are both in the query key: switching zones or clicking "Load more" are
 * each a genuinely different read.
 */
export const cloudflareEstateRecordsQuery = (
  connectionId: string,
  externalZoneId: string,
  zoneName: string,
  maxPages: number
) =>
  queryOptions({
    queryKey: [
      'infrastructure',
      'cloudflare-estate',
      connectionId,
      'records',
      externalZoneId,
      maxPages
    ],
    queryFn: () =>
      fetchCloudflareEstateRecords({ data: { connectionId, externalZoneId, zoneName, maxPages } })
  });

/**
 * The Dockhand estate browser's (loxep-47o.4, read-only) Environments
 * overview — instance-wide, one `listHosts` call. Same live/never-cached
 * discipline as every other estate query.
 */
export const dockhandEstateEnvironmentsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'dockhand-estate', connectionId, 'environments'],
    queryFn: () => fetchDockhandEstateEnvironments({ data: { connectionId } })
  });

/**
 * One environment's live containers + stacks — the per-environment drill-in
 * (Rule P6), fetched only once an operator expands that row. Deliberately
 * NOT `dockhandHostViewQuery` (that one is keyed on `hostingTargetId` and
 * mounted only for a LINKED host) — this estate drill-in reads by
 * `externalHostId` directly so it also works for an unmatched environment.
 */
export const dockhandEstateEnvironmentDetailQuery = (
  connectionId: string,
  externalHostId: string
) =>
  queryOptions({
    queryKey: ['infrastructure', 'dockhand-estate', connectionId, 'environment', externalHostId],
    queryFn: () => fetchDockhandEstateEnvironmentDetail({ data: { connectionId, externalHostId } })
  });

/**
 * The Gatus estate browser's (loxep-47o.5) Instance section —
 * `probeConfig()` + `health()`, both unauthenticated. Same live/never-cached
 * discipline as every other estate query.
 */
export const gatusEstateInstanceQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'gatus-estate', connectionId, 'instance'],
    queryFn: () => fetchGatusEstateInstance({ data: { connectionId } })
  });

/**
 * The Gatus estate browser's Endpoints section — `listEndpointStatuses()`,
 * direct posture only (renders BLOCKED under OIDC, never an error — see
 * `gatus-estate-functions.ts`). `page`/`pageSize` are in the query key: a
 * different page is a genuinely different read, matching Rule P8.
 */
export const gatusEstateEndpointsQuery = (connectionId: string, page: number, pageSize: number) =>
  queryOptions({
    queryKey: ['infrastructure', 'gatus-estate', connectionId, 'endpoints', page, pageSize],
    queryFn: () => fetchGatusEstateEndpoints({ data: { connectionId, page, pageSize } })
  });

/**
 * One endpoint's live uptime — the drill-in (Rule P6) that works in EVERY
 * Gatus auth posture, fetched only once an operator expands that row and
 * picks a duration bucket.
 */
export const gatusEstateEndpointUptimeQuery = (
  connectionId: string,
  key: string,
  duration: '30d' | '7d' | '24h' | '1h'
) =>
  queryOptions({
    queryKey: ['infrastructure', 'gatus-estate', connectionId, 'uptime', key, duration],
    queryFn: () => fetchGatusEstateEndpointUptime({ data: { connectionId, key, duration } })
  });

/**
 * The Tailscale estate browser's (loxep-47o.6) Tailnet section —
 * `listDevices()`, the whole tailnet in one call. Same live/never-cached
 * discipline as every other estate query.
 */
export const tailscaleEstateDevicesQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'tailscale-estate', connectionId, 'devices'],
    queryFn: () => fetchTailscaleEstateDevices({ data: { connectionId } })
  });

/**
 * The Beszel estate browser's (loxep-47o.7) two sections — `health()`
 * (unauthenticated) and `listSystems()` (hub-wide; the adapter already
 * paginates internally up to `BESZEL_MAX_LIST_PAGES`). Each stamps its own
 * clock (Rule P4), so each is its own query.
 */
export const beszelEstateHubQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'beszel-estate', connectionId, 'hub'],
    queryFn: () => fetchBeszelEstateHub({ data: { connectionId } })
  });

export const beszelEstateSystemsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'beszel-estate', connectionId, 'systems'],
    queryFn: () => fetchBeszelEstateSystems({ data: { connectionId } })
  });

/**
 * The Termix estate browser's (loxep-47o.7) two sections — `listHosts()`
 * instance-wide, and `listSessions()` instance-wide (sessions per the
 * owner's 5b ruling, 2026-08-16 — see `termix-estate-functions.ts`).
 */
export const termixEstateHostsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'termix-estate', connectionId, 'hosts'],
    queryFn: () => fetchTermixEstateHosts({ data: { connectionId } })
  });

export const termixEstateSessionsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'termix-estate', connectionId, 'sessions'],
    queryFn: () => fetchTermixEstateSessions({ data: { connectionId } })
  });

/** Named dynamic-IP aliases (Pangolin chain design M5, loxep-acj.5). */
export const ipAliasesQuery = queryOptions({
  queryKey: ['infrastructure', 'ip-aliases'],
  queryFn: () => fetchIpAliases()
});

/* -------------------- provisioning templates (Pangolin chain, loxep-acj.6) */

export const provisioningTemplatesQuery = queryOptions({
  queryKey: ['infrastructure', 'templates'],
  queryFn: () => fetchProvisioningTemplates()
});

export const provisioningTemplateQuery = (id: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'templates', id],
    queryFn: () => fetchProvisioningTemplate({ data: { id } })
  });

export const provisioningTemplateRunQuery = (id: string) =>
  queryOptions({
    queryKey: ['infrastructure', 'templates', 'runs', id],
    queryFn: () => fetchProvisioningTemplateRun({ data: { id } })
  });
