/**
 * `fetchInfrastructureTopology` — the living infrastructure topology page's
 * one server function (UI overhaul 2026 design §4, Wave W3, `loxep-m4m`;
 * `observed_via`/`address_match` added by `loxep-h4v`).
 * Design: `apps/docs/src/content/docs/architecture/ui-overhaul-2026-design.md`,
 * rules G1-G7 and MAP1-MAP2.
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
 * observed_via     external_resources.connection_id (loxep-h4v, see below)
 * address_match    host_addresses value intersection (loxep-h4v, INFERRED)
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
 *
 * ## Rule G7: the observed layer (`loxep-2mr`, owner ruling 2026-08-17)
 *
 * Beyond the linked-only inventory above, this module also assembles one
 * `tool`-kind node, `observed: true`, per UNLINKED `external_resources` row
 * across the five discovery-writing providers (tailscale, dockhand, beszel,
 * gatus, termix — `@loxep/domain`'s `FLEET_TOOL_PANEL_ORDER`) —
 * `getResourceLinksService().listUnattachedByProvider(provider)`, the same
 * accessor the attach picker (`fetchDiscoveredFleetResources`) and the
 * tailnet candidates panel (`fetchUnmatchedTailscaleDevices`) already read.
 * Tailscale rows dismissed via `tailscaleIgnoredDevicesSetting` are excluded
 * — ignored means hidden here too. These nodes carry no `watched_by` edge
 * (nothing links them — that is the whole point of "observed"), but DO
 * participate in `loxep-h4v`'s two edge kinds below like any other tool
 * node, and are visually distinguished by the `observed` flag alone, not a
 * separate {@link TopologyNodeKind} — see the field's own doc comment for
 * why a flag beat a sixth node kind.
 *
 * ## `observed_via` / `address_match` (`loxep-h4v`, 2026-08-17)
 *
 * The sweeps' own PERSISTED data carries two more relationships the six
 * edges above never draw, so a connections-heavy estate used to render as
 * disconnected columns:
 *
 * - **`observed_via`** — `external_resources.connection_id` names the
 *   connection that DISCOVERED every tool node, linked or observed alike.
 *   Drawn `connection -> tool`, a normal recorded edge (it IS a recorded
 *   fact, same footing as `watched_by`), for every tool/observed row that
 *   carries a `connection_id` whose connection is in the node set (rule G3's
 *   "Infrastructure category" filter always keeps it there; guarded anyway,
 *   same dangling-reference posture the other five edges already hold to).
 * - **`address_match`** — INFERRED, never recorded fact. Rule G2 stands
 *   unmoved (persisted data only, zero live calls): a tool/observed
 *   resource's own persisted address fields (tailscale's `metadata.
 *   addresses`, dockhand's `metadata.host`/`.publicIp`, beszel's `metadata.
 *   host` — see `candidateAddresses`) are compared, by EXACT string
 *   equality only (never fuzzy, never DNS, never subnet logic), against
 *   every hosting target's `host_addresses.value` set. A match draws
 *   `tool -> hosting_target`, at most one edge per pair even when several
 *   addresses match (`TopologyEdgeDto.matchedAddress`/`.matchCount` carry
 *   which one and how many), and is SKIPPED entirely for a pair already
 *   connected by `watched_by` — a declared companion has nothing left to
 *   "possibly" confirm. Rendered visually distinct (dotted, muted) by
 *   `topology-graph.tsx` so it is never mistaken for recorded fact.
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
  'watched_by',
  'observed_via',
  'address_match'
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
  /**
   * Rule G7's observed layer, `loxep-2mr`: true for a `tool`-kind node built
   * from an `external_resources` row with NO `resource_links` row (a sweep
   * recorded it, nobody claimed it). A flag on the existing `tool` kind, not
   * a sixth {@link TopologyNodeKind} — an observed resource is structurally
   * the SAME thing a linked companion tool is (an `external_resources` row
   * from one of the same five discovery-writing providers), it just lacks
   * the attachment; a new kind would force it into its own `TOPOLOGY_RANK_BY_
   * KIND`/`TOPOLOGY_NODE_KIND_LABELS`/`TOPOLOGY_NODE_KIND_CHART_TOKEN` entry
   * for no semantic gain, and would make the per-kind filter chip ("Companion
   * tool") and the dedicated "Show observed" toggle (rule G7's own control,
   * independent of the per-kind chips) fight over the same nodes. Always
   * `false` for every other node — set explicitly at every construction site
   * so a reviewer never has to wonder whether an omission means "false" or
   * "forgot".
   */
  observed: boolean;
}

export interface TopologyEdgeDto {
  id: string;
  kind: TopologyEdgeKind;
  sourceNodeId: string;
  targetNodeId: string;
  /** The registered, real-names-substituted operator-language sentence (rule G3). Never empty — see this file's module doc. */
  sentence: string;
  /**
   * `address_match` only (`loxep-h4v`) — the first exactly-matched address
   * (deterministic: the resource's own candidate-address order, filtered to
   * addresses the target also carries). `undefined` for every other edge
   * kind, including `observed_via`.
   */
  matchedAddress?: string;
  /**
   * `address_match` only — the count of DISTINCT addresses this resource and
   * target share (always >= 1). The sentence names only the first
   * ({@link matchedAddress}) and mentions the count when it is more than
   * one; this field lets the UI do the same without re-deriving it.
   * `undefined` for every other edge kind.
   */
  matchCount?: number;
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
  /**
   * The `inet` column's own text form (`loxep-h4v`) — PostgreSQL omits the
   * `/32`/`/128` suffix for a full-width mask, which is all `declare()`/
   * `upsertObserved()` ever write, so this is a bare address literal, ready
   * for the `address_match` edge's exact string-equality comparison with no
   * normalization step.
   */
  value: string;
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
  /**
   * Optional (`loxep-h4v`) — absent from every pre-existing caller/test that
   * only ever fed a `watched_by` edge and never needed a resource's address
   * fields. Populated by the handler so the `address_match` edge can read a
   * LINKED tool's persisted addresses too, exactly like it already does for
   * an observed row's {@link TopologyObservedResourceRow.metadata}.
   */
  metadata?: Record<string, unknown>;
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

/**
 * One UNLINKED `external_resources` row — rule G7's observed layer. Carries
 * `url`/`metadata` (absent from {@link TopologyExternalResourceRow}, which
 * only ever fed a linked `watched_by` edge and never needed them) because an
 * isolated node has no edge sentence to lean on and must stand alone: the
 * node's own tooltip is the only place these facts surface.
 */
export interface TopologyObservedResourceRow {
  id: string;
  provider: string;
  externalType: string;
  title: string | null;
  connectionId: string | null;
  /** The tailnet node id for a tailscale row — the ONLY provider whose ignore map exists, keyed by this field. `null` for every other provider's row. */
  externalId: string | null;
  /** Deep link to the provider's own UI — surfaced in `meta.url`, never used for `router.navigate` (that stays `href`, the internal Loxep surface). */
  url: string;
  metadata: Record<string, unknown>;
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
  /**
   * Rule G7: every UNLINKED `external_resources` row across the five
   * discovery-writing providers — UNFILTERED by ignore state (see
   * {@link ignoredTailscaleExternalIds}, applied inside this pure builder so
   * the "ignored means hidden here too" rule is testable with zero
   * database). The observed layer is scoped to PERSISTED observations only
   * (rule G2 stands: this module never calls a provider), so Pangolin —
   * which writes no discovery row at all — is structurally absent and stays
   * absent; the legend's own copy says so.
   */
  observedResources: TopologyObservedResourceRow[];
  /** `tailscaleIgnoredDevicesSetting`'s own keys (tailnet node ids) — a tailscale observed row whose `externalId` is in this set is dropped entirely, never rendered even as a dashed node. */
  ignoredTailscaleExternalIds: ReadonlySet<string>;
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

/** Coerces one `external_resources.metadata` field into the flat string `meta` shape every node card reads — never a nested object, never a secret (same discipline `providerLabel`'s callers already hold `meta` to). */
function metaString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const strings = value.filter((entry): entry is string => typeof entry === 'string');
    return strings.length === 0 ? null : strings.join(', ');
  }
  return null;
}

/**
 * Per-provider metadata keys worth a tooltip line for an observed resource —
 * the survey's own field inventory (rule G7's design doc, verbatim): the
 * fields each discovery sweep's own `upsertExternalResource` call is known
 * to write into `metadata`. A provider outside this table (should not occur
 * — the caller only ever passes rows from the five discovery-writing
 * providers) simply carries no extra fields, never a crash.
 */
const OBSERVED_RESOURCE_METADATA_KEYS: Record<string, string[]> = {
  tailscale: ['addresses', 'os', 'online', 'lastSeen', 'magicDnsName'],
  dockhand: ['host', 'port', 'connectionType', 'publicIp'],
  beszel: ['status', 'host', 'port'],
  gatus: ['group', 'success'],
  termix: ['host', 'status']
};

/** Builds an observed-resource node's `meta` — provider/externalType/url plus that provider's own tooltip-worthy fields (see {@link OBSERVED_RESOURCE_METADATA_KEYS}). */
function observedResourceMeta(
  resource: TopologyObservedResourceRow
): Record<string, string | null> {
  const meta: Record<string, string | null> = {
    provider: providerLabel(resource.provider),
    // The raw slug too, alongside the capitalized display form above — the
    // node card's `BrandIcon` lookup (`integrationServiceForProvider`) keys
    // off the exact slug, same as `connection` nodes' `meta.provider`
    // (`loxep-pso`'s W5 fix); `tool`-kind linked nodes don't carry this today
    // (no card wired an icon to them), so this is scoped to observed nodes
    // only, per this wave's own ask.
    providerSlug: resource.provider,
    externalType: resource.externalType,
    url: resource.url
  };
  for (const key of OBSERVED_RESOURCE_METADATA_KEYS[resource.provider] ?? []) {
    meta[key] = metaString(resource.metadata[key]);
  }
  return meta;
}

/** The one "title, or Provider externalType" fallback every `tool`-kind node (linked and observed alike) has always used — pulled out so `loxep-h4v`'s edge-building loops (`observed_via`/`address_match`) can name a node exactly the way its own card does, without a second copy of the fallback. */
function toolNodeName(resource: {
  title: string | null;
  provider: string;
  externalType: string;
}): string {
  return resource.title ?? `${providerLabel(resource.provider)} ${resource.externalType}`;
}

/**
 * `loxep-h4v`'s `address_match` edge, exact-string-equality only (never
 * fuzzy, never DNS, never subnet logic — the design's own words). A regex
 * IP-literal guard, not `node:net`'s `isIP` (the pattern `fleet-health.ts`'s
 * `hostAddressFamilyOf` already established for the identical "only a real
 * IP literal is eligible" judgment on these same provider fields): THIS
 * module also feeds the client bundle directly (`TOPOLOGY_NODE_KINDS` etc.
 * are plain value imports in `topology/components/*`), and `fleet-health.ts`
 * never crosses that boundary — importing a Node builtin here would be a new
 * risk that module never had to take. `IPV4_LITERAL` validates each octet's
 * range (0-255), stricter than `infrastructure-functions.ts`'s own
 * `IPV4_SHAPE` (a shape-only guess used solely for a best-effort
 * `hosting_targets.address_v4` default on adopt) because a false-positive
 * here would let a bogus "match" through the edge itself, not just a form
 * default an operator can immediately see and fix.
 */
const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d|0)';
const IPV4_LITERAL = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);
const IPV6_LITERAL =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;

function isIpLiteral(value: string): boolean {
  return IPV4_LITERAL.test(value) || IPV6_LITERAL.test(value);
}

/**
 * The persisted per-provider address FIELDS the `address_match` edge is
 * allowed to read (`loxep-h4v`'s own inventory, verified against
 * `fleet-health.ts`'s `projectDockhandResources`/`projectTailscaleDevices`,
 * the same sweeps that write these exact `metadata` keys): tailscale's
 * `addresses` array, dockhand's `host` + `publicIp`, beszel's `host`. Every
 * candidate is filtered through {@link isIpLiteral} before it is even
 * eligible to match — `host` in particular is a CONNECTION address and is
 * very often a hostname, exactly the reasoning `fleet-health.ts` already
 * documents for the identical field. A provider outside this table (gatus,
 * termix — neither one carries a persisted address field at all) returns no
 * candidates, never a crash.
 */
function candidateAddresses(provider: string, metadata: Record<string, unknown>): string[] {
  switch (provider) {
    case 'tailscale': {
      const raw = metadata['addresses'];
      const values = Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === 'string')
        : [];
      return values.filter(isIpLiteral);
    }
    case 'dockhand': {
      const host = metadata['host'];
      const publicIp = metadata['publicIp'];
      return [host, publicIp].filter(
        (entry): entry is string => typeof entry === 'string' && isIpLiteral(entry)
      );
    }
    case 'beszel': {
      const host = metadata['host'];
      return typeof host === 'string' && isIpLiteral(host) ? [host] : [];
    }
    default:
      return [];
  }
}

function sortNodesByName(nodes: TopologyNodeDto[]): TopologyNodeDto[] {
  return nodes.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
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
  // `loxep-h4v`: every persisted address VALUE a target carries, regardless
  // of `kind` — `address_match` compares against the target's whole
  // `host_addresses` set (WAN, LAN, tailnet, and unclassified `other` rows
  // all count; a match is a match, classification is a separate question).
  const addressValuesByTargetId = new Map<string, Set<string>>();
  for (const address of input.hostAddresses) {
    const set = badgesByTargetId.get(address.hostingTargetId) ?? new Set<string>();
    set.add(address.kind);
    badgesByTargetId.set(address.hostingTargetId, set);

    const values = addressValuesByTargetId.get(address.hostingTargetId) ?? new Set<string>();
    values.add(address.value);
    addressValuesByTargetId.set(address.hostingTargetId, values);
  }

  const connectionNodes: TopologyNodeDto[] = input.connections.map((connection) => ({
    id: `connection:${connection.id}`,
    kind: 'connection',
    name: connection.name,
    status: healthFor('connection', connection.id),
    href: { to: '/settings/connections' },
    badges: [],
    observed: false,
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
    observed: false,
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
      observed: false,
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
      observed: false,
      meta: { provider: target.provider, region: target.region }
    };
  });

  const toolNodes: TopologyNodeDto[] = input.externalResources.map((resource) => {
    const href =
      resource.connectionId === null ? null : estateHref(resource.provider, resource.connectionId);
    return {
      id: `tool:${resource.id}`,
      kind: 'tool',
      name: toolNodeName(resource),
      status: healthFor('external_resource', resource.id),
      href,
      badges: [],
      observed: false,
      meta: { provider: providerLabel(resource.provider), externalType: resource.externalType }
    };
  });

  // Rule G7's observed layer: unlinked external_resources rows, `observed:
  // true`, sharing the `tool` kind (see TopologyNodeDto.observed's own doc
  // for why). Never has a `watched_by` edge — that loop only ever iterates
  // `input.resourceLinks`, which by construction has no row pointing at one
  // of these ids. `loxep-h4v`'s `observed_via`/`address_match` edges DO reach
  // these nodes, same as a linked tool (see below). Ignored means hidden
  // here too: a tailscale row whose externalId is in the ignore set is
  // dropped before it ever becomes a node — pulled out to its own binding so
  // the edge-building loops below read the identical filtered set, not a
  // second copy of the ignore rule.
  const visibleObservedResources = input.observedResources.filter(
    (resource) =>
      resource.provider !== 'tailscale' ||
      resource.externalId === null ||
      !input.ignoredTailscaleExternalIds.has(resource.externalId)
  );

  const observedResourceNodes: TopologyNodeDto[] = visibleObservedResources.map((resource) => {
    const href =
      resource.connectionId === null ? null : estateHref(resource.provider, resource.connectionId);
    return {
      id: `tool:${resource.id}`,
      kind: 'tool',
      name: toolNodeName(resource),
      status: healthFor('external_resource', resource.id),
      href,
      badges: [],
      observed: true,
      meta: observedResourceMeta(resource)
    };
  });

  const nodes: TopologyNodeDto[] = [
    ...sortNodesByName(connectionNodes),
    ...sortNodesByName(domainNodes),
    ...sortNodesByName(proxyResourceNodes),
    ...sortNodesByName(hostingTargetNodes),
    ...sortNodesByName([...toolNodes, ...observedResourceNodes])
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
    edges.push({
      id: `edge:watched_by:${dedupeKey}`,
      kind: 'watched_by',
      sourceNodeId: `tool:${resource.id}`,
      targetNodeId: `hosting_target:${target.id}`,
      sentence: buildEdgeSentence('watched_by', {
        toolName: toolNodeName(resource),
        targetName: target.name
      })
    });
  }

  // `loxep-h4v`: every tool node, linked AND observed, participates in the
  // two edge kinds below — the same combined, order-preserving list both
  // loops share.
  const allToolResources = [...input.externalResources, ...visibleObservedResources];

  // observed_via: external_resources.connection_id, for BOTH linked and
  // observed rows. Rule G3's "an edge with no registered sentence may not
  // render" is enforced by buildEdgeSentence's total mapped type, same as
  // every other edge kind; the dangling-reference guard here follows this
  // module's own established precedent (fronted_by/apex_points_at/etc.
  // above): if the connection isn't a node (shouldn't happen — infrastructure
  // connections are all nodes), skip, never a dangling edge.
  for (const resource of allToolResources) {
    if (resource.connectionId === null) continue;
    const connection = connectionById.get(resource.connectionId);
    if (connection === undefined) continue;
    edges.push({
      id: `edge:observed_via:${resource.id}`,
      kind: 'observed_via',
      sourceNodeId: `connection:${connection.id}`,
      targetNodeId: `tool:${resource.id}`,
      sentence: buildEdgeSentence('observed_via', {
        providerLabel: providerLabel(connection.provider),
        resourceName: toolNodeName(resource)
      })
    });
  }

  // address_match (INFERRED, rule G2/G3 unmoved): exact-string-equality
  // intersection of a tool/observed resource's persisted address fields
  // (see `candidateAddresses`'s own doc) with a hosting target's
  // `host_addresses.value` set. At most one edge per (resource, target) pair
  // even when several addresses match — the first (the resource's own
  // candidate-address order, filtered to values the target also carries)
  // is named in the sentence/`matchedAddress`; `matchCount` carries the
  // total distinct matches so the UI never has to re-derive it. A pair
  // already connected by `watched_by` is skipped: that relationship is
  // DECLARED, not inferred, so "possibly the same machine — link it to
  // confirm" would be actively misleading for something already linked.
  for (const resource of allToolResources) {
    const candidates = candidateAddresses(resource.provider, resource.metadata ?? {});
    if (candidates.length === 0) continue;
    for (const target of input.hostingTargets) {
      if (seenWatchedBy.has(`${resource.id}:${target.id}`)) continue;
      const targetAddresses = addressValuesByTargetId.get(target.id);
      if (targetAddresses === undefined) continue;
      const matched = [...new Set(candidates.filter((address) => targetAddresses.has(address)))];
      const matchedAddress = matched[0];
      if (matchedAddress === undefined) continue;
      edges.push({
        id: `edge:address_match:${resource.id}:${target.id}`,
        kind: 'address_match',
        sourceNodeId: `tool:${resource.id}`,
        targetNodeId: `hosting_target:${target.id}`,
        matchedAddress,
        matchCount: matched.length,
        sentence: buildEdgeSentence('address_match', {
          resourceName: toolNodeName(resource),
          address: matchedAddress,
          targetName: target.name,
          extraMatchesLabel:
            matched.length > 1
              ? ` (and ${matched.length - 1} more matching address${matched.length - 1 === 1 ? '' : 'es'})`
              : ''
        })
      });
    }
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
    const [
      { requireSession, getAdminServices, getResourceLinksService },
      { INFRASTRUCTURE_ESTATE_CATEGORY_PROVIDERS },
      { FLEET_TOOL_PANEL_ORDER, tailscaleIgnoredDevicesSetting }
    ] = await Promise.all([
      import('@/server/admin'),
      import('@/features/estate/provider-registry'),
      import('@loxep/domain')
    ]);
    await requireSession();
    const { handle, connections, health, settings } = getAdminServices();
    const resourceLinks = getResourceLinksService();
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
    const [externalResourceRows, toolHealth, unattachedByProvider, ignoredTailscaleDevices] =
      await Promise.all([
        externalResourceIds.length === 0
          ? Promise.resolve([])
          : handle.db.query.externalResources.findMany({
              where: (table, { inArray }) => inArray(table.id, externalResourceIds)
            }),
        health.listHealth({ subjectType: 'external_resource' }),
        // Rule G7's observed layer: every UNLINKED external_resources row
        // across the five discovery-writing providers — the same
        // `listUnattachedByProvider` accessor the attach picker and the
        // tailnet candidates panel already read.
        Promise.all(
          FLEET_TOOL_PANEL_ORDER.map((provider) => resourceLinks.listUnattachedByProvider(provider))
        ),
        settings.get(tailscaleIgnoredDevicesSetting)
      ]);

    const observedResourceRows = unattachedByProvider.flat();

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
        kind: row.kind,
        value: row.value
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
        connectionId: row.connectionId,
        // `loxep-h4v`: needed for the `address_match` edge over a LINKED
        // tool's own persisted address fields, same source `observedResources`
        // below already reads for an unlinked row. Cast, not `$type`d at the
        // schema (plain `jsonb`, same as `resources.ts` itself) — the same
        // cast `infrastructure-functions.ts` already applies to this exact
        // column elsewhere in this workspace.
        metadata: row.metadata as Record<string, unknown>
      })),
      resourceLinks: resourceLinkRows.map((row) => ({
        externalResourceId: row.externalResourceId,
        resourceId: row.resourceId,
        resourceType: row.resourceType
      })),
      observedResources: observedResourceRows.map((row) => ({
        id: row.id,
        provider: row.provider,
        externalType: row.externalType,
        title: row.title,
        connectionId: row.connectionId,
        externalId: row.externalId,
        url: row.url,
        metadata: row.metadata
      })),
      ignoredTailscaleExternalIds: new Set(Object.keys(ignoredTailscaleDevices)),
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
