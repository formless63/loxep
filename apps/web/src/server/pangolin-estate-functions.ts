/**
 * Server functions for the Pangolin estate browser (loxep-pq2): "the org as
 * it actually is, with control in context." A per-connection page under
 * `/infrastructure/proxy/$connectionId` renders a LIVE READ of everything
 * one Pangolin instance actually has — sites, resources, org domains — which
 * no surface in Loxep showed before this (M2/M4/M5/M7 built the intent/
 * reconcile side; the browse-the-real-estate side never existed).
 *
 * ## Live-read discipline — the Dockhand containers panel precedent, applied here
 *
 * Nothing this file reads is ever persisted. Every response carries its own
 * `readAt` (Loxep's OWN clock, stamped fresh on every call), matching
 * `fetchDockhandHostView`'s own rule (`dockhand-containers-panel/index.tsx`'s
 * module doc: "no table, no cache, no cadence"). Every field renders
 * provider-truth VERBATIM — this module reshapes shape (numeric booleans,
 * nesting) but never a value into a verdict.
 *
 * ## Rate-budget discipline — the recon-test lesson, applied structurally
 *
 * The Pangolin adapter's per-connection token bucket defaults to capacity 5,
 * refill 1/s (`PANGOLIN_SUGGESTED_CAPACITY`/`_REFILL_PER_SECOND`, `@loxep/
 * integration-pangolin`'s `rate-budget.ts`) — comfortably enough for the
 * overview's fixed THREE calls (`listSites`, `listResources`, `listDomains`,
 * regardless of estate size) but NOT enough to fan out one `listRules`/
 * `listTargets` pair per resource in the same render, which is exactly what
 * the recon test that live-verified this adapter learned the hard way. So a
 * resource's rules/targets are read ONLY on explicit expand
 * ({@link fetchPangolinEstateResourceDetail}), one resource at a time, and
 * ONLY for a resource this browser has not already matched to a declared
 * `proxy_resources` row — a MATCHED resource's rules are already sitting in
 * the overview response's `declared` field (a database read, not a fourth
 * Pangolin call), so expanding it costs nothing further.
 *
 * ## Control in context — mounting EXISTING actions, never a new write path
 *
 * `adoptPangolinResourceAsProxyResource` below is the ONE new write this
 * milestone adds, and it writes only Loxep's OWN `proxy_resources` intent
 * row via `@loxep/infrastructure`'s new `declareFromObserved` — never a
 * Pangolin call (`packages/integrations/pangolin` gains nothing from this
 * milestone; its four writes are unchanged). Retire/re-enable (M7,
 * `loxep-acj.7`) is NOT reimplemented here: once a live resource is matched
 * to a declared row, the estate browser renders that row with the SAME
 * `ProxyResourceRow`/`RuleRow` components `/infrastructure/domains/$name`
 * and `/infrastructure/fleet/$name` already use, wired to the SAME
 * `retireProxyResourceRule`/`enableProxyResourceRule` server functions —
 * control mounted where it already lives, not duplicated.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { buildProxyResourceChainDtos } from '@/server/infrastructure-functions';
import type { ProxyResourceChainDto } from '@/server/infrastructure-functions';

function iso(date: Date): string {
  return date.toISOString();
}

const PANGOLIN_PROVIDER = 'pangolin';

const connectionIdInput = z.strictObject({ connectionId: z.uuid() });

// ---------------------------------------------------------------------------
// Overview: sites + resources + org domains, in exactly three Pangolin calls
// ---------------------------------------------------------------------------

export interface PangolinEstateSiteDto {
  siteId: number | null;
  niceId: string | null;
  name: string | null;
  type: string | null;
  online: boolean;
  address: string | null;
  status: string | null;
}

export interface PangolinEstateResourceDto {
  resourceId: number | null;
  niceId: string | null;
  name: string | null;
  fullDomain: string | null;
  subdomain: string | null;
  domainId: string | null;
  mode: string | null;
  ssl: boolean;
  enabled: boolean;
  blockAccess: boolean;
  sso: boolean | null;
  emailWhitelistEnabled: boolean | null;
  health: string | null;
  /**
   * Non-null when this live resource is already a declared `proxy_resources`
   * row Loxep controls — the FULL chain DTO, rules included (already
   * retire/enable-capable), so the estate browser never needs a second fetch
   * to show or act on them. Matched by `externalResourceId` first (the
   * self-retired bootstrap id), falling back to `fullDomain` for a declared
   * row a reconcile has not yet matched.
   */
  declared: ProxyResourceChainDto | null;
}

export interface PangolinEstateDomainDto {
  domainId: string | null;
  baseDomain: string | null;
  type: string | null;
  verified: boolean;
  failed: boolean;
  configManaged: boolean;
}

export interface PangolinEstateOverviewDto {
  connectionId: string;
  connectionName: string;
  /** `null` when this connection has no resolvable org id — see the handler's own doc for why the browser then has nothing to show. */
  orgId: string | null;
  sites: PangolinEstateSiteDto[];
  resources: PangolinEstateResourceDto[];
  domains: PangolinEstateDomainDto[];
  readAt: string;
}

export function matchDeclaredResource(
  resource: { resourceId: number | null; fullDomain: string | null },
  declared: readonly ProxyResourceChainDto[]
): ProxyResourceChainDto | null {
  if (resource.resourceId !== null) {
    const byExternalId = declared.find(
      (entry) => entry.externalResourceId === String(resource.resourceId)
    );
    if (byExternalId !== undefined) return byExternalId;
  }
  if (resource.fullDomain === null) return null;
  return declared.find((entry) => entry.fullDomain === resource.fullDomain) ?? null;
}

/**
 * The whole estate overview for one Pangolin connection — sites, resources
 * (each cross-referenced against Loxep's own declared `proxy_resources`),
 * and org domains. Exactly three Pangolin calls, regardless of how large the
 * estate is (10 sites / 20 resources / 9 domains, live-verified 2026-08-16 —
 * see `packages/integrations/pangolin/src/adapter.ts`'s module doc). Member-
 * readable (`requireSession`): this is visibility, not control.
 */
export const fetchPangolinEstateOverview = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<PangolinEstateOverviewDto> => {
    const { requireSession, getAdminServices, getPangolinAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    const { handle, connections, proxyResources } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);
    if (connection.provider !== PANGOLIN_PROVIDER) {
      throw new Error(`connection "${data.connectionId}" is not a Pangolin connection`);
    }

    const { adapter, orgId } = await getPangolinAdapterForConnection(data.connectionId);
    if (orgId === null) {
      // Honest degrade, no guess, no fan-out: `listOrgs` is root-key-only
      // (the adapter's own doc), so an org-scoped connection with no
      // configured orgId — or a root connection nobody has picked an org
      // for yet — has nothing this browser can list. Same "absent, not
      // empty-implying-broken" discipline the Dockhand panel's `null` return
      // documents.
      return {
        connectionId: connection.id,
        connectionName: connection.name,
        orgId: null,
        sites: [],
        resources: [],
        domains: [],
        readAt: iso(new Date())
      };
    }

    const [sites, resources, domains] = await Promise.all([
      adapter.listSites(orgId),
      adapter.listResources(orgId),
      adapter.listDomains(orgId)
    ]);

    // The declared side of the chain — a database read, batched across every
    // hosting target THIS connection fronts, never a per-resource Pangolin
    // call. Reuses `infrastructure-functions.ts`'s own DTO builder so this
    // page can never render the chain differently than the domain/fleet
    // detail pages do.
    const targets = await handle.db.query.hostingTargets.findMany({
      where: (table, { eq }) => eq(table.proxyConnectionId, data.connectionId),
      columns: { id: true, name: true }
    });
    const declaredEntries = (
      await Promise.all(
        targets.map((target) => proxyResources.listResourcesForHostingTarget(target.id))
      )
    ).flat();
    const domainIds = [...new Set(declaredEntries.map((entry) => entry.resource.domainId))];
    const domainRows =
      domainIds.length === 0
        ? []
        : await handle.db.query.managedDomains.findMany({
            where: (table, { inArray }) => inArray(table.id, domainIds),
            columns: { id: true, name: true }
          });
    const declared =
      declaredEntries.length === 0
        ? []
        : await buildProxyResourceChainDtos(handle, declaredEntries, {
            domainNameById: new Map(domainRows.map((row) => [row.id, row.name])),
            hostingTargetNameById: new Map(targets.map((target) => [target.id, target.name]))
          });

    return {
      connectionId: connection.id,
      connectionName: connection.name,
      orgId,
      sites: sites.map((site) => ({
        siteId: site.siteId,
        niceId: site.niceId,
        name: site.name,
        type: site.type,
        online: site.online,
        address: site.address,
        status: site.status
      })),
      resources: resources.map((resource) => ({
        resourceId: resource.resourceId,
        niceId: resource.niceId,
        name: resource.name,
        fullDomain: resource.fullDomain,
        subdomain: resource.subdomain,
        domainId: resource.domainId,
        mode: resource.mode,
        ssl: resource.ssl,
        enabled: resource.enabled,
        blockAccess: resource.blockAccess,
        sso: resource.sso,
        emailWhitelistEnabled: resource.emailWhitelistEnabled,
        health: resource.health,
        declared: matchDeclaredResource(resource, declared)
      })),
      domains: domains.map((domain) => ({
        domainId: domain.domainId,
        baseDomain: domain.baseDomain,
        type: domain.type,
        verified: domain.verified,
        failed: domain.failed,
        configManaged: domain.configManaged
      })),
      readAt: iso(new Date())
    };
  });

// ---------------------------------------------------------------------------
// Per-resource drill-in: rules + targets, ON EXPAND ONLY
// ---------------------------------------------------------------------------

export interface PangolinEstateTargetDto {
  targetId: number | null;
  siteId: number | null;
  ip: string | null;
  port: number | null;
  method: string | null;
  mode: string | null;
  enabled: boolean;
  priority: number | null;
}

export interface PangolinEstateRuleDto {
  ruleId: number | null;
  action: string | null;
  match: string | null;
  value: string | null;
  priority: number | null;
  enabled: boolean;
}

export interface PangolinEstateResourceDetailDto {
  resourceId: string;
  targets: PangolinEstateTargetDto[];
  rules: PangolinEstateRuleDto[];
  readAt: string;
}

const fetchPangolinEstateResourceDetailInput = z.strictObject({
  connectionId: z.uuid(),
  /** Pangolin's own resource id (numeric, carried as a string) — never a Loxep `proxy_resources.id`. */
  resourceId: z.string().trim().min(1)
});

/**
 * Live `listTargets`/`listRules` for ONE Pangolin resource — two calls,
 * fired only when an operator expands that resource's row. This is the
 * UNDECLARED-resource path only: a resource the overview already matched to
 * a declared `proxy_resources` row never needs this call (its rules are
 * already in the overview's `declared.rules`) — the client-side caller is
 * responsible for that branch, matching `fetchDockhandHostView`'s own "the
 * caller decides whether to mount this" discipline. No lifecycle control is
 * offered on what this returns: a raw `PangolinRuleFact` carries no Loxep
 * `proxy_resource_rules.id` to retire/enable against.
 */
export const fetchPangolinEstateResourceDetail = createServerFn({ method: 'GET' })
  .inputValidator(fetchPangolinEstateResourceDetailInput)
  .handler(async ({ data }): Promise<PangolinEstateResourceDetailDto> => {
    const { requireSession, getPangolinAdapterForConnection } = await import('@/server/admin');
    await requireSession();
    const { adapter } = await getPangolinAdapterForConnection(data.connectionId);
    const [targets, rules] = await Promise.all([
      adapter.listTargets(data.resourceId),
      adapter.listRules(data.resourceId)
    ]);
    return {
      resourceId: data.resourceId,
      targets: targets.map((target) => ({
        targetId: target.targetId,
        siteId: target.siteId,
        ip: target.ip,
        port: target.port,
        method: target.method,
        mode: target.mode,
        enabled: target.enabled,
        priority: target.priority
      })),
      rules: rules.map((rule) => ({
        ruleId: rule.ruleId,
        action: rule.action,
        match: rule.match,
        value: rule.value,
        priority: rule.priority,
        enabled: rule.enabled
      })),
      readAt: iso(new Date())
    };
  });

// ---------------------------------------------------------------------------
// "Adopt as declared resource" — the ONE new write, and it never touches Pangolin
// ---------------------------------------------------------------------------

const adoptPangolinResourceAsProxyResourceInput = z.strictObject({
  connectionId: z.uuid(),
  externalResourceId: z.string().trim().min(1),
  /** `null` = the domain's apex — every field below is sourced from the SAME live overview read the browser already rendered, never a second Pangolin call. */
  subdomain: z.string().trim().min(1).nullable(),
  mode: z.string().trim().min(1),
  ssl: z.boolean(),
  externalDomainId: z.string().trim().min(1).nullable(),
  /** Which Loxep-side `managed_domains` row this resource's domain corresponds to — Pangolin's own domain has no direct FK into Loxep's schema, so the operator confirms it. */
  domainId: z.uuid(),
  /** Which Loxep-side `hosting_targets` row actually serves this resource — a Pangolin target names an IP/port, not a Loxep hosting target, so this is not inferable either. */
  hostingTargetId: z.uuid()
});

/**
 * Turns one LIVE Pangolin resource into a declared `proxy_resources` intent
 * row — the M2 declared-intent model, entered from observation instead of
 * from the new-domain/provisioning-template forms. Writes ONLY Loxep's own
 * row via `@loxep/infrastructure`'s `ProxyResourcesService.declareFromObserved`
 * (added by this milestone, mirroring the `adoptContainerHostAsHostingTarget`
 * precedent's "record Loxep's own fact; control happens elsewhere" shape) —
 * no Pangolin call of any kind. Idempotent: adopting an already-declared
 * resource a second time is a safe no-op that changes nothing (see
 * `declareFromObserved`'s own doc).
 *
 * Admin-only, matching every other write in this feature area. Does NOT
 * enqueue a reconcile — adopting means "start controlling this from Loxep",
 * not "apply now"; the operator applies separately, from the domain or fleet
 * detail page, once ready.
 */
export const adoptPangolinResourceAsProxyResource = createServerFn({ method: 'POST' })
  .inputValidator(adoptPangolinResourceAsProxyResourceInput)
  .handler(async ({ data }): Promise<{ proxyResourceId: string; created: boolean }> => {
    const { requireAdmin, getAdminServices } = await import('@/server/admin');
    const session = await requireAdmin();
    const { proxyResources } = getAdminServices();
    return proxyResources.declareFromObserved({
      domainId: data.domainId,
      hostingTargetId: data.hostingTargetId,
      subdomain: data.subdomain,
      mode: data.mode,
      ssl: data.ssl,
      externalDomainId: data.externalDomainId,
      externalResourceId: data.externalResourceId,
      createdByUserId: session.user.id
    });
  });
