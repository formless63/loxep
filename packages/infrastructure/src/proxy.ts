/**
 * The proxy resource reconciler (Pangolin chain design, milestone 2,
 * `loxep-acj.2`): driving `planProxyResourceOperations` (`proxy-port.ts`)
 * against a real provider port, in CHECK MODE ONLY.
 *
 * ```text
 * reconcile        one `proxy_resources` row     read -> diff -> record,
 *                                                  modelled on
 *                                                  `container-hosts.ts`'s
 *                                                  `reconcile()`, NOT on
 *                                                  `sync.ts`'s
 *                                                  `runRecordSync`
 * reconcileDomain  every resource for a domain    the `infrastructure.
 *                                                  sync-proxy-resource`
 *                                                  payload's `{domainId}`
 *                                                  fans out to one
 *                                                  `reconcile()` call per
 *                                                  resource
 * ```
 *
 * ## Why this file takes NO `@loxep/integration-pangolin` dependency
 *
 * Same rule `proxy-port.ts`'s own module doc states: the port is re-declared
 * structurally, and the composition root (`@loxep/app`) holds both this
 * service and the real adapter, passing a `ProxyProviderPort` in per call.
 *
 * ## Modelled on `container-hosts.ts`, NOT `sync.ts` — the design says so explicitly
 *
 * `reconcile()` takes the port as an ARGUMENT, resolved PER SUBJECT — never
 * an installation-wide constructor option. `createRecordSyncService`'s single
 * `provider` constructor field is the wrong shape here: a Pangolin resource
 * can belong to ANY of several instances (N base URLs, N keys — the design's
 * "multi-instance is already solved" section), and copying the
 * installation-wide shape "compiles fine and only fails when the second
 * instance is added." A reviewer should check for this specifically.
 *
 * ## CHECK MODE ONLY, structurally enforced at the TOP of `reconcile()`
 *
 * `proxy-port.ts`'s `ProxyProviderPort.apply()` is a real method — a future
 * write milestone's adapter implements it for real — but THIS service never
 * calls it. `reconcile()` and `reconcileDomain()` both throw
 * {@link ProxyWritePolicyError} immediately if `options.mode === 'apply'`,
 * before any read, any database write, or any run row. The message names the
 * gate that does not exist yet (`infrastructure.provider_write_policy`,
 * milestone 3 / `loxep-acj.3`) rather than presenting as a generic
 * validation failure — the Pangolin chain design's own write-risk model rule:
 * *"turns 'the call will fail with auth after we have already decided to
 * make it' into 'we refuse before the call and say why'."* The refusal is
 * unconditional in this milestone: there is no flag, setting, or trigger that
 * bypasses it, because the gate that would make an apply safe (per-connection
 * write policy, the four tiers, the self-lockout preflight) has not shipped.
 *
 * ## The subject is the RESOURCE, not the domain
 *
 * `reconcile_runs.subject_type = 'proxy_resource'`, `subject_id =
 * proxy_resources.id` — one run per resource, exactly the granularity
 * `hosting_target` already uses for the container-host reconciler. A domain
 * may own several resources (one per subdomain); each gets its own run and
 * its own evidence trail. `SYNC_PROXY_RESOURCE_TASK`'s reserved payload
 * carries only `domainId` (Configuration & Secrets rule 1: no connection id,
 * no credential), so `reconcileDomain()` is the fan-out point — it loads
 * every `proxy_resources` row for the domain and calls `reconcile()` once per
 * row, resolving each row's provider independently via the injected
 * `resolveProvider` (keyed by THAT row's `hosting_target_id`, per the
 * multi-instance note above).
 *
 * ## `unmatchedObserved` is recorded, never turned into drift to correct
 *
 * No `proxy_drift_findings` table — the design's own resolution of open
 * question 8: *"ride the plan, following `ContainerHostPlan.unmatchedObserved`
 * — the newest precedent, and the one that ships no drift table."* The
 * `reconcile_run_steps` diff step's `responseSummary` carries the count and a
 * bounded sample, exactly as `container-hosts.ts`'s own diff step does.
 *
 * ## No `provider_operations` ledger entries — nothing here ever creates anything
 *
 * The ledger exists to make a NON-IDEMPOTENT PROVIDER CREATE safe under
 * at-least-once delivery. This service never calls `provider.apply()`, so
 * there is nothing to ledger. A later write milestone adds it, following
 * `container-hosts.ts`'s "host creation is the ledger's IDEAL case" precedent
 * for `create-resource`.
 */
import type { LoxepDb } from "@loxep/db";
import {
  managedDomains,
  proxyResourceRules,
  proxyResources,
  reconcileRunSteps,
  reconcileRuns,
} from "@loxep/db/schema";
import { and, asc, eq } from "drizzle-orm";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  ProviderCallError,
} from "./errors.ts";
import type { ResponseRedactor } from "./port.ts";
import {
  planProxyResourceOperations,
  type DesiredProxyResource,
  type DesiredProxyRule,
  type ObservedProxyResource,
  type ProxyProviderPort,
} from "./proxy-port.ts";

export type ProxyResourceRow = typeof proxyResources.$inferSelect;
export type ProxyResourceRuleRow = typeof proxyResourceRules.$inferSelect;
export type ReconcileRunRow = typeof reconcileRuns.$inferSelect;

/** `reconcile_runs.kind` for this task. */
export const RECONCILE_PROXY_RESOURCE_RUN_KIND = "reconcile-proxy-resource";

/** `reconcile_runs.subject_type` for this reconciler — see the module doc. */
export const PROXY_RESOURCE_SUBJECT_TYPE = "proxy_resource";

/**
 * A `mode: 'apply'` reconcile was requested before the write-authorization
 * gate exists. See the module doc's "CHECK MODE ONLY" section.
 */
export class ProxyWritePolicyError extends InfrastructureValidationError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, detail);
    this.name = "ProxyWritePolicyError";
  }
}

function assertCheckModeOnly(mode: "apply" | "check"): void {
  if (mode === "apply") {
    throw new ProxyWritePolicyError(
      "proxy resource reconcile is check-mode only in this milestone (loxep-acj.2, M2 of the Pangolin chain design) — the write-authorization gate (infrastructure.provider_write_policy, the four tiers, the self-lockout preflight) has not shipped yet. Nothing may write to a Pangolin connection until milestone 3 (loxep-acj.3) lands it.",
    );
  }
}

function errorKind(error: unknown): string {
  return error instanceof Error && "kind" in error
    ? String((error as { kind: unknown }).kind)
    : "provider_unavailable";
}

/**
 * The SAFE fallback redactor. The composition root should still inject
 * Pangolin's own allow-list redactors (`redactPangolinResource`/
 * `redactPangolinRule`) for richer summaries — this default exists so a
 * caller that forgets degrades to a redacted (never leaking) scalar-only
 * summary, mirroring `container-hosts.ts`'s own default.
 */
const defaultProxyRedactor: ResponseRedactor = (value) => {
  if (typeof value !== "object" || value === null) return { value: null };
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      entry === null
    ) {
      out[key] = entry;
    }
  }
  return out;
};

export interface ReconcileProxyResourceResult {
  proxyResourceId: string;
  /** `null` when nothing ran — see `reconcile()`'s "skipped" cases. */
  runId: string | null;
  status: "skipped" | "succeeded" | "failed";
  mode: "check";
  operationCount: number;
  unmatchedObservedCount: number;
}

export interface ProxyResourcesService {
  /**
   * Reconciles ONE proxy resource against a resolved provider port. Always
   * check mode — see the module doc.
   */
  reconcile(
    proxyResourceId: string,
    options: {
      mode: "apply" | "check";
      trigger: "intent_change" | "manual" | "poll";
      /** Resolved by the caller — see `proxy-port.ts`'s "takes a SUBJECT" note. */
      provider: ProxyProviderPort;
      orgId: string;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
    },
  ): Promise<ReconcileProxyResourceResult>;
  /**
   * Fans out to `reconcile()` once per `proxy_resources` row belonging to
   * `domainId` — the `SYNC_PROXY_RESOURCE_TASK` payload's own granularity.
   * `resolveProvider` returning `null` for a resource (its hosting target has
   * no `proxy_connection_id`) is recorded as `skipped`, never an error.
   */
  reconcileDomain(
    domainId: string,
    options: {
      mode: "apply" | "check";
      trigger: "intent_change" | "manual" | "poll";
      resolveProvider: (
        hostingTargetId: string,
      ) => Promise<{ provider: ProxyProviderPort; orgId: string } | null>;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
    },
  ): Promise<ReconcileProxyResourceResult[]>;
  /** Every declared resource for a domain, with its rule-set intent. */
  listResourcesForDomain(
    domainId: string,
  ): Promise<Array<{ resource: ProxyResourceRow; rules: ProxyResourceRuleRow[] }>>;
  /** Every declared resource fronted BY one hosting target — the fleet-detail chain read. */
  listResourcesForHostingTarget(
    hostingTargetId: string,
  ): Promise<Array<{ resource: ProxyResourceRow; rules: ProxyResourceRuleRow[] }>>;
  listRuns(proxyResourceId: string): Promise<ReconcileRunRow[]>;
}

function buildDesired(
  resource: ProxyResourceRow,
  domainName: string,
  rules: ProxyResourceRuleRow[],
): DesiredProxyResource {
  const fullDomain =
    resource.subdomain === null
      ? domainName
      : `${resource.subdomain}.${domainName}`;

  const desiredRules: DesiredProxyRule[] = rules.map((rule) => ({
    externalRuleId: rule.externalRuleId,
    action: rule.action,
    match: rule.match,
    value: rule.value,
    priority: rule.priority,
    enabled: rule.enabled,
    // Closed set validated by the `proxy_resource_rules_owner_check`
    // constraint; the cast is a plain narrowing, not a trust boundary.
    owner: rule.owner as DesiredProxyRule["owner"],
  }));

  return {
    proxyResourceId: resource.id,
    hostingTargetId: resource.hostingTargetId,
    domainId: resource.domainId,
    externalDomainId: resource.externalDomainId,
    fullDomain,
    subdomain: resource.subdomain,
    mode: resource.mode,
    proxyPort: resource.proxyPort,
    ssl: resource.ssl,
    enabled: resource.enabled,
    externalResourceId: resource.externalResourceId,
    // No `proxy_resource_targets` intent table exists yet — see
    // `proxy-port.ts`'s planner doc for why an unmatched desired resource
    // gets only a `create-resource` operation regardless. Targets stay
    // empty until a later milestone models per-target intent.
    targets: [],
    rules: desiredRules,
  };
}

export function createProxyResourcesService(options: {
  db: LoxepDb;
}): ProxyResourcesService {
  const { db } = options;

  async function requireResource(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<ProxyResourceRow> {
    const rows = await executor
      .select()
      .from(proxyResources)
      .where(eq(proxyResources.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`proxy resource ${id} not found`, {
        id,
      });
    }
    return row;
  }

  async function loadRules(
    executor: Pick<LoxepDb, "select">,
    proxyResourceId: string,
  ): Promise<ProxyResourceRuleRow[]> {
    return executor
      .select()
      .from(proxyResourceRules)
      .where(eq(proxyResourceRules.proxyResourceId, proxyResourceId));
  }

  async function requireDomainName(
    executor: Pick<LoxepDb, "select">,
    domainId: string,
  ): Promise<string> {
    const rows = await executor
      .select({ name: managedDomains.name })
      .from(managedDomains)
      .where(eq(managedDomains.id, domainId));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(
        `managed domain ${domainId} not found`,
        { domainId },
      );
    }
    return row.name;
  }

  /**
   * Writes the provider's id into the row the first time a check-mode plan
   * matches by `fullDomain` (no id known yet) — the same self-retiring
   * bootstrap `container-hosts.ts`'s `selfRetireIdentity` performs, applied
   * here in check mode too, because the write is to Loxep's OWN row, not to
   * Pangolin. Best-effort: a failure here does not fail the run.
   */
  async function selfRetireIdentity(
    proxyResourceId: string,
    externalResourceId: string,
  ): Promise<void> {
    try {
      await db
        .update(proxyResources)
        .set({ externalResourceId, updatedAt: new Date() })
        .where(eq(proxyResources.id, proxyResourceId));
    } catch {
      // See doc above — swallowed on purpose.
    }
  }

  async function reconcile(
    proxyResourceId: string,
    reconcileOptions: {
      mode: "apply" | "check";
      trigger: "intent_change" | "manual" | "poll";
      provider: ProxyProviderPort;
      orgId: string;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
    },
  ): Promise<ReconcileProxyResourceResult> {
    assertCheckModeOnly(reconcileOptions.mode);
    const redact = reconcileOptions.redact ?? defaultProxyRedactor;

    const resource = await requireResource(db, proxyResourceId);
    const rules = await loadRules(db, proxyResourceId);
    const domainName = await requireDomainName(db, resource.domainId);
    const desired = buildDesired(resource, domainName, rules);

    const runRows = await db
      .insert(reconcileRuns)
      .values({
        kind: RECONCILE_PROXY_RESOURCE_RUN_KIND,
        subjectType: PROXY_RESOURCE_SUBJECT_TYPE,
        subjectId: proxyResourceId,
        mode: "check",
        trigger: reconcileOptions.trigger,
        actorUserId: reconcileOptions.actorUserId ?? null,
      })
      .returning();
    const run = runRows[0];
    if (run === undefined) throw new Error("reconcile run insert returned no row");

    let sequence = 0;
    const step = async (entry: {
      step: string;
      status: "succeeded" | "failed" | "skipped";
      requestSummary?: Record<string, unknown> | null;
      responseSummary?: Record<string, unknown> | null;
      errorCode?: string | null;
      errorDetail?: string | null;
    }): Promise<void> => {
      await db.insert(reconcileRunSteps).values({
        runId: run.id,
        sequence: sequence++,
        step: entry.step,
        status: entry.status,
        provider: "pangolin",
        requestSummary: entry.requestSummary ?? null,
        responseSummary: entry.responseSummary ?? null,
        errorCode: entry.errorCode ?? null,
        errorDetail: entry.errorDetail ?? null,
      });
    };
    const finish = async (
      status: "succeeded" | "failed",
      errorSummary: string | null,
    ): Promise<void> => {
      await db
        .update(reconcileRuns)
        .set({ status, finishedAt: new Date(), stepCount: sequence, errorSummary })
        .where(eq(reconcileRuns.id, run.id));
    };

    let observed: ObservedProxyResource[];
    try {
      observed = await reconcileOptions.provider.read({
        orgId: reconcileOptions.orgId,
      });
    } catch (error) {
      const kind = errorKind(error);
      await step({
        step: "read-provider",
        status: "failed",
        errorCode: kind,
        errorDetail: "pangolin resource read failed",
      });
      await finish("failed", `provider read failed (${kind})`);
      if (error instanceof ProviderCallError) throw error;
      throw new ProviderCallError(kind, "pangolin resource read failed", {
        proxyResourceId,
        runId: run.id,
      });
    }
    await step({
      step: "read-provider",
      status: "succeeded",
      requestSummary: { operation: "proxy_resource.list", orgId: reconcileOptions.orgId },
      responseSummary: { observed: observed.length },
    });

    const plan = planProxyResourceOperations({ desired: [desired], observed });
    await step({
      step: "diff",
      status: "succeeded",
      responseSummary: {
        operations: plan.operations.length,
        unmatchedObservedCount: plan.unmatchedObserved.length,
        // A bounded sample only — never the whole inventory in a run step.
        // Passed through the caller's redactor even though nothing in
        // `ObservedProxyResource` carries secret material (the port's own
        // rule): the boundary discipline is "every provider-observed value
        // passes through an allow-list redactor", not "only when something
        // is actually secret".
        unmatchedObservedSample: plan.unmatchedObserved
          .slice(0, 10)
          .map((r) => redact(r)),
      },
    });

    // Self-retire the bootstrap id the moment a check matches by
    // `fullDomain` — see `selfRetireIdentity`'s doc.
    if (resource.externalResourceId === null) {
      const matchedByFullDomain = observed.find(
        (r) => r.fullDomain === desired.fullDomain,
      );
      if (matchedByFullDomain !== undefined) {
        await selfRetireIdentity(
          proxyResourceId,
          matchedByFullDomain.externalResourceId,
        );
      }
    }

    // Check mode only, structurally — see the module doc.
    await step({ step: "apply.skipped-check-mode", status: "skipped" });

    await finish("succeeded", null);
    return {
      proxyResourceId,
      runId: run.id,
      status: "succeeded",
      mode: "check",
      operationCount: plan.operations.length,
      unmatchedObservedCount: plan.unmatchedObserved.length,
    };
  }

  async function reconcileDomain(
    domainId: string,
    domainOptions: {
      mode: "apply" | "check";
      trigger: "intent_change" | "manual" | "poll";
      resolveProvider: (
        hostingTargetId: string,
      ) => Promise<{ provider: ProxyProviderPort; orgId: string } | null>;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
    },
  ): Promise<ReconcileProxyResourceResult[]> {
    assertCheckModeOnly(domainOptions.mode);

    const resources = await db
      .select()
      .from(proxyResources)
      .where(eq(proxyResources.domainId, domainId))
      .orderBy(asc(proxyResources.createdAt));

    const results: ReconcileProxyResourceResult[] = [];
    for (const resource of resources) {
      const resolved = await domainOptions.resolveProvider(
        resource.hostingTargetId,
      );
      if (resolved === null) {
        results.push({
          proxyResourceId: resource.id,
          runId: null,
          status: "skipped",
          mode: "check",
          operationCount: 0,
          unmatchedObservedCount: 0,
        });
        continue;
      }
      const result = await reconcile(resource.id, {
        mode: domainOptions.mode,
        trigger: domainOptions.trigger,
        provider: resolved.provider,
        orgId: resolved.orgId,
        actorUserId: domainOptions.actorUserId ?? null,
        ...(domainOptions.redact !== undefined
          ? { redact: domainOptions.redact }
          : {}),
      });
      results.push(result);
    }
    return results;
  }

  async function listResourcesForDomain(
    domainId: string,
  ): Promise<Array<{ resource: ProxyResourceRow; rules: ProxyResourceRuleRow[] }>> {
    const resources = await db
      .select()
      .from(proxyResources)
      .where(eq(proxyResources.domainId, domainId))
      .orderBy(asc(proxyResources.createdAt));
    const results: Array<{ resource: ProxyResourceRow; rules: ProxyResourceRuleRow[] }> =
      [];
    for (const resource of resources) {
      results.push({ resource, rules: await loadRules(db, resource.id) });
    }
    return results;
  }

  async function listResourcesForHostingTarget(
    hostingTargetId: string,
  ): Promise<Array<{ resource: ProxyResourceRow; rules: ProxyResourceRuleRow[] }>> {
    const resources = await db
      .select()
      .from(proxyResources)
      .where(eq(proxyResources.hostingTargetId, hostingTargetId))
      .orderBy(asc(proxyResources.createdAt));
    const results: Array<{ resource: ProxyResourceRow; rules: ProxyResourceRuleRow[] }> =
      [];
    for (const resource of resources) {
      results.push({ resource, rules: await loadRules(db, resource.id) });
    }
    return results;
  }

  async function listRuns(proxyResourceId: string): Promise<ReconcileRunRow[]> {
    return db
      .select()
      .from(reconcileRuns)
      .where(
        and(
          eq(reconcileRuns.subjectType, PROXY_RESOURCE_SUBJECT_TYPE),
          eq(reconcileRuns.subjectId, proxyResourceId),
          eq(reconcileRuns.kind, RECONCILE_PROXY_RESOURCE_RUN_KIND),
        ),
      );
  }

  return {
    reconcile,
    reconcileDomain,
    listResourcesForDomain,
    listResourcesForHostingTarget,
    listRuns,
  };
}
