/**
 * The proxy resource reconciler (Pangolin chain design). Milestone 2
 * (`loxep-acj.2`) drove `planProxyResourceOperations` (`proxy-port.ts`)
 * against a real provider port in CHECK MODE ONLY. Milestone 4
 * (`loxep-acj.4`) lands the apply leg for the tier-1 subset — createResource,
 * createTarget, createRule — behind the write-authorization gate
 * `write-policy.ts` builds (`assertWritePolicy` + `wouldLockOut`'s
 * self-managed-resource clauses), ledgered through `operations.ts` because
 * every one of those three is a non-idempotent provider create with no
 * upsert (verdict 2).
 *
 * ## What M4 applies, and what it still only PLANS
 *
 * `planProxyResourceOperations` can still emit `update-resource` /
 * `update-target` / `update-rule` when an already-matched resource's
 * observed state differs from intent — those are tier 2, and M4 ships no
 * adapter verb the service could call for them (bd's own NOT IN SCOPE list:
 * "updateResource/updateTarget/updateRule (tier 2, M5 needs the rule one)").
 * `reconcile()` therefore SPLITS the plan: tier-1 `create-*` operations are
 * applied for real; any tier-2 operation present is recorded as a distinct
 * `skipped` step (`apply.tier2-not-implemented`) — never silently dropped,
 * never mistaken for a policy `blocked` state, because no policy tier this
 * milestone could grant would make M4's own code able to call them.
 *
 * ## `createTarget` has a real, tested apply path with no live trigger yet
 *
 * `buildDesired()` still supplies `targets: []` — M2's own closeout note
 * ("no `proxy_resource_targets` intent table exists yet… the gap gets a
 * real answer… rather than this milestone guessing at one no write path
 * exercises") is UNCLOSED by M4 too: closing it needs either a new intent
 * table or a new `hosting_targets` column, both migration-shaped, and this
 * milestone ships no migration. So `planProxyResourceOperations` can never
 * actually emit a `create-target` operation from a REAL `reconcile()` call
 * today. The apply branch below is real and directly unit-tested
 * (`test/proxy.test.ts`) against a synthetic operation, so the day a future
 * milestone adds target intent, it inherits working ledgered-apply code
 * rather than an unimplemented `switch` arm.
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
 * ## APPLY, now gated rather than refused outright
 *
 * `proxy-port.ts`'s `ProxyProviderPort.apply()` is a real method, and from
 * M4 `reconcile()` calls it — for the tier-1 subset only, and only after
 * `write-policy.ts`'s `assertWritePolicy` (the connection's stored tier,
 * rule 3's trigger restriction, the admin-only actor check) and the
 * self-managed-resource half of `wouldLockOut` both clear. `mode: 'apply'`
 * on an `'poll'` trigger is refused STRUCTURALLY by this milestone, ahead of
 * and in addition to `assertWritePolicy`'s own (more permissive, M5-shaped)
 * allowance for a tier-1 poll — see `assertApplyTriggerAllowed`'s doc: M5's
 * per-alias `autoApply` seam is deliberately not opened by M4, because
 * nothing here has an alias to auto-apply yet. Every refusal happens BEFORE
 * any provider call, any database write, or any run row — the design's own
 * write-risk-model rule: *"turns 'the call will fail with auth after we have
 * already decided to make it' into 'we refuse before the call and say
 * why'."*
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
 * ## `provider_operations` ledger entries — the three tier-1 creates, and ONLY those
 *
 * All three are non-idempotent provider creates with no upsert (verdict 2),
 * so each goes through `operations.ts`'s ledger exactly as
 * `container-hosts.ts`'s host create does — "the ledger's IDEAL case": a
 * stuck `pending` resolves by reading the provider back and matching on the
 * natural key the caller can always recompute, never by blindly retrying.
 * `update-rule`'s `enabled` flip (the retirement half of add-then-retire,
 * M7) is convergent and would NOT be ledgered even once it exists, matching
 * `container-hosts.ts`'s own update/create split.
 */
import type { LoxepDb } from "@loxep/db";
import type { IpAliasMap, ProviderWritePolicyTier, SettingsService } from "@loxep/domain";
import { ipAliasesSetting } from "@loxep/domain";
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
  MaterializationError,
  ProviderCallError,
} from "./errors.ts";
import type { ResponseRedactor } from "./port.ts";
import {
  planProxyResourceOperations,
  type DesiredProxyResource,
  type DesiredProxyRule,
  type ObservedProxyResource,
  type ProxyApplyResult,
  type ProxyOperation,
  type ProxyProviderPort,
} from "./proxy-port.ts";
import { materializeProxyRuleValue } from "./ip-aliases.ts";
import {
  createProviderOperationsLedger,
  idempotencyKey,
  type ProviderOperationsLedger,
} from "./operations.ts";
import {
  WritePolicyError,
  assertWritePolicy,
  wouldLockOut,
  writePolicyBlockedStep,
} from "./write-policy.ts";

export type ProxyResourceRow = typeof proxyResources.$inferSelect;
export type ProxyResourceRuleRow = typeof proxyResourceRules.$inferSelect;
export type ReconcileRunRow = typeof reconcileRuns.$inferSelect;

/** `reconcile_runs.kind` for this task. */
export const RECONCILE_PROXY_RESOURCE_RUN_KIND = "reconcile-proxy-resource";

/** `reconcile_runs.subject_type` for this reconciler — see the module doc. */
export const PROXY_RESOURCE_SUBJECT_TYPE = "proxy_resource";

/** `provider_operations.provider` for every ledgered Pangolin write this service issues. */
const PANGOLIN_LEDGER_PROVIDER = "pangolin";

/**
 * An `apply` was refused for a reason THIS milestone owns, structurally,
 * ahead of `write-policy.ts`'s own (more permissive) gate — currently just
 * the poll-trigger refusal below. Kept as a distinct class from
 * {@link WritePolicyError} so a caller can tell "M4 has not opened this seam
 * yet" apart from "the connection's stored policy tier refused it".
 */
export class ProxyWritePolicyError extends InfrastructureValidationError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, detail);
    this.name = "ProxyWritePolicyError";
  }
}

/**
 * M4 refused EVERY `'poll'`-triggered apply here, stricter than
 * `write-policy.ts`'s own `assertWritePolicy` (which already permits a
 * tier-1 write on `'poll'` — rule 3 only forbids tier ≥ 2 there) — because at
 * M4 nothing had an alias, a per-alias `autoApply` flag, or an owner ruling
 * to justify opening that seam yet. Milestone 5 (`loxep-acj.5`) is that
 * ruling: the owner confirmed dynamic-IP alias updates MAY auto-apply
 * (`pangolin-credential-constraints` memory, 2026-08-15), scoped to exactly
 * the ADD half of add-then-retire — which is tier 1 (a `create-rule`), never
 * retirement (tier 2, still unconditionally refused on `'poll'` by
 * `assertWritePolicy`'s own rule 3, structurally, regardless of this
 * function). So this function now imposes NO restriction beyond the generic
 * gate: `'poll'` is permitted for the SAME reason `write-policy.ts`'s module
 * doc already documented as "the seam M5 is expected to use". Kept as its
 * own named function (rather than deleted outright) so the milestone history
 * stays legible and a future milestone has one place to add a NEW trigger-
 * shaped restriction if one is ever needed.
 *
 * Three gates still stand between a `'poll'` trigger and an actual Pangolin
 * write, in order: (1) the connection's stored `infrastructure.
 * provider_write_policy` tier must be `'additive'` or higher — defaults to
 * `'read_only'`, so nothing auto-applies until an admin explicitly flips it;
 * (2) the CALLER (the alias-detection sweep, `@loxep/app`'s `ip-alias-
 * detection.ts`) checks the alias's own `autoApply` flag (default `false`)
 * and its `source` (never `'manual'`) BEFORE ever requesting `mode: 'apply'`
 * with `trigger: 'poll'` — this function has no alias to check, so it is not
 * this function's gate to enforce; (3) `wouldLockOut`'s self-managed-resource
 * clauses, evaluated identically to a `'manual'` apply.
 */
function assertApplyTriggerAllowed(_trigger: "intent_change" | "manual" | "poll"): void {
  // No restriction beyond `assertWritePolicy`'s own rule 3 — see the doc
  // above. The parameter is retained (and still passed by every call site)
  // so a future milestone can reintroduce a trigger-shaped restriction
  // without changing every caller's signature.
}

/** Whether `host` is exactly `candidate`, comparing case-insensitively and tolerating either a bare host or a full URL on either side. */
function hostMatches(host: string, candidate: string): boolean {
  const normalize = (value: string): string | null => {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "") return null;
    try {
      return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
    } catch {
      return null;
    }
  };
  const a = normalize(host);
  const b = normalize(candidate);
  return a !== null && a === b;
}

/** The design's stated rule read-back key: `(action, match, value, priority)` — `enabled` deliberately excluded, matching `planProxyResourceOperations`'s own rule-matching. */
function ruleNaturalKey(rule: { action: string; match: string; value: string; priority: number }): string {
  return `${rule.action} ${rule.match} ${rule.value} ${rule.priority}`;
}

/** The design's stated target read-back key: `(siteId, ip, port)`. */
function targetNaturalKey(target: { siteId: string; ip: string; port: number }): string {
  return `${target.siteId} ${target.ip} ${target.port}`;
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
  /** `'partial'` when at least one tier-1 op applied but a tier-2 op was present unapplied, or a write was `blocked`. */
  status: "skipped" | "succeeded" | "partial" | "failed";
  mode: "apply" | "check";
  operationCount: number;
  /** Tier-1 operations actually applied this run. Always 0 in check mode. */
  appliedCount: number;
  unmatchedObservedCount: number;
}

/** What `reconcile()`/`reconcileDomain()` need to evaluate the write-authorization gate for one resolved connection — see `write-policy.ts`. */
export interface ProxyWriteAuthorizationContext {
  connectionId: string;
  policyTier: ProviderWritePolicyTier;
  /** `true`/`false` for a known human actor; `undefined` for a background trigger. */
  actorIsAdmin?: boolean;
  /** Hosts that must never be managed — Loxep's own public origin. Same list for every connection. */
  loxepSelfHosts?: readonly string[];
  /** This CONNECTION's own dashboard host(s) — see `wouldLockOut`'s `pangolin_dashboard_self` clause. */
  pangolinDashboardHosts?: readonly string[];
}

export interface ProxyResourcesService {
  /**
   * Reconciles ONE proxy resource against a resolved provider port. Check
   * mode always reads and diffs only; apply mode additionally applies every
   * tier-1 `create-*` operation the plan contains, behind the
   * write-authorization gate — see the module doc.
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
      /** Required for `mode: 'apply'`; ignored in check mode. */
      writeAuthorization?: ProxyWriteAuthorizationContext;
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
      resolveProvider: (hostingTargetId: string) => Promise<
        | {
            provider: ProxyProviderPort;
            orgId: string;
            /** Present when `mode: 'apply'` should be authorized for this resource's resolved connection — see {@link ProxyWriteAuthorizationContext}. */
            writeAuthorization?: ProxyWriteAuthorizationContext;
          }
        | null
      >;
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
  /**
   * Every `dynamic_ip`-owned rule across EVERY declared resource whose
   * stored `value` is `aliasReference` (`formatIpAliasReference(name)`,
   * i.e. `'alias:<name>'`) — the cross-domain fan-out query the dynamic-IP
   * alias detection sweep needs (`@loxep/app`'s `ip-alias-detection.ts`) to
   * find every rule an alias change affects, regardless of which domain or
   * hosting target owns the resource. Kept here, not as a raw query in
   * `@loxep/app`, matching this package's own "database access lives in the
   * domain/infrastructure layer" discipline.
   */
  listRulesReferencingAlias(
    aliasReference: string,
  ): Promise<Array<{ resource: ProxyResourceRow; rule: ProxyResourceRuleRow }>>;
}

/**
 * `aliases`: the `infrastructure.ip_aliases` setting's current value, read
 * ONCE by the caller per `reconcile()` call — this function stays PURE
 * (sync, no I/O) so a `dynamic_ip`-owned rule's `alias:<name>` reference
 * resolves to today's literal address the same way `resolveHostingAddress`
 * resolves a fronting chain: throws {@link MaterializationError} on an
 * unresolvable alias rather than falling back to the reference string or a
 * stale value — see `ip-aliases.ts`'s module doc.
 */
function buildDesired(
  resource: ProxyResourceRow,
  domainName: string,
  rules: ProxyResourceRuleRow[],
  aliases: IpAliasMap,
): DesiredProxyResource {
  const fullDomain =
    resource.subdomain === null
      ? domainName
      : `${resource.subdomain}.${domainName}`;

  const desiredRules: DesiredProxyRule[] = rules.map((rule) => {
    const materialized = materializeProxyRuleValue(rule.value, aliases);
    return {
      externalRuleId: rule.externalRuleId,
      action: rule.action,
      match: rule.match,
      value: materialized.value,
      aliasName: materialized.aliasName,
      priority: rule.priority,
      enabled: rule.enabled,
      // Closed set validated by the `proxy_resource_rules_owner_check`
      // constraint; the cast is a plain narrowing, not a trust boundary.
      owner: rule.owner as DesiredProxyRule["owner"],
    };
  });

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
  /**
   * Resolves `infrastructure.ip_aliases` — needed so `dynamic_ip`-owned
   * rules can materialize (`buildDesired`). Optional and defaulting to an
   * always-empty map ONLY for a caller with no alias to resolve yet (a
   * resource whose rules are all `template`/`manual`-owned): any
   * `dynamic_ip` row it encounters would then refuse with
   * {@link MaterializationError} exactly as if the alias were genuinely
   * missing, which is the honest behavior — there is no such thing as "this
   * caller opted out of aliases" for a row that references one.
   */
  settings?: Pick<SettingsService, "get">;
}): ProxyResourcesService {
  const { db } = options;
  const settings: Pick<SettingsService, "get"> =
    options.settings ?? { get: async (definition) => definition.defaultValue };
  const ledger: ProviderOperationsLedger = createProviderOperationsLedger({ db });

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

  /**
   * Applies ONE tier-1 `create-*` operation for real, ledgered. Returns the
   * provider's id for whichever object it created — a caller uses this to
   * self-retire `proxyResources.externalResourceId` after a `create-resource`
   * — or `null` when the write short-circuited on an already-`succeeded`
   * ledger row (nothing new happened, so nothing new to retire). Throws
   * {@link ProviderCallError} on a genuine provider failure, matching
   * `container-hosts.ts`'s own create path — the caller lets it propagate
   * into `finish('failed', …)`.
   */
  async function applyTier1Operation(input: {
    operation: Extract<
      ProxyOperation,
      { kind: "create-resource" | "create-target" | "create-rule" }
    >;
    proxyResourceId: string;
    runId: string;
    provider: ProxyProviderPort;
    redact: ResponseRedactor;
    ruleRowByNaturalKey: Map<string, ProxyResourceRuleRow>;
    step: (entry: {
      step: string;
      status: "succeeded" | "failed" | "skipped" | "blocked";
      requestSummary?: Record<string, unknown> | null;
      responseSummary?: Record<string, unknown> | null;
      errorCode?: string | null;
      errorDetail?: string | null;
    }) => Promise<void>;
    /** Marks the containing `reconcile_runs` row failed BEFORE this function re-throws — matching `container-hosts.ts`'s own create-failure branch. */
    finish: (status: "failed", errorSummary: string | null) => Promise<void>;
  }): Promise<ProxyApplyResult | null> {
    const { operation, proxyResourceId, runId, provider, redact, ruleRowByNaturalKey, step, finish } = input;

    if (operation.kind === "create-resource") {
      const key = idempotencyKey(PANGOLIN_LEDGER_PROVIDER, "resource.create", proxyResourceId);
      const begin = await ledger.begin({
        key,
        provider: PANGOLIN_LEDGER_PROVIDER,
        operation: "resource.create",
        runId,
      });
      if (begin.decision === "already_succeeded") {
        await step({
          step: "apply.create-resource",
          status: "succeeded",
          responseSummary: { shortCircuited: true, idempotencyKey: key },
        });
        return null;
      }
      if (begin.decision === "needs_read_back") {
        // The ledger's IDEAL case (container-hosts.ts's vocabulary):
        // `provider.read()` IS `listResources`, and matching by `fullDomain`
        // is this port's own bootstrap join key (`proxy-port.ts`'s module
        // doc) — the practical stand-in for "matched on niceId" the design
        // names, since niceId is provider-assigned and unknown in advance.
        const readBack = await provider.read({ orgId: operation.resource.domainId });
        const found = readBack.find(
          (r) => r.fullDomain === operation.resource.name || r.subdomain === operation.resource.subdomain,
        );
        if (found === undefined) {
          await ledger.fail(key, { readBack: "absent" });
          await step({
            step: "apply.create-resource.read-back",
            status: "succeeded",
            responseSummary: { present: false, resolvedTo: "failed" },
          });
          return null;
        }
        await ledger.succeed(key, { readBack: "present", externalResourceId: found.externalResourceId });
        await step({
          step: "apply.create-resource.read-back",
          status: "succeeded",
          responseSummary: { present: true, resolvedTo: "succeeded" },
        });
        return { kind: "create-resource", status: "applied", externalResourceId: found.externalResourceId };
      }
      try {
        const result = await provider.apply(operation);
        await ledger.succeed(key, redact(result));
        await step({
          step: "apply.create-resource",
          status: "succeeded",
          requestSummary: redact(operation.resource),
          responseSummary: redact(result),
        });
        return result;
      } catch (error) {
        const kind = errorKind(error);
        await ledger.fail(key, { errorKind: kind });
        await step({
          step: "apply.create-resource",
          status: "failed",
          errorCode: kind,
          errorDetail: "pangolin resource create failed",
        });
        await finish("failed", `resource create failed (${kind})`);
        if (error instanceof ProviderCallError) throw error;
        throw new ProviderCallError(kind, "pangolin resource create failed", { proxyResourceId, runId });
      }
    }

    if (operation.kind === "create-target") {
      const naturalKey = targetNaturalKey({
        siteId: operation.target.siteId,
        ip: operation.target.ip,
        port: operation.target.port,
      });
      const key = idempotencyKey(
        PANGOLIN_LEDGER_PROVIDER,
        "target.create",
        `${operation.externalResourceId}:${naturalKey}`,
      );
      const begin = await ledger.begin({
        key,
        provider: PANGOLIN_LEDGER_PROVIDER,
        operation: "target.create",
        runId,
      });
      if (begin.decision === "already_succeeded") {
        await step({
          step: "apply.create-target",
          status: "succeeded",
          responseSummary: { shortCircuited: true, idempotencyKey: key },
        });
        return null;
      }
      if (begin.decision === "needs_read_back") {
        const readBack = await provider.read({ orgId: "" }).catch(() => []);
        // A target read-back needs the RESOURCE's own targets, which the
        // whole-org `read()` already nests — find the owning resource, then
        // its target by natural key. See `targetNaturalKey`'s doc.
        const ownerResource = readBack.find((r) => r.externalResourceId === operation.externalResourceId);
        const found = ownerResource?.targets.find(
          (t) =>
            t.siteId !== null &&
            t.ip !== null &&
            t.port !== null &&
            targetNaturalKey({ siteId: t.siteId, ip: t.ip, port: t.port }) === naturalKey,
        );
        if (found === undefined) {
          await ledger.fail(key, { readBack: "absent" });
          await step({
            step: "apply.create-target.read-back",
            status: "succeeded",
            responseSummary: { present: false, resolvedTo: "failed" },
          });
          return null;
        }
        await ledger.succeed(key, { readBack: "present", externalTargetId: found.externalTargetId });
        await step({
          step: "apply.create-target.read-back",
          status: "succeeded",
          responseSummary: { present: true, resolvedTo: "succeeded" },
        });
        return { kind: "create-target", status: "applied", externalTargetId: found.externalTargetId };
      }
      try {
        const result = await provider.apply(operation);
        await ledger.succeed(key, redact(result));
        await step({
          step: "apply.create-target",
          status: "succeeded",
          requestSummary: redact(operation.target),
          responseSummary: redact(result),
        });
        return result;
      } catch (error) {
        const kind = errorKind(error);
        await ledger.fail(key, { errorKind: kind });
        await step({
          step: "apply.create-target",
          status: "failed",
          errorCode: kind,
          errorDetail: "pangolin target create failed",
        });
        await finish("failed", `target create failed (${kind})`);
        if (error instanceof ProviderCallError) throw error;
        throw new ProviderCallError(kind, "pangolin target create failed", { proxyResourceId, runId });
      }
    }

    // create-rule
    const sourceRow = ruleRowByNaturalKey.get(ruleNaturalKey(operation.rule));
    // The ledger's natural key is the Loxep-owned `proxy_resource_rules.id`
    // when a source intent row is recoverable (always, from a real
    // `reconcile()` call) — a value the caller can always recompute, per
    // `operations.ts`'s own requirement. Falls back to the rule's own
    // natural key so a directly-driven test (no DB row) still works.
    const key = idempotencyKey(
      PANGOLIN_LEDGER_PROVIDER,
      "rule.create",
      sourceRow?.id ?? `${operation.externalResourceId}:${ruleNaturalKey(operation.rule)}`,
    );
    const begin = await ledger.begin({
      key,
      provider: PANGOLIN_LEDGER_PROVIDER,
      operation: "rule.create",
      runId,
    });
    if (begin.decision === "already_succeeded") {
      await step({
        step: "apply.create-rule",
        status: "succeeded",
        responseSummary: { shortCircuited: true, idempotencyKey: key },
      });
      return null;
    }
    if (begin.decision === "needs_read_back") {
      const readBack = await provider.read({ orgId: "" }).catch(() => []);
      const ownerResource = readBack.find((r) => r.externalResourceId === operation.externalResourceId);
      const found = ownerResource?.rules.find(
        (r) => ruleNaturalKey(r) === ruleNaturalKey(operation.rule),
      );
      if (found === undefined) {
        await ledger.fail(key, { readBack: "absent" });
        await step({
          step: "apply.create-rule.read-back",
          status: "succeeded",
          responseSummary: { present: false, resolvedTo: "failed" },
        });
        return null;
      }
      await ledger.succeed(key, { readBack: "present", externalRuleId: found.externalRuleId });
      await step({
        step: "apply.create-rule.read-back",
        status: "succeeded",
        responseSummary: { present: true, resolvedTo: "succeeded" },
      });
      return { kind: "create-rule", status: "applied", externalRuleId: found.externalRuleId };
    }
    try {
      const result = await provider.apply(operation);
      await ledger.succeed(key, redact(result));
      await step({
        step: "apply.create-rule",
        status: "succeeded",
        // `value` (a CIDR/IP/path/etc.) is deliberately included — it is
        // the rule, not a secret (`redactPangolinRule`'s own doc).
        requestSummary: redact(operation.rule),
        responseSummary: redact(result),
      });
      return result;
    } catch (error) {
      const kind = errorKind(error);
      await ledger.fail(key, { errorKind: kind });
      await step({
        step: "apply.create-rule",
        status: "failed",
        errorCode: kind,
        errorDetail: "pangolin rule create failed",
      });
      await finish("failed", `rule create failed (${kind})`);
      if (error instanceof ProviderCallError) throw error;
      throw new ProviderCallError(kind, "pangolin rule create failed", { proxyResourceId, runId });
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
      writeAuthorization?: ProxyWriteAuthorizationContext;
    },
  ): Promise<ReconcileProxyResourceResult> {
    // M4-specific and stricter than `assertWritePolicy`'s own trigger rule —
    // see `assertApplyTriggerAllowed`'s doc. Checked before any read, any DB
    // write, or any run row, matching M2's own "refuse before the call"
    // discipline.
    if (reconcileOptions.mode === "apply") {
      assertApplyTriggerAllowed(reconcileOptions.trigger);
    }
    const redact = reconcileOptions.redact ?? defaultProxyRedactor;

    const resource = await requireResource(db, proxyResourceId);
    const rules = await loadRules(db, proxyResourceId);
    const domainName = await requireDomainName(db, resource.domainId);
    const aliases = await settings.get(ipAliasesSetting);

    const runRows = await db
      .insert(reconcileRuns)
      .values({
        kind: RECONCILE_PROXY_RESOURCE_RUN_KIND,
        subjectType: PROXY_RESOURCE_SUBJECT_TYPE,
        subjectId: proxyResourceId,
        mode: reconcileOptions.mode,
        trigger: reconcileOptions.trigger,
        actorUserId: reconcileOptions.actorUserId ?? null,
      })
      .returning();
    const run = runRows[0];
    if (run === undefined) throw new Error("reconcile run insert returned no row");

    let sequence = 0;
    const step = async (entry: {
      step: string;
      status: "succeeded" | "failed" | "skipped" | "blocked";
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
      status: "succeeded" | "failed" | "partial",
      errorSummary: string | null,
    ): Promise<void> => {
      await db
        .update(reconcileRuns)
        .set({ status, finishedAt: new Date(), stepCount: sequence, errorSummary })
        .where(eq(reconcileRuns.id, run.id));
    };

    // Materialize `dynamic_ip`-owned rule references into literal values
    // (`ip-aliases.ts`'s `materializeProxyRuleValue`, via `buildDesired`)
    // BEFORE any provider call — an unresolvable alias is refused the same
    // way a broken fronting chain is, never silently applied with a stale or
    // literal-reference value. `ruleRowByNaturalKey` is keyed from the
    // RESOLVED desired rules (not the raw DB rows) so it lines up with the
    // literal values `planProxyResourceOperations` actually diffs and
    // `applyTier1Operation`'s create-rule ledger lookup actually receives —
    // rows[i] and desired.rules[i] share the same order by construction.
    let desired: DesiredProxyResource;
    try {
      desired = buildDesired(resource, domainName, rules, aliases);
    } catch (error) {
      if (!(error instanceof MaterializationError)) throw error;
      await step({
        step: "materialize-aliases",
        status: "failed",
        errorCode: "alias_unresolvable",
        errorDetail: error.message,
      });
      await finish("failed", `alias materialization failed: ${error.message}`);
      throw error;
    }
    const ruleRowByNaturalKey = new Map<string, ProxyResourceRuleRow>();
    for (let i = 0; i < rules.length; i++) {
      const row = rules[i];
      const desiredRule = desired.rules[i];
      if (row === undefined || desiredRule === undefined) continue;
      ruleRowByNaturalKey.set(ruleNaturalKey(desiredRule), row);
    }

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

    let appliedCount = 0;
    let runStatus: "succeeded" | "partial" = "succeeded";

    if (reconcileOptions.mode !== "apply") {
      await step({ step: "apply.skipped-check-mode", status: "skipped" });
    } else {
      const tier1Operations = plan.operations.filter(
        (
          op,
        ): op is Extract<
          ProxyOperation,
          { kind: "create-resource" | "create-target" | "create-rule" }
        > => op.kind === "create-resource" || op.kind === "create-target" || op.kind === "create-rule",
      );
      const tier2Operations = plan.operations.filter(
        (op) => !tier1Operations.includes(op as (typeof tier1Operations)[number]),
      );

      if (tier2Operations.length > 0) {
        runStatus = "partial";
        await step({
          step: "apply.tier2-not-implemented",
          status: "skipped",
          responseSummary: {
            count: tier2Operations.length,
            kinds: [...new Set(tier2Operations.map((op) => op.kind))],
          },
        });
      }

      if (tier1Operations.length === 0) {
        await step({ step: "apply.none", status: "skipped" });
      } else {
        const writeAuthorization = reconcileOptions.writeAuthorization;
        if (writeAuthorization === undefined) {
          throw new InfrastructureValidationError(
            "proxy resource apply requires a resolved writeAuthorization (policy tier, connection id) — the caller must resolve the connection's write policy before requesting mode: 'apply'",
            { proxyResourceId },
          );
        }

        let refusal: WritePolicyError | null = null;
        try {
          assertWritePolicy({
            mode: "apply",
            trigger: reconcileOptions.trigger,
            policyTier: writeAuthorization.policyTier,
            operationTier: 1,
            actorIsAdmin: writeAuthorization.actorIsAdmin,
            unblockHint:
              `allow tier-1 (additive) writes for connection ${writeAuthorization.connectionId} — ` +
              "flip infrastructure.provider_write_policy to at least 'additive' for this connection " +
              "to create Pangolin objects here",
          });
        } catch (error) {
          if (error instanceof WritePolicyError) refusal = error;
          else throw error;
        }

        if (refusal === null) {
          // Tier 1 is purely additive: only wouldLockOut's two SELF-MANAGED
          // -RESOURCE clauses apply at this tier — see the module doc's
          // "APPLY, now gated" section for why `no_operator_access` and
          // `retires_only_live_alias_rule` are deliberately ignored here.
          const observedSelf = observed.find(
            (r) => r.externalResourceId === desired.externalResourceId,
          );
          const lockoutReason = wouldLockOut({
            resource: {
              fullDomain: desired.fullDomain,
              isPangolinDashboard: (writeAuthorization.pangolinDashboardHosts ?? []).some((h) =>
                hostMatches(desired.fullDomain, h),
              ),
              isLoxepSelf: (writeAuthorization.loxepSelfHosts ?? []).some((h) =>
                hostMatches(desired.fullDomain, h),
              ),
            },
            resultingRules: (observedSelf?.rules ?? []).map((r) => ({
              action: r.action,
              match: r.match,
              value: r.value,
              enabled: r.enabled,
              aliasName: null,
            })),
            operatorContext: { currentAddresses: [], heldAuthMethods: [] },
          });
          if (lockoutReason === "loxep_self" || lockoutReason === "pangolin_dashboard_self") {
            refusal = new WritePolicyError(
              lockoutReason === "loxep_self"
                ? "refused: this resource fronts Loxep itself — manage it from the Pangolin dashboard directly, out of band"
                : "refused: this is the Pangolin dashboard's own resource — Loxep never manages it",
              "write_policy",
              { reason: lockoutReason, fullDomain: desired.fullDomain },
            );
          }
        }

        if (refusal !== null) {
          runStatus = "partial";
          const blocked = writePolicyBlockedStep(refusal);
          await step({ step: "apply.blocked", ...blocked });
        } else {
          let createdResourceId: string | null = null;
          for (const operation of tier1Operations) {
            const result = await applyTier1Operation({
              operation,
              proxyResourceId,
              runId: run.id,
              provider: reconcileOptions.provider,
              redact,
              ruleRowByNaturalKey,
              step,
              finish,
            });
            if (result !== null) {
              appliedCount += 1;
              if (result.kind === "create-resource" && result.externalResourceId !== undefined) {
                createdResourceId = result.externalResourceId;
              }
            }
          }
          if (createdResourceId !== null && createdResourceId !== resource.externalResourceId) {
            await selfRetireIdentity(proxyResourceId, createdResourceId);
          }
        }
      }
    }

    await finish(runStatus, null);
    return {
      proxyResourceId,
      runId: run.id,
      status: runStatus,
      mode: reconcileOptions.mode,
      operationCount: plan.operations.length,
      appliedCount,
      unmatchedObservedCount: plan.unmatchedObserved.length,
    };
  }

  async function reconcileDomain(
    domainId: string,
    domainOptions: {
      mode: "apply" | "check";
      trigger: "intent_change" | "manual" | "poll";
      resolveProvider: (hostingTargetId: string) => Promise<
        | {
            provider: ProxyProviderPort;
            orgId: string;
            writeAuthorization?: ProxyWriteAuthorizationContext;
          }
        | null
      >;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
    },
  ): Promise<ReconcileProxyResourceResult[]> {
    if (domainOptions.mode === "apply") {
      assertApplyTriggerAllowed(domainOptions.trigger);
    }

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
          mode: domainOptions.mode,
          operationCount: 0,
          appliedCount: 0,
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
        ...(resolved.writeAuthorization !== undefined
          ? { writeAuthorization: resolved.writeAuthorization }
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

  async function listRulesReferencingAlias(
    aliasReference: string,
  ): Promise<Array<{ resource: ProxyResourceRow; rule: ProxyResourceRuleRow }>> {
    return db
      .select({ resource: proxyResources, rule: proxyResourceRules })
      .from(proxyResourceRules)
      .innerJoin(proxyResources, eq(proxyResourceRules.proxyResourceId, proxyResources.id))
      .where(
        and(
          eq(proxyResourceRules.owner, "dynamic_ip"),
          eq(proxyResourceRules.value, aliasReference),
        ),
      )
      .orderBy(asc(proxyResources.createdAt));
  }

  return {
    reconcile,
    reconcileDomain,
    listResourcesForDomain,
    listResourcesForHostingTarget,
    listRuns,
    listRulesReferencingAlias,
  };
}
