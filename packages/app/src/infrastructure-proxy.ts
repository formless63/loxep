/**
 * `infrastructure.sync-proxy-resource` — composition-root wiring for the
 * Pangolin chain design's milestone 2 (`loxep-acj.2`). Lands the reserved
 * contract `@loxep/infrastructure/tasks.ts` has carried since Phase 7
 * milestone 3: this is the module `registry.ts`'s own doc comment named as
 * "follow-up work once [`@loxep/integration-pangolin`] lands."
 *
 * `@loxep/infrastructure`'s `proxy.ts` owns the whole read -> diff -> record
 * flow and takes no dependency on `@loxep/integration-pangolin`; this module
 * is the one place that holds both. Two things happen here that `proxy.ts`
 * cannot do for itself:
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
 *      pattern, applied to a port whose real adapter has NO write verb at
 *      all yet (see `proxyProviderPortFromPangolinAdapter`'s own doc).
 *
 * ## CHECK MODE ONLY — this file changes nothing about that
 *
 * `proxy.ts`'s service refuses `mode: 'apply'` unconditionally this
 * milestone. This module does not try to work around that, override it, or
 * hide it — `payload.mode` is passed straight through, so a stray `apply`
 * request fails LOUDLY (a thrown `ProxyWritePolicyError`, a failed job) in
 * the executor's own process, rather than a task-level default silently
 * downgrading it and hiding a caller's mistake.
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
  ProxyProviderCapabilities,
  ProxyProviderPort,
  ReconcileProxyResourceResult,
  ResponseRedactor,
} from "@loxep/infrastructure";
import type { PangolinAdapter } from "@loxep/integration-pangolin";
import { z } from "zod";
import type { AppServices } from "./services.ts";

/**
 * The slice of the real {@link PangolinAdapter} the port wrapper consumes —
 * the `fleet.ts` `ContainerHostAdapterLike` `Pick` precedent, applied here.
 * If the Pangolin adapter's `listResources`/`listTargets`/`listRules`/
 * `capabilities` drift from what `@loxep/infrastructure`'s port expects, the
 * wrapper below stops compiling and the assignability test in this
 * package's suite fails.
 */
export type ProxyPangolinAdapterLike = Pick<
  PangolinAdapter,
  "listResources" | "listTargets" | "listRules" | "capabilities"
>;

function toExternalId(value: number | string | null): string | null {
  if (value === null) return null;
  return String(value);
}

/**
 * Adapt a {@link PangolinAdapter} to `@loxep/infrastructure`'s
 * `ProxyProviderPort`.
 *
 * ## `apply()` exists on the type and THROWS on every call
 *
 * `@loxep/integration-pangolin` shipped READ ONLY in milestone 1 — there is
 * no write verb anywhere in its exported surface, structurally, not as a
 * policy choice this wrapper enforces. `proxy.ts`'s service never calls
 * `apply()` in this milestone (`assertCheckModeOnly` refuses `mode:
 * 'apply'` before any provider call), so this member exists only to satisfy
 * the port's shape; calling it is a programming error in THIS milestone; a
 * later write milestone replaces this whole function's `apply` branch once
 * the adapter package grows write verbs and the write-authorization gate
 * (`loxep-acj.3`) exists to gate them.
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
    async apply() {
      throw new Error(
        "pangolin: no write verb exists in @loxep/integration-pangolin yet (milestone 1 shipped read-only) — proxy.ts's service should never reach this call in loxep-acj.2 (M2, check-mode only)",
      );
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
 * Resolves the `ProxyProviderPort` (plus the org id `read()` needs) implied
 * by one `hosting_targets` row's `proxy_connection_id`. `null` when the
 * target has no linked connection — `proxy.ts`'s `reconcileDomain` records
 * that as `skipped`, never a failure — or when the connection's config
 * carries no resolvable org id (a root-scoped key spanning several orgs; M2
 * has no per-resource org override, so it cannot pick one automatically).
 */
export async function resolveProxyProviderForHostingTarget(
  services: AppServices,
  hostingTargetId: string,
): Promise<{ provider: ProxyProviderPort; orgId: string } | null> {
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

  const { adapter, orgId } = await services.getPangolinAdapterForConnection(
    target.proxyConnectionId,
  );
  if (orgId === null) return null;
  return { provider: proxyProviderPortFromPangolinAdapter(adapter), orgId };
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
      // `mode` is passed straight through — see the module doc's "CHECK MODE
      // ONLY" section for why this executor never overrides it.
      const results: ReconcileProxyResourceResult[] =
        await proxyResources.reconcileDomain(payload.domainId, {
          mode: payload.mode ?? "check",
          trigger: payload.trigger ?? "manual",
          resolveProvider: (hostingTargetId) =>
            resolveProxyProviderForHostingTarget(services, hostingTargetId),
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
