/**
 * `fetchInfrastructureTopology` — the living infrastructure topology page's
 * one server function (UI overhaul 2026 design §4, Wave W3, `loxep-m4m`).
 * Design: `apps/docs/src/content/docs/architecture/ui-overhaul-2026-design.md`,
 * rules G1-G6 and MAP1-MAP2.
 *
 * ## Rule G2: database reads only, ever
 *
 * This module reads `hosting_targets`, `host_addresses`, `managed_domains`,
 * `proxy_resources`, `connections`, `external_resources`, `resource_links`,
 * and `integration_health` — nothing else, and NOTHING here calls a
 * provider. Live truth stays the estate pages' jurisdiction (rules P5-P8
 * unmoved elsewhere); this page maps what Loxep's own tables and registries
 * already say, stamped with Loxep's own read clock (`readAt`), never a
 * provider's. No rate budget is touched by this function, ever.
 *
 * ## Rule G3: nodes and edges STRICTLY from existing foreign keys
 *
 * The node/edge inventory below is the design's own table, verbatim:
 *
 * ```text
 * node kind        source
 * connection       connections, filtered to the Infrastructure category
 *                  (INFRASTRUCTURE_ESTATE_CATEGORY_PROVIDERS — the same set
 *                  `/infrastructure/estate` already uses)
 * domain           managed_domains
 * proxy_resource   proxy_resources (subdomain . mode)
 * hosting_target   hosting_targets (undecommissioned), host_addresses
 *                  kind-badged, health in the tooltip
 * tool             external_resources rows linked to a hosting_target via
 *                  resource_links
 *
 * edge             source key
 * fronted_by       hosting_targets.fronted_by_target_id
 * apex_points_at   managed_domains.apex_target_id
 * routes_to        proxy_resources.hosting_target_id (+ .domain_id)
 * zone_hosted_at   managed_domains.dns_connection_id
 * proxied_via      hosting_targets.proxy_connection_id
 * watched_by       resource_links on hosting_target
 * ```
 *
 * Every edge is built through `@/features/infrastructure/topology`'s
 * `buildEdgeSentence` — a TOTAL mapped type over {@link TopologyEdgeKind}
 * (`EDGE_SENTENCE_REGISTRY` in `sentence-registry.ts`), so an edge kind with
 * no registered sentence fails to TYPECHECK, not just fails a review. This
 * is rule G3's falsifiable form: `buildInfrastructureTopology` below calls
 * `buildEdgeSentence` for every single edge it constructs — there is no path
 * that appends a `TopologyEdgeDto` without going through the registry.
 *
 * ## What this module deliberately does NOT do
 *
 * No layout, no coordinates, no xyflow types. `buildInfrastructureTopology`
 * returns plain nodes/edges; `@/features/infrastructure/topology/layout.ts`
 * computes the deterministic five-rank columnar layout CLIENT-SIDE from that
 * plain data (rule G4) — kept out of this module so the layout algorithm's
 * determinism can be unit-tested with zero database and zero server-function
 * plumbing, matching this file's own test file's "no database" precedent
 * (`infrastructure-functions.test.ts`'s module doc).
 *
 * `buildInfrastructureTopology` is exported and PURE (no db, no fetch) so it
 * can be unit-tested directly with fixture rows — the same "extract the pure
 * assembly function, test it without a server" shape
 * `computeFleetSignals`/`buildProxyResourceChainDtos` already use in
 * `infrastructure-functions.ts`. `fetchInfrastructureTopology` itself is a
 * thin DB-fetch-then-call wrapper, untested directly (same precedent).
 */
import { createServerFn } from '@tanstack/react-start';
import type { HealthStatus } from '@loxep/domain';
import { buildEdgeSentence } from '@/features/infrastructure/topology/sentence-registry';
import { estateHref } from '@/features/estate/provider-registry';

/** Mirrors `@loxep/domain`'s closed `HealthStatus` union — re-exported here so `topology/**` never needs a type-only import across the `@loxep/domain` boundary (this file's own module-doc rule: only THIS server module imports from `@loxep/domain` at all). */
export type TopologyHealthStatus = HealthStatus;

export const TOPOLOGY_NODE_KINDS = [
  'connection',
  'domain',
  'proxy_resource',
  'hosting_target',
  'tool'
] as const;
export type TopologyNodeKind = (typeof TOPOLOGY_NODE_KINDS)[number];

export const TOPOLOGY_EDGE_KINDS = [
  'fronted_by',
  'apex_points_at',
  'routes_to',
  'zone_hosted_at',
  'proxied_via',
  'watched_by'
] as const;
export type TopologyEdgeKind = (typeof TOPOLOGY_EDGE_KINDS)[number];

export interface TopologyNodeHref {
  to: string;
  params?: Record<string, string>;
}

export interface TopologyNodeDto {
  /** `${kind}:${the row's own id}` — stable, collision-free across kinds. */
  id: string;
  kind: TopologyNodeKind;
  name: string;
  status: TopologyHealthStatus | null;
  /** Deep link to the page that owns this node's liveness (rule G2's "every node deep-links out"). `null` only for a `proxy_resource` whose owning domain could not be resolved (should not occur; defensive). */
  href: TopologyNodeHref | null;
  /** `host_addresses.kind` labels present on a `hosting_target` node (WAN/LAN/Tailnet/Other); empty for every other kind. */
  badges: string[];
  /** Small facts the node card/tooltip renders — provider, region, mode, subdomain, connection status. Never a secret, never a raw payload (same discipline `integration_health.detail` itself is held to). */
  meta: Record<string, string | null>;
}

export interface TopologyEdgeDto {
  id: string;
  kind: TopologyEdgeKind;
  sourceNodeId: string;
  targetNodeId: string;
  /** The registered, real-names-substituted operator-language sentence (rule G3). Never empty — see this file's module doc. */
  sentence: string;
}

export interface InfrastructureTopologyDto {
  nodes: TopologyNodeDto[];
  edges: TopologyEdgeDto[];
  /** Loxep's own read clock (rule G2) — never a provider's timestamp. */
  readAt: string;
}

/* --------------------------------------------------------- pure builder --- */

export interface TopologyHostingTargetRow {
  id: string;
  name: string;
  provider: string | null;
  region: string | null;
  frontedByTargetId: string | null;
  proxyConnectionId: string | null;
}

export interface TopologyHostAddressRow {
  hostingTargetId: string;
  kind: string;
}

export interface TopologyManagedDomainRow {
  id: string;
  name: string;
  dnsConnectionId: string;
  apexTargetId: string | null;
}

export interface TopologyProxyResourceRow {
  id: string;
  domainId: string;
  hostingTargetId: string;
  subdomain: string | null;
  mode: string;
}

export interface TopologyConnectionRow {
  id: string;
  provider: string;
  name: string;
  status: string;
}

export interface TopologyExternalResourceRow {
  id: string;
  provider: string;
  externalType: string;
  title: string | null;
  connectionId: string | null;
}

export interface TopologyResourceLinkRow {
  externalResourceId: string;
  resourceId: string;
  resourceType: string;
}

export interface TopologyHealthRow {
  subjectType: string;
  subjectId: string;
  status: TopologyHealthStatus;
}

export interface BuildTopologyInput {
  hostingTargets: TopologyHostingTargetRow[];
  hostAddresses: TopologyHostAddressRow[];
  managedDomains: TopologyManagedDomainRow[];
  proxyResources: TopologyProxyResourceRow[];
  /** Pre-filtered to the Infrastructure category by the caller (rule G3's node table). */
  connections: TopologyConnectionRow[];
  /** Pre-filtered to rows linked to a `hosting_target` by the caller. */
  externalResources: TopologyExternalResourceRow[];
  /** Pre-filtered to `resourceType = 'hosting_target'` by the caller. */
  resourceLinks: TopologyResourceLinkRow[];
  health: TopologyHealthRow[];
  readAt: Date;
}

/** `host_addresses.kind` -> node badge label, in the fixed display order the design's WAN-first convention already uses elsewhere (`HOST_ADDRESS_KIND_LABELS`). */
const HOST_ADDRESS_BADGE_ORDER: { kind: string; label: string }[] = [
  { kind: 'wan', label: 'WAN' },
  { kind: 'lan', label: 'LAN' },
  { kind: 'tailnet', label: 'Tailnet' },
  { kind: 'other', label: 'Other' }
];

function providerLabel(provider: string): string {
  return provider.length === 0 ? provider : provider[0]!.toUpperCase() + provider.slice(1);
}

function fullDomainName(domainName: string, subdomain: string | null): string {
  return subdomain === null ? domainName : `${subdomain}.${domainName}`;
}

function sortNodesByName(nodes: TopologyNodeDto[]): TopologyNodeDto[] {
  return [...nodes].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** PURE, no db, no fetch — see this file's module doc for why this is separated from the handler. */
export function buildInfrastructureTopology(input: BuildTopologyInput): InfrastructureTopologyDto {
  const healthByKey = new Map<string, TopologyHealthStatus>();
  for (const row of input.health)
    healthByKey.set(`${row.subjectType}:${row.subjectId}`, row.status);
  const healthFor = (subjectType: string, subjectId: string): TopologyHealthStatus | null =>
    healthByKey.get(`${subjectType}:${subjectId}`) ?? null;

  const targetById = new Map(input.hostingTargets.map((t) => [t.id, t]));
  const domainById = new Map(input.managedDomains.map((d) => [d.id, d]));
  const connectionById = new Map(input.connections.map((c) => [c.id, c]));
  const externalResourceById = new Map(input.externalResources.map((r) => [r.id, r]));

  const badgesByTargetId = new Map<string, Set<string>>();
  for (const address of input.hostAddresses) {
    const set = badgesByTargetId.get(address.hostingTargetId) ?? new Set<string>();
    set.add(address.kind);
    badgesByTargetId.set(address.hostingTargetId, set);
  }

  const connectionNodes: TopologyNodeDto[] = input.connections.map((connection) => ({
    id: `connection:${connection.id}`,
    kind: 'connection',
    name: connection.name,
    status: healthFor('connection', connection.id),
    href: { to: '/settings/connections' },
    badges: [],
    // Raw provider slug (not `providerLabel`'s capitalized display form) —
    // matches `hosting_target`'s own `meta.provider` convention (line below,
    // `target.provider`) and is required for the node card's `BrandIcon`
    // stitch (loxep-pso, W5): `integrationServiceForProvider`/
    // `PROVIDER_BRAND_ICONS` key off the exact `IntegrationServiceId` slug,
    // which a capitalized label would never match.
    meta: { provider: connection.provider, status: connection.status }
  }));

  const domainNodes: TopologyNodeDto[] = input.managedDomains.map((domain) => ({
    id: `domain:${domain.id}`,
    kind: 'domain',
    name: domain.name,
    status: healthFor('managed_domain', domain.id),
    href: { to: '/infrastructure/domains/$name', params: { name: domain.name } },
    badges: [],
    meta: {}
  }));

  const proxyResourceNodes: TopologyNodeDto[] = input.proxyResources.map((resource) => {
    const domain = domainById.get(resource.domainId);
    const domainName = domain?.name ?? null;
    return {
      id: `proxy_resource:${resource.id}`,
      kind: 'proxy_resource',
      name:
        domainName === null
          ? (resource.subdomain ?? resource.id)
          : fullDomainName(domainName, resource.subdomain),
      status: null,
      href:
        domainName === null
          ? null
          : { to: '/infrastructure/domains/$name', params: { name: domainName } },
      badges: [],
      meta: { mode: resource.mode, subdomain: resource.subdomain }
    };
  });

  const hostingTargetNodes: TopologyNodeDto[] = input.hostingTargets.map((target) => {
    const badgeSet = badgesByTargetId.get(target.id) ?? new Set<string>();
    return {
      id: `hosting_target:${target.id}`,
      kind: 'hosting_target',
      name: target.name,
      status: healthFor('hosting_target', target.id),
      href: { to: '/infrastructure/fleet/$name', params: { name: target.name } },
      badges: HOST_ADDRESS_BADGE_ORDER.filter((entry) => badgeSet.has(entry.kind)).map(
        (entry) => entry.label
      ),
      meta: { provider: target.provider, region: target.region }
    };
  });

  const toolNodes: TopologyNodeDto[] = input.externalResources.map((resource) => {
    const href =
      resource.connectionId === null ? null : estateHref(resource.provider, resource.connectionId);
    return {
      id: `tool:${resource.id}`,
      kind: 'tool',
      name: resource.title ?? `${providerLabel(resource.provider)} ${resource.externalType}`,
      status: healthFor('external_resource', resource.id),
      href,
      badges: [],
      meta: { provider: providerLabel(resource.provider), externalType: resource.externalType }
    };
  });

  const nodes: TopologyNodeDto[] = [
    ...sortNodesByName(connectionNodes),
    ...sortNodesByName(domainNodes),
    ...sortNodesByName(proxyResourceNodes),
    ...sortNodesByName(hostingTargetNodes),
    ...sortNodesByName(toolNodes)
  ];

  const edges: TopologyEdgeDto[] = [];

  // fronted_by: hosting_targets.fronted_by_target_id
  for (const target of input.hostingTargets) {
    if (target.frontedByTargetId === null) continue;
    const fronting = targetById.get(target.frontedByTargetId);
    if (fronting === undefined) continue;
    edges.push({
      id: `edge:fronted_by:${target.id}`,
      kind: 'fronted_by',
      sourceNodeId: `hosting_target:${target.id}`,
      targetNodeId: `hosting_target:${fronting.id}`,
      sentence: buildEdgeSentence('fronted_by', {
        frontedName: target.name,
        frontingName: fronting.name
      })
    });
  }

  // apex_points_at: managed_domains.apex_target_id
  for (const domain of input.managedDomains) {
    if (domain.apexTargetId === null) continue;
    const target = targetById.get(domain.apexTargetId);
    if (target === undefined) continue;
    edges.push({
      id: `edge:apex_points_at:${domain.id}`,
      kind: 'apex_points_at',
      sourceNodeId: `domain:${domain.id}`,
      targetNodeId: `hosting_target:${target.id}`,
      sentence: buildEdgeSentence('apex_points_at', {
        domainName: domain.name,
        targetName: target.name
      })
    });
  }

  // routes_to: proxy_resources.hosting_target_id (+ .domain_id for the sentence's full-domain name)
  for (const resource of input.proxyResources) {
    const target = targetById.get(resource.hostingTargetId);
    const domain = domainById.get(resource.domainId);
    if (target === undefined || domain === undefined) continue;
    edges.push({
      id: `edge:routes_to:${resource.id}`,
      kind: 'routes_to',
      sourceNodeId: `proxy_resource:${resource.id}`,
      targetNodeId: `hosting_target:${target.id}`,
      sentence: buildEdgeSentence('routes_to', {
        fullDomain: fullDomainName(domain.name, resource.subdomain),
        targetName: target.name
      })
    });
  }

  // zone_hosted_at: managed_domains.dns_connection_id
  for (const domain of input.managedDomains) {
    const connection = connectionById.get(domain.dnsConnectionId);
    if (connection === undefined) continue;
    edges.push({
      id: `edge:zone_hosted_at:${domain.id}`,
      kind: 'zone_hosted_at',
      sourceNodeId: `domain:${domain.id}`,
      targetNodeId: `connection:${connection.id}`,
      sentence: buildEdgeSentence('zone_hosted_at', {
        domainName: domain.name,
        providerLabel: providerLabel(connection.provider)
      })
    });
  }

  // proxied_via: hosting_targets.proxy_connection_id
  for (const target of input.hostingTargets) {
    if (target.proxyConnectionId === null) continue;
    const connection = connectionById.get(target.proxyConnectionId);
    if (connection === undefined) continue;
    edges.push({
      id: `edge:proxied_via:${target.id}`,
      kind: 'proxied_via',
      sourceNodeId: `hosting_target:${target.id}`,
      targetNodeId: `connection:${connection.id}`,
      sentence: buildEdgeSentence('proxied_via', {
        targetName: target.name,
        providerLabel: providerLabel(connection.provider)
      })
    });
  }

  // watched_by: resource_links on hosting_target
  const seenWatchedBy = new Set<string>();
  for (const link of input.resourceLinks) {
    const resource = externalResourceById.get(link.externalResourceId);
    const target = targetById.get(link.resourceId);
    if (resource === undefined || target === undefined) continue;
    const dedupeKey = `${resource.id}:${target.id}`;
    if (seenWatchedBy.has(dedupeKey)) continue;
    seenWatchedBy.add(dedupeKey);
    const toolName =
      resource.title ?? `${providerLabel(resource.provider)} ${resource.externalType}`;
    edges.push({
      id: `edge:watched_by:${dedupeKey}`,
      kind: 'watched_by',
      sourceNodeId: `tool:${resource.id}`,
      targetNodeId: `hosting_target:${target.id}`,
      sentence: buildEdgeSentence('watched_by', { toolName, targetName: target.name })
    });
  }

  return { nodes, edges, readAt: input.readAt.toISOString() };
}

/* -------------------------------------------------------------- handler --- */

/**
 * Member-readable (rule G1's "any authenticated member" pattern every other
 * infrastructure GET in this workspace follows). Assembles the topology
 * strictly from Loxep's own tables — see this file's module doc for the
 * exact node/edge inventory and rule G2's "never a live provider call".
 */
export const fetchInfrastructureTopology = createServerFn({ method: 'GET' }).handler(
  async (): Promise<InfrastructureTopologyDto> => {
    const [{ requireSession, getAdminServices }, { INFRASTRUCTURE_ESTATE_CATEGORY_PROVIDERS }] =
      await Promise.all([import('@/server/admin'), import('@/features/estate/provider-registry')]);
    await requireSession();
    const { handle, connections, health } = getAdminServices();
    const readAt = new Date();

    const [
      hostingTargetRows,
      hostAddressRows,
      managedDomainRows,
      proxyResourceRows,
      allConnections,
      connectionHealth,
      hostingTargetHealth,
      managedDomainHealth,
      resourceLinkRows
    ] = await Promise.all([
      handle.db.query.hostingTargets.findMany({
        where: (table, { isNull }) => isNull(table.decommissionedAt)
      }),
      handle.db.query.hostAddresses.findMany(),
      handle.db.query.managedDomains.findMany(),
      handle.db.query.proxyResources.findMany(),
      connections.listConnections(),
      health.listHealth({ subjectType: 'connection' }),
      health.listHealth({ subjectType: 'hosting_target' }),
      health.listHealth({ subjectType: 'managed_domain' }),
      handle.db.query.resourceLinks.findMany({
        where: (table, { eq }) => eq(table.resourceType, 'hosting_target')
      })
    ]);

    const infraConnections = allConnections.filter((connection) =>
      INFRASTRUCTURE_ESTATE_CATEGORY_PROVIDERS.has(connection.provider)
    );

    const externalResourceIds = [
      ...new Set(resourceLinkRows.map((link) => link.externalResourceId))
    ];
    const [externalResourceRows, toolHealth] = await Promise.all([
      externalResourceIds.length === 0
        ? Promise.resolve([])
        : handle.db.query.externalResources.findMany({
            where: (table, { inArray }) => inArray(table.id, externalResourceIds)
          }),
      health.listHealth({ subjectType: 'external_resource' })
    ]);

    return buildInfrastructureTopology({
      hostingTargets: hostingTargetRows.map((row) => ({
        id: row.id,
        name: row.name,
        provider: row.provider,
        region: row.region,
        frontedByTargetId: row.frontedByTargetId,
        proxyConnectionId: row.proxyConnectionId
      })),
      hostAddresses: hostAddressRows.map((row) => ({
        hostingTargetId: row.hostingTargetId,
        kind: row.kind
      })),
      managedDomains: managedDomainRows.map((row) => ({
        id: row.id,
        name: row.name,
        dnsConnectionId: row.dnsConnectionId,
        apexTargetId: row.apexTargetId
      })),
      proxyResources: proxyResourceRows.map((row) => ({
        id: row.id,
        domainId: row.domainId,
        hostingTargetId: row.hostingTargetId,
        subdomain: row.subdomain,
        mode: row.mode
      })),
      connections: infraConnections.map((row) => ({
        id: row.id,
        provider: row.provider,
        name: row.name,
        status: row.status
      })),
      externalResources: externalResourceRows.map((row) => ({
        id: row.id,
        provider: row.provider,
        externalType: row.externalType,
        title: row.title,
        connectionId: row.connectionId
      })),
      resourceLinks: resourceLinkRows.map((row) => ({
        externalResourceId: row.externalResourceId,
        resourceId: row.resourceId,
        resourceType: row.resourceType
      })),
      health: [
        ...connectionHealth,
        ...hostingTargetHealth,
        ...managedDomainHealth,
        ...toolHealth
      ].map((row) => ({
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        status: row.status
      })),
      readAt
    });
  }
);
