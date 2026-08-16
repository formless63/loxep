/**
 * `infrastructure.sync-proxy-resource` — composition-root wiring for the
 * Pangolin chain design. Milestone 2 (`loxep-acj.2`) landed the reserved
 * contract `@loxep/infrastructure/tasks.ts` has carried since Phase 7
 * milestone 3, check-mode only. Milestone 4 (`loxep-acj.4`) wires the real
 * apply leg: `proxyProviderPortFromPangolinAdapter`'s `apply()` now
 * dispatches to the adapter's three tier-1 writes, and this module resolves
 * the per-connection write-authorization context `proxy.ts` requires before
 * it will attempt one.
 *
 * `@loxep/infrastructure`'s `proxy.ts` owns the whole read -> diff -> record
 * (-> apply) flow and takes no dependency on `@loxep/integration-pangolin`;
 * this module is the one place that holds both. Three things happen here
 * that `proxy.ts` cannot do for itself:
 *
 *   1. resolve, for ONE `proxy_resources` row, WHICH Pangolin connection to
 *      reconcile against — read off that row's `hosting_target_id`'s own
 *      `hosting_targets.proxy_connection_id`, the column this milestone
 *      finally drives ("dormant since migration `0012`" until now);
 *   2. build the real `ProxyProviderPort` from that connection's cached
 *      `PangolinAdapter` (`proxyProviderPortFromPangolinAdapter`, wrapping
 *      `services.getPangolinAdapterForConnection`) — next to
 *      `mailProviderPortFromPurelymailAdapter` in spirit: the same
 *      "structurally compatible by design, so this is a thin forward"
 *      pattern;
 *   3. resolve that SAME connection's stored write-authorization tier
 *      (`resolveProxyWriteAuthorization`, reading `@loxep/domain`'s
 *      `infrastructure.provider_write_policy` setting) plus the two
 *      self-managed-resource host lists `write-policy.ts`'s `wouldLockOut`
 *      needs — `proxy.ts` never reads a setting or resolves a connection
 *      itself, matching every other reconciler's "caller resolves, service
 *      enforces" split.
 *
 * ## `mode`/`trigger` are still passed straight through, unconditionally
 *
 * `payload.mode` and `payload.trigger` reach `proxy.ts` untouched — a stray
 * `apply` request still fails LOUDLY there (a thrown `ProxyWritePolicyError`
 * for a `'poll'` trigger, a `'blocked'` step for a `read_only` policy tier)
 * rather than a task-level default silently downgrading or approving it.
 *
 * ## No recurring poll-executor route in THIS milestone, and that is deliberate
 *
 * `RECONCILE_CONTAINER_HOST_TASK`'s own precedent: hb7 Milestone C shipped
 * the reconciler task with `trigger ∈ {intent_change, manual, poll}` but NO
 * `monitor_targets` registration and no cron item — a recurring drift
 * cadence (Milestone D) was a LATER, separate change that piggybacked on
 * `health.sweep` once the base reconciler existed. This module follows that
 * same sequencing: `infrastructure.sync-proxy-resource` is registered here,
 * for real, with a `poll` trigger already in its payload type for a future
 * cadence to use — but M2 ships no authoring UI for `proxy_resources`
 * intent at all (visibility only, per the Pangolin chain design's own
 * milestone table), so a periodic sweep over rows that do not yet exist in
 * any real installation is deferred rather than built speculatively. Wiring
 * a `proxy_resource` monitor target type is follow-up work for whichever
 * milestone adds the intent-authoring surface.
 */
import { defineTask } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import {
  SYNC_PROXY_RESOURCE_TASK,
  createHostingTargetsService,
  createProxyResourcesService,
} from "@loxep/infrastructure";
import type {
  ObservedProxyResource,
  ProxyApplyResult,
  ProxyOperation,
  ProxyProviderCapabilities,
  ProxyProviderPort,
  ProxyWriteAuthorizationContext,
  ReconcileProxyResourceResult,
  ResponseRedactor,
} from "@loxep/infrastructure";
import { providerWritePolicySetting, resolveProviderWritePolicy } from "@loxep/domain";
import type { PangolinAdapter } from "@loxep/integration-pangolin";
import { z } from "zod";
import type { AppServices } from "./services.ts";

/**
 * The slice of the real {@link PangolinAdapter} the port wrapper consumes —
 * the `fleet.ts` `ContainerHostAdapterLike` `Pick` precedent, applied here.
 * If the Pangolin adapter's read OR write surface drifts from what
 * `@loxep/infrastructure`'s port expects, the wrapper below stops compiling
 * and the assignability test in this package's suite fails.
 */
export type ProxyPangolinAdapterLike = Pick<
  PangolinAdapter,
  | "listResources"
  | "listTargets"
  | "listRules"
  | "capabilities"
  | "createResource"
  | "addTarget"
  | "createRule"
>;

function toExternalId(value: number | string | null): string | null {
  if (value === null) return null;
  return String(value);
}

/**
 * Adapt a {@link PangolinAdapter} to `@loxep/infrastructure`'s
 * `ProxyProviderPort`.
 *
 * ## `apply()` dispatches to the adapter's three tier-1 writes — and ONLY those
 *
 * `orgId` is captured in this closure (resolved once, per connection, by
 * `resolveProxyProviderForHostingTarget`) rather than threaded through
 * `ProxyOperation` itself — the port's `create-resource` operation carries
 * Pangolin's own `domainId` but no `orgId`, because `read(subject)` is the
 * only member with a subject to take one from. `createResource` needs it
 * anyway (`PUT /org/{orgId}/resource`), so this wrapper is where that gap
 * closes. `update-resource`/`update-target`/`update-rule` throw a clear
 * "not implemented this milestone" error: `proxy.ts`'s own service never
 * applies a tier-2 operation in M4 (`loxep-acj.4` — bd's own NOT IN SCOPE
 * list), so these branches exist only to satisfy the port's closed union,
 * exactly the way `container-hosts.ts`'s own unreachable branches do.
 *
 * ## `read()` fans out per resource, exactly as the port's module doc predicts
 *
 * `listResources(orgId)` returns the org's resource list; this wrapper then
 * calls `listTargets`/`listRules` once per resource with a resolvable
 * numeric id, assembling the nested `ObservedProxyResource` shape
 * `proxy-port.ts` expects. A resource with no numeric `resourceId` (should
 * not occur against a real instance, but the adapter's own facts are
 * deliberately permissive per its "UNVERIFIED-and-therefore-optional" rule)
 * is excluded rather than guessed at — the same "an unresolvable identity is
 * dropped, never faked" discipline the rest of this file follows.
 */
export function proxyProviderPortFromPangolinAdapter(
  adapter: ProxyPangolinAdapterLike,
  /** Resolved once per connection — see this function's own doc for why `apply()` needs it and `ProxyOperation` cannot carry it. `null` when the connection has no resolvable org id; `apply()` refuses in that case rather than guessing. */
  orgId: string | null = null,
): ProxyProviderPort {
  return {
    async read(subject): Promise<ObservedProxyResource[]> {
      const resources = await adapter.listResources(subject.orgId);
      const observed: ObservedProxyResource[] = [];
      for (const resource of resources) {
        const externalResourceId = toExternalId(resource.resourceId);
        if (externalResourceId === null) continue;

        const [targets, rules] = await Promise.all([
          adapter.listTargets(externalResourceId),
          adapter.listRules(externalResourceId),
        ]);

        observed.push({
          externalResourceId,
          niceId: resource.niceId,
          name: resource.name,
          fullDomain: resource.fullDomain,
          domainId: resource.domainId,
          subdomain: resource.subdomain,
          mode: resource.mode,
          // PangolinResourceFact carries no `proxyPort` field (unverified
          // against a live raw create/tcp-mode resource) — see that fact's
          // own doc. `null` here is honest absence, not a guess.
          proxyPort: null,
          ssl: resource.ssl,
          enabled: resource.enabled,
          ssoEnabled: resource.sso,
          blockAccess: resource.blockAccess,
          applyRules: resource.applyRules,
          emailWhitelistEnabled: resource.emailWhitelistEnabled,
          targets: targets
            .filter((target) => toExternalId(target.targetId) !== null)
            .map((target) => ({
              externalTargetId: toExternalId(target.targetId) as string,
              siteId: toExternalId(target.siteId),
              ip: target.ip,
              port: target.port,
              method: target.method,
              enabled: target.enabled,
              path: target.path,
              pathMatchType: target.pathMatchType,
              priority: target.priority,
            })),
          rules: rules
            .filter((rule) => toExternalId(rule.ruleId) !== null)
            .map((rule) => ({
              externalRuleId: toExternalId(rule.ruleId) as string,
              action: rule.action ?? "",
              match: rule.match ?? "",
              value: rule.value ?? "",
              priority: rule.priority ?? 0,
              enabled: rule.enabled,
            })),
        });
      }
      return observed;
    },
    async apply(operation: ProxyOperation): Promise<ProxyApplyResult> {
      switch (operation.kind) {
        case "create-resource": {
          if (orgId === null) {
            throw new Error(
              "pangolin: createResource requires a resolvable orgId for this connection — none is configured",
            );
          }
          const fact = await adapter.createResource(orgId, operation.resource);
          return {
            kind: "create-resource",
            status: "applied",
            externalResourceId: fact.resourceId === null ? undefined : String(fact.resourceId),
          };
        }
        case "create-target": {
          const fact = await adapter.addTarget(operation.externalResourceId, operation.target);
          return {
            kind: "create-target",
            status: "applied",
            externalTargetId: fact.targetId === null ? undefined : String(fact.targetId),
          };
        }
        case "create-rule": {
          const fact = await adapter.createRule(operation.externalResourceId, operation.rule);
          return {
            kind: "create-rule",
            status: "applied",
            externalRuleId: fact.ruleId === null ? undefined : String(fact.ruleId),
          };
        }
        case "update-resource":
        case "update-target":
        case "update-rule":
          // Tier 2 — no adapter verb this milestone calls; `proxy.ts` never
          // reaches this branch (it skips tier-2 operations structurally).
          // See this function's own doc.
          throw new Error(
            `pangolin: ${operation.kind} is tier 2 and not implemented in loxep-acj.4 (M4 ships tier-1 writes only) — proxy.ts's service should never reach this call`,
          );
      }
    },
    capabilities(): ProxyProviderCapabilities {
      const c = adapter.capabilities();
      return {
        provider: c.provider,
        bulkRuleSet: c.bulkRuleSet,
        ruleAliases: c.ruleAliases,
        ruleDisable: c.ruleDisable,
        domainCreate: c.domainCreate,
        siteCreate: c.siteCreate,
        ruleMatches: c.ruleMatches,
        ruleActions: c.ruleActions,
      };
    },
  };
}

/**
 * The `reconcile_run_steps` redactor for this reconciler. `proxy.ts` only
 * ever calls it on already-normalized `ObservedProxyResource` facts (never a
 * raw Pangolin envelope) — an ALLOW-LIST over the exact fields
 * `redactPangolinResource`/`redactPangolinRule` allow-list, renamed to this
 * port's own field names rather than the raw provider's.
 */
export const proxyResultRedactor: ResponseRedactor = (value) => {
  const record = (value ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | number | boolean | null => {
    const entry = record[key];
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      return entry;
    }
    return null;
  };
  return {
    externalResourceId: pick("externalResourceId"),
    niceId: pick("niceId"),
    fullDomain: pick("fullDomain"),
    mode: pick("mode"),
    enabled: pick("enabled"),
    ssoEnabled: pick("ssoEnabled"),
    emailWhitelistEnabled: pick("emailWhitelistEnabled"),
  };
};

/**
 * Resolves ONE connection's write-authorization context — the stored
 * `infrastructure.provider_write_policy` tier plus the two host lists
 * `wouldLockOut`'s self-managed-resource clauses compare a resource's
 * `fullDomain` against.
 *
 * `pangolinDashboardHosts` uses the connection's own Integration-API base
 * URL as its one entry — an honest approximation, not a guarantee: M1's own
 * reconnaissance found the Integration API is typically a DIFFERENT
 * subdomain from the dashboard the operator actually browses (`adapter.ts`'s
 * "THE RECHABILITY FINDING"), so this comparison catches the case where an
 * operator points a Pangolin connection's base URL at the same host their
 * dashboard resource fronts, but not a dashboard hosted on a genuinely
 * distinct subdomain. Closing that gap needs a dedicated "dashboard host"
 * field this milestone does not add.
 */
export async function resolveProxyWriteAuthorization(
  services: AppServices,
  input: { connectionId: string; baseUrl: string; actorIsAdmin?: boolean },
): Promise<ProxyWriteAuthorizationContext> {
  const policies = await services.settings.get(providerWritePolicySetting);
  const policyTier = resolveProviderWritePolicy(policies, input.connectionId);
  return {
    connectionId: input.connectionId,
    policyTier,
    ...(input.actorIsAdmin !== undefined ? { actorIsAdmin: input.actorIsAdmin } : {}),
    loxepSelfHosts: services.config.publicOrigin !== undefined ? [services.config.publicOrigin] : [],
    pangolinDashboardHosts: [input.baseUrl],
  };
}

/**
 * Resolves the `ProxyProviderPort` (plus the org id `read()` needs and the
 * write-authorization context an apply requires) implied by one
 * `hosting_targets` row's `proxy_connection_id`. `null` when the target has
 * no linked connection — `proxy.ts`'s `reconcileDomain` records that as
 * `skipped`, never a failure — or when the connection's config carries no
 * resolvable org id (a root-scoped key spanning several orgs; no
 * per-resource org override exists, so it cannot pick one automatically).
 *
 * `actorIsAdmin` should be `true` only when the caller KNOWS an admin
 * session originated this apply (a `'manual'`-triggered apply enqueued by a
 * `requireAdmin()`-gated server function) — `undefined` for every automated
 * trigger, matching `write-policy.ts`'s own "no human actor attached"
 * reading.
 */
export async function resolveProxyProviderForHostingTarget(
  services: AppServices,
  hostingTargetId: string,
  options: { actorIsAdmin?: boolean } = {},
): Promise<
  { provider: ProxyProviderPort; orgId: string; writeAuthorization: ProxyWriteAuthorizationContext } | null
> {
  // `createHostingTargetsService(...).get()` rather than a raw drizzle
  // query — this package has no direct `drizzle-orm` dependency (it reaches
  // the database exclusively through `@loxep/domain`/`@loxep/infrastructure`
  // service objects), and `HostingTargetsService` already exposes exactly
  // the read this needs.
  let target: { proxyConnectionId: string | null };
  try {
    target = await createHostingTargetsService({ db: services.db }).get(
      hostingTargetId,
    );
  } catch {
    return null;
  }
  if (target.proxyConnectionId === null) return null;

  const { adapter, orgId, connectionId, baseUrl } = await services.getPangolinAdapterForConnection(
    target.proxyConnectionId,
  );
  if (orgId === null) return null;
  const writeAuthorization = await resolveProxyWriteAuthorization(services, {
    connectionId,
    baseUrl,
    ...(options.actorIsAdmin !== undefined ? { actorIsAdmin: options.actorIsAdmin } : {}),
  });
  return {
    provider: proxyProviderPortFromPangolinAdapter(adapter, orgId),
    orgId,
    writeAuthorization,
  };
}

const syncProxyResourcePayloadSchema = z.object({
  domainId: z.string().uuid(),
  mode: z.enum(["apply", "check"]).optional(),
  trigger: z.enum(["intent_change", "manual", "poll"]).optional(),
});

export interface InfrastructureProxyTasks {
  syncProxyResourceTask: LoxepTask<typeof syncProxyResourcePayloadSchema>;
  tasks: readonly LoxepTask<typeof syncProxyResourcePayloadSchema>[];
}

export function createInfrastructureProxyTasks(options: {
  services: AppServices;
}): InfrastructureProxyTasks {
  const { services } = options;
  const proxyResources = createProxyResourcesService({ db: services.db });

  const syncProxyResourceTask = defineTask({
    name: SYNC_PROXY_RESOURCE_TASK,
    payloadSchema: syncProxyResourcePayloadSchema,
    handler: async (payload, { logger }) => {
      const trigger = payload.trigger ?? "manual";
      // `mode`/`trigger` are passed straight through — see the module doc's
      // "still passed straight through" section for why this executor never
      // overrides either. `actorIsAdmin: true` only for `'manual'`: only an
      // admin-gated server function may enqueue that trigger in the first
      // place (`requestProxyResourceApply`, `apps/web`), so by the time this
      // job runs, "admin-only" has already been enforced once; every other
      // trigger has no human actor attached.
      const results: ReconcileProxyResourceResult[] =
        await proxyResources.reconcileDomain(payload.domainId, {
          mode: payload.mode ?? "check",
          trigger,
          resolveProvider: (hostingTargetId) =>
            resolveProxyProviderForHostingTarget(services, hostingTargetId, {
              actorIsAdmin: trigger === "manual" ? true : undefined,
            }),
          redact: proxyResultRedactor,
        });

      logger.info(
        {
          domainId: payload.domainId,
          resourceCount: results.length,
          succeeded: results.filter((r) => r.status === "succeeded").length,
          skipped: results.filter((r) => r.status === "skipped").length,
          failed: results.filter((r) => r.status === "failed").length,
        },
        "infrastructure proxy resource reconcile complete",
      );
    },
  });

  return { syncProxyResourceTask, tasks: [syncProxyResourceTask] };
}
