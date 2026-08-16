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
 *
 * ## M7 (`loxep-acj.7`) retirement orchestration — additive on top of everything above
 *
 * Owner ruling (`pangolin-credential-constraints` memory, 2026-08-15):
 * retirement = disable-never-delete CONFIRMED, gated behind the typed
 * confirmation and the self-lockout preflight, never from a sweep. Two new
 * `ProxyResourcesService` members land alongside `reconcile()`, both purely
 * ADDITIVE — nothing above this section changes shape:
 *
 * ```text
 * retireRule            disable ONE proxy_resource_rules row's CURRENT
 *                        provider-side rule — the ordinary "a template or
 *                        manual edit superseded this rule" case. Tier 2
 *                        (access_affecting) for the write-policy GATE; the
 *                        self-lockout PREFLIGHT (wouldLockOut, all four
 *                        clauses, not only the two self-managed ones tier-1
 *                        apply checks) decides per-call whether THIS retire
 *                        is actually lockout-class. Convergent, matching the
 *                        design's own "update-rule... would NOT be ledgered"
 *                        sentence above — no provider_operations row, and an
 *                        already-disabled-at-the-provider target is a safe
 *                        no-op, not an error.
 *
 * retireAliasFanOutRule  disable the PREVIOUSLY-observed provider rule for
 *                        one dynamic-IP alias's OLD address on one resource
 *                        — the M5 add-then-retire fan-out's retire half,
 *                        finally completing for real. NOT `retireRule` on
 *                        the alias's own intent row: that row's `value`
 *                        stays `alias:<name>` forever (ip-aliases.ts's
 *                        module doc), and by the time an operator retires it
 *                        already materializes to the NEW address — retiring
 *                        "whatever this row currently matches" would target
 *                        the wrong provider object. The OLD rule is
 *                        provider-side-only from Loxep's perspective (no
 *                        intent row ever pointed at it specifically), so
 *                        this method re-derives it from `planIpAliasFanOut`'s
 *                        own matching against a FRESH provider read, exactly
 *                        as `ip-alias-detection.ts`'s sweep already does for
 *                        the check-only preview it fires a notification for.
 * ```
 *
 * Both apply `mode: 'apply'` ALWAYS — there is no "retire in check mode",
 * because the typed-confirmation dialog IS the preview (the design's tier-2
 * "explicit apply from a shown plan" rule, discharged by a dialog naming
 * exactly what changes before the operator can even submit). Both restrict
 * `trigger` to `'manual' | 'intent_change'` at the TYPE level (no `'sweep'`
 * or `'poll'` member exists to construct) AND re-check it at runtime — rule
 * 3's "no sweep, poll, or scheduled run may perform a tier ≥ 2 write" is
 * unconditional, and `assertWritePolicy` already enforces it structurally
 * for any trigger that reaches it, but the runtime guard removes any
 * dependence on the caller's own type-checking having run.
 *
 * ### `wouldLockOut`'s `operatorContext`, and why it is NOT omniscient
 *
 * Nothing in Loxep tracks "the operator's current browser address" as a
 * fact. `wouldLockOut`'s `no_operator_access` clause needs SOME honest
 * source for `currentAddresses`/`heldAuthMethods` rather than an empty list
 * (which would refuse every retire unconditionally — useless) or a
 * fabricated one (unsafe). Both retirement paths source `currentAddresses`
 * from `infrastructure.ip_aliases`'s own registered addresses — every alias
 * IS an address the operator has told Loxep they hold, which is exactly what
 * this predicate asks for — and `heldAuthMethods` from the resource's own
 * OBSERVED `ssoEnabled` presence bit (a resource with SSO configured has a
 * non-address way in). This is a best-effort, honestly-documented heuristic,
 * not a claim of completeness: an operator whose current address has no
 * registered alias, and whose resource has no SSO, will see every retire
 * refused by this clause — exactly the caution "before implementing any of
 * this" item 3 names ("confirm the self-lockout predicate against the
 * owner's actual rule set... a predicate that refuses a legitimate change is
 * its own kind of outage"). The predicate itself is pure and unit-tested
 * regardless of source; this module only supplies its inputs honestly.
 */
import type { LoxepDb } from "@loxep/db";
import type { IpAliasMap, ProviderWritePolicyTier, SettingsService } from "@loxep/domain";
import {
  formatIpAliasReference,
  ipAliasCidrValue,
  ipAliasesSetting,
  parseIpAliasReference,
} from "@loxep/domain";
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
  type ObservedProxyRule,
  type ProxyApplyResult,
  type ProxyOperation,
  type ProxyProviderPort,
  type ProxyRulePayload,
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
  lockoutBlockedStep,
  wouldLockOut,
  writePolicyBlockedStep,
  type LockoutCheckOperatorContext,
  type LockoutCheckRule,
} from "./write-policy.ts";

export type ProxyResourceRow = typeof proxyResources.$inferSelect;
export type ProxyResourceRuleRow = typeof proxyResourceRules.$inferSelect;
export type ReconcileRunRow = typeof reconcileRuns.$inferSelect;

/** `reconcile_runs.kind` for this task. */
export const RECONCILE_PROXY_RESOURCE_RUN_KIND = "reconcile-proxy-resource";

/** `reconcile_runs.kind` for M7's (`loxep-acj.7`) `retireRule`/`retireAliasFanOutRule` — kept distinct from {@link RECONCILE_PROXY_RESOURCE_RUN_KIND} so a run history can tell "Loxep checked/created" apart from "Loxep retired" at a glance, without inspecting steps. */
export const RECONCILE_PROXY_RESOURCE_RETIRE_RUN_KIND = "reconcile-proxy-resource-retire";

/** `reconcile_runs.kind` for M7's `enableRule` — the owner's filtering-UX ruling's "plus re-enable" half. Distinct from the retire kind for the identical "tell it apart at a glance" reason. */
export const RECONCILE_PROXY_RESOURCE_ENABLE_RUN_KIND = "reconcile-proxy-resource-enable";

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

/**
 * M7 (`loxep-acj.7`)'s "drift-aware" retirement check: a `desired` rule
 * Loxep intends DISABLED (`enabled: false` — because `retireRule()` set the
 * intent row that way, or it was authored disabled from the start) whose
 * matching OBSERVED rule (by `action`/`match`/`value`, ignoring `priority`
 * so a priority-only reorder never masks this) is still `enabled: true` at
 * the provider — "a rule Loxep disabled that reality re-enabled". Pure, no
 * I/O — `reconcile()`'s own diff step calls this with facts it has already
 * fetched. This rides the plan exactly as `unmatchedObserved` does (the
 * design's own resolution of open question 8: no separate findings table),
 * never auto-corrected — the operator sees it and decides, matching
 * `unmatchedObserved`'s own "information, never drift to correct" rule.
 */
function findReEnabledRetiredRules(
  desiredRules: readonly DesiredProxyRule[],
  observedResource: ObservedProxyResource | undefined,
): Array<{ action: string; match: string; value: string }> {
  if (observedResource === undefined) return [];
  const found: Array<{ action: string; match: string; value: string }> = [];
  for (const desiredRule of desiredRules) {
    if (desiredRule.enabled) continue;
    const stillEnabled = observedResource.rules.find(
      (observedRule) =>
        observedRule.enabled &&
        observedRule.action === desiredRule.action &&
        observedRule.match === desiredRule.match &&
        observedRule.value === desiredRule.value,
    );
    if (stillEnabled !== undefined) {
      found.push({ action: desiredRule.action, match: desiredRule.match, value: desiredRule.value });
    }
  }
  return found;
}

/**
 * The `LockoutCheckRule` shape for one OBSERVED rule, resolving its
 * `aliasName` from the matching intent row (if any) — `retireRule` and
 * `retireAliasFanOutRule` share this so `wouldLockOut`'s
 * `retiresAliasRuleNamed` clause sees the same provenance `reconcile()`'s own
 * diff already threads through `DesiredProxyRule.aliasName`.
 */
function toLockoutCheckRules(
  observedRules: readonly ObservedProxyRule[],
  aliasNameByExternalRuleId: ReadonlyMap<string, string | null>,
  overrideDisabledExternalRuleId: string | null,
): LockoutCheckRule[] {
  return observedRules.map((rule) => ({
    action: rule.action,
    match: rule.match,
    value: rule.value,
    enabled: rule.externalRuleId === overrideDisabledExternalRuleId ? false : rule.enabled,
    aliasName: aliasNameByExternalRuleId.get(rule.externalRuleId) ?? null,
  }));
}

/**
 * Maps each OBSERVED rule's `externalRuleId` to the `dynamic_ip` alias name
 * it currently materializes, for `wouldLockOut`'s `retiresAliasRuleNamed`
 * clause. Matches by the row's CURRENT materialized value
 * (action/match/value — never `dr.externalRuleId`, which M4 never persisted
 * and M7 only starts persisting going forward), so a `dynamic_ip` row whose
 * alias just changed address still correctly labels its NEW (currently-live)
 * observed rule, even though nothing yet identifies that observed rule by id
 * — this is exactly `retireAliasFanOutRule`'s own case: the intent row's
 * CURRENT materialization (the just-added new rule) must be recognized as
 * "the same alias" as the STALE observed rule being retired, or the preflight
 * would wrongly conclude the alias has no other live rule.
 */
function buildAliasNameByExternalRuleId(
  rules: readonly ProxyResourceRuleRow[],
  desiredRules: readonly DesiredProxyRule[],
  observedRules: readonly ObservedProxyRule[],
): Map<string, string | null> {
  const aliasNameByExternalRuleId = new Map<string, string | null>();
  for (let i = 0; i < rules.length; i++) {
    const row = rules[i];
    const dr = desiredRules[i];
    if (row === undefined || dr === undefined || row.owner !== "dynamic_ip") continue;
    const aliasName = parseIpAliasReference(row.value);
    const matchingObserved = observedRules.find(
      (r) => r.action === dr.action && r.match === dr.match && r.value === dr.value,
    );
    if (matchingObserved !== undefined) {
      aliasNameByExternalRuleId.set(matchingObserved.externalRuleId, aliasName);
    }
  }
  return aliasNameByExternalRuleId;
}

/**
 * The self-lockout preflight's `operatorContext` — see the module doc's own
 * section on why this is a best-effort heuristic, not an omniscient fact.
 * `currentAddresses` comes from every registered `infrastructure.ip_aliases`
 * address (an address the operator has told Loxep they hold);
 * `heldAuthMethods` comes from the target resource's own observed
 * `ssoEnabled` PRESENCE bit — never its whitelist contents, matching
 * `ObservedProxyResource`'s own "presence only" rule.
 */
function resolveLockoutOperatorContext(
  aliases: IpAliasMap,
  resource: ObservedProxyResource,
): LockoutCheckOperatorContext {
  return {
    currentAddresses: Object.values(aliases).map((entry) => entry.address),
    heldAuthMethods: resource.ssoEnabled === true ? ["sso"] : [],
  };
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

/**
 * `retireRule()`'s outcome. M7 (`loxep-acj.7`) — see the module doc's own
 * section for why this is convergent (never ledgered) and why `blocked` is a
 * distinct, first-class outcome rather than an error.
 */
export interface RetireProxyRuleResult {
  proxyResourceRuleId: string;
  proxyResourceId: string;
  runId: string;
  /**
   * `'blocked'` covers BOTH refusal sources — the write-policy gate
   * (`assertWritePolicy`) and the self-lockout preflight (`wouldLockOut`) —
   * distinguished by the run step's own `errorCode`, never by this field.
   */
  status: "succeeded" | "blocked" | "failed";
  /** `true` when the provider already had this rule disabled — a safe, convergent no-op, never an error. */
  alreadyDisabled: boolean;
}

/**
 * `enableRule()`'s outcome — the owner's filtering-UX ruling's "plus
 * re-enable" half (`bd remember` for `loxep-acj.7`). Same shape as
 * {@link RetireProxyRuleResult}, mirrored.
 */
export interface EnableProxyRuleResult {
  proxyResourceRuleId: string;
  proxyResourceId: string;
  runId: string;
  status: "succeeded" | "blocked" | "failed";
  /** `true` when the provider already had this rule enabled — a safe, convergent no-op, never an error. */
  alreadyEnabled: boolean;
}

/** `retireAliasFanOutRule()`'s outcome — one run may retire several previously-live rules across one resource. */
export interface RetireAliasFanOutResult {
  proxyResourceId: string;
  aliasName: string;
  /** `null` only for a `'skipped'` result that never reached a database write — no candidate rule existed to evaluate. */
  runId: string | null;
  /**
   * `'skipped'`: nothing to retire this call — the alias has no
   * `previousAddress` yet (nothing has ever changed), or every previously-live
   * rule for the old address is already gone/disabled at the provider. Never
   * an error: "nothing to retire yet" is a legitimate state (`ip-aliases.ts`'s
   * own doc for `IpAliasFanOutRuleAction.retire`).
   */
  status: "succeeded" | "partial" | "failed" | "skipped";
  retiredCount: number;
  blockedCount: number;
  failedCount: number;
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
  /**
   * M7 (`loxep-acj.7`): disable ONE `proxy_resource_rules` row's CURRENT
   * provider-side rule — `enabled: false`, the reversible retirement form.
   * Tier 2 (access_affecting) for the write-policy gate; the full
   * self-lockout preflight (all four `wouldLockOut` clauses) decides whether
   * THIS retire is actually lockout-class. Always `mode: 'apply'` — see the
   * module doc for why there is no "retire in check mode". Refuses a
   * `'manual'`-owned rule outright (never rewrites a human's record) and a
   * rule the provider does not have (nothing to retire). Convergent: an
   * already-disabled provider rule is a safe no-op, and no
   * `provider_operations` row is ever written for this call.
   */
  retireRule(
    proxyResourceRuleId: string,
    options: {
      trigger: "intent_change" | "manual";
      provider: ProxyProviderPort;
      orgId: string;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
      writeAuthorization: ProxyWriteAuthorizationContext;
    },
  ): Promise<RetireProxyRuleResult>;
  /**
   * M7 (`loxep-acj.7`): the owner's filtering-UX ruling's "plus re-enable"
   * half — `enabled: true` on ONE `proxy_resource_rules` row's CURRENT
   * provider-side rule. Same tier-2 write-policy gate as `retireRule`; the
   * self-lockout preflight still runs (the resource's own self-managed
   * clauses always apply), but `retiresAliasRuleNamed` is always `null` here
   * — re-enabling never retires anything, so that clause can never fire.
   * Convergent, same as `retireRule`: an already-enabled provider rule is a
   * safe no-op, never ledgered.
   */
  enableRule(
    proxyResourceRuleId: string,
    options: {
      trigger: "intent_change" | "manual";
      provider: ProxyProviderPort;
      orgId: string;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
      writeAuthorization: ProxyWriteAuthorizationContext;
    },
  ): Promise<EnableProxyRuleResult>;
  /**
   * M7 (`loxep-acj.7`), completing the M5 add-then-retire fan-out's retire
   * half for real: disable every currently-live provider rule matching
   * `aliasName`'s PREVIOUS address on ONE resource. Re-derives the target
   * rule(s) from a fresh provider read plus `planIpAliasFanOut`'s own
   * matching — never from a caller-supplied identity — because the alias's
   * own intent row(s) already materialize to the NEW address by the time an
   * operator retires (see the module doc). One run may retire several rules
   * (a resource can carry more than one `dynamic_ip` rule bound to the same
   * alias); each rule's write-policy/lockout outcome is independent, so one
   * refusal never blocks another rule's retirement — partial failure
   * resolves forward, matching the design's own rule for a template run.
   */
  retireAliasFanOutRule(
    proxyResourceId: string,
    aliasName: string,
    options: {
      trigger: "intent_change" | "manual";
      provider: ProxyProviderPort;
      orgId: string;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
      writeAuthorization: ProxyWriteAuthorizationContext;
    },
  ): Promise<RetireAliasFanOutResult>;
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

  /** M7 (`loxep-acj.7`): the one `proxy_resource_rules` row `retireRule` targets. */
  async function requireRuleRow(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<ProxyResourceRuleRow> {
    const rows = await executor
      .select()
      .from(proxyResourceRules)
      .where(eq(proxyResourceRules.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`proxy resource rule ${id} not found`, {
        id,
      });
    }
    return row;
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
   * The rule sibling of {@link selfRetireIdentity} — closes the M4 gap the
   * module doc's "no milestone has ever persisted `proxy_resource_rules
   * .externalRuleId` back after a create" note flagged honestly. M7
   * (`loxep-acj.7`) needs it: `retireRule()` resolves its target FASTER (and
   * more robustly) once a row already carries its provider id, rather than
   * always falling back to a natural-key read-back. Best-effort, matching
   * `selfRetireIdentity`'s own "a failure here does not fail the run" rule —
   * this is Loxep's own row, never Pangolin.
   */
  async function selfRetireRuleIdentity(
    ruleRowId: string,
    externalRuleId: string,
  ): Promise<void> {
    try {
      await db
        .update(proxyResourceRules)
        .set({ externalRuleId, updatedAt: new Date() })
        .where(eq(proxyResourceRules.id, ruleRowId));
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
      if (sourceRow !== undefined && found.externalRuleId !== undefined) {
        await selfRetireRuleIdentity(sourceRow.id, found.externalRuleId);
      }
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
      if (sourceRow !== undefined && result.externalRuleId !== undefined) {
        await selfRetireRuleIdentity(sourceRow.id, result.externalRuleId);
      }
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

    // M7 (`loxep-acj.7`)'s drift-aware check — see `findReEnabledRetiredRules`'s
    // doc. Computed against the SAME `observed` this diff already fetched;
    // never a second provider read.
    const observedForDesired =
      observed.find((r) => r.externalResourceId === desired.externalResourceId) ??
      observed.find((r) => r.fullDomain === desired.fullDomain);
    const reEnabledRetiredRules = findReEnabledRetiredRules(desired.rules, observedForDesired);

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
        // M7: "a rule Loxep disabled that reality re-enabled" — a count on
        // every diff step (0 when there is none) so a caller can render it
        // without a schema change, matching `unmatchedObservedCount`'s own
        // precedent.
        reEnabledRetiredRuleCount: reEnabledRetiredRules.length,
      },
    });
    if (reEnabledRetiredRules.length > 0) {
      await step({
        step: "diff.retired-rule-reenabled",
        status: "succeeded",
        responseSummary: {
          count: reEnabledRetiredRules.length,
          sample: reEnabledRetiredRules.slice(0, 10),
        },
      });
    }

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

  /** Throws when `trigger` is anything but `'manual'`/`'intent_change'` — see the module doc's "sweep can never trigger" note. Shared by both M7 retirement methods. */
  function assertRetireTriggerAllowed(trigger: "intent_change" | "manual"): void {
    if (trigger !== "manual" && trigger !== "intent_change") {
      throw new ProxyWritePolicyError(
        `a '${String(trigger)}' trigger may never retire a rule — only 'manual' or 'intent_change' may (the write-authorization model's rule 3: no sweep, poll, or scheduled run may perform a tier ≥ 2 write)`,
        { trigger },
      );
    }
  }

  async function retireRule(
    proxyResourceRuleId: string,
    options: {
      trigger: "intent_change" | "manual";
      provider: ProxyProviderPort;
      orgId: string;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
      writeAuthorization: ProxyWriteAuthorizationContext;
    },
  ): Promise<RetireProxyRuleResult> {
    assertRetireTriggerAllowed(options.trigger);
    const redact = options.redact ?? defaultProxyRedactor;

    const ruleRow = await requireRuleRow(db, proxyResourceRuleId);
    if (ruleRow.owner === "manual") {
      throw new InfrastructureValidationError(
        `rule ${proxyResourceRuleId} is manually owned — Loxep's reconciler never rewrites or retires a human's record`,
        { proxyResourceRuleId },
      );
    }

    const resource = await requireResource(db, ruleRow.proxyResourceId);
    const rules = await loadRules(db, resource.id);
    const domainName = await requireDomainName(db, resource.domainId);
    const aliases = await settings.get(ipAliasesSetting);

    const runRows = await db
      .insert(reconcileRuns)
      .values({
        kind: RECONCILE_PROXY_RESOURCE_RETIRE_RUN_KIND,
        subjectType: PROXY_RESOURCE_SUBJECT_TYPE,
        subjectId: resource.id,
        mode: "apply",
        trigger: options.trigger,
        actorUserId: options.actorUserId ?? null,
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

    let observed: ObservedProxyResource[];
    try {
      observed = await options.provider.read({ orgId: options.orgId });
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
        proxyResourceRuleId,
        runId: run.id,
      });
    }

    const matchedResource =
      observed.find((r) => r.externalResourceId === desired.externalResourceId) ??
      observed.find((r) => r.fullDomain === desired.fullDomain);
    if (matchedResource === undefined) {
      await step({
        step: "retire.resource-not-found",
        status: "failed",
        errorCode: "not_found",
        errorDetail: "this resource has no matching Pangolin object yet — nothing to retire",
      });
      await finish("failed", "resource not present at provider");
      throw new InfrastructureNotFoundError(
        `proxy resource ${resource.id} has no matching Pangolin resource yet`,
        { proxyResourceId: resource.id },
      );
    }

    // desired.rules[i] corresponds 1:1 with rules[i] by construction
    // (buildDesired's own doc) — find the target row's materialized value by
    // the same index correspondence `reconcile()` relies on.
    const ruleIndex = rules.findIndex((r) => r.id === ruleRow.id);
    const targetDesiredRule = ruleIndex === -1 ? undefined : desired.rules[ruleIndex];
    if (targetDesiredRule === undefined) {
      // Cannot happen from a real call — ruleRow.proxyResourceId === resource.id
      // guarantees ruleRow is one of `rules`. Defensive, not reachable in tests.
      throw new Error(`rule ${proxyResourceRuleId} not found among its own resource's rules`);
    }

    const targetObservedRule =
      (ruleRow.externalRuleId !== null
        ? matchedResource.rules.find((r) => r.externalRuleId === ruleRow.externalRuleId)
        : undefined) ??
      matchedResource.rules.find((r) => ruleNaturalKey(r) === ruleNaturalKey(targetDesiredRule));

    if (targetObservedRule === undefined) {
      await step({
        step: "retire.rule-not-found",
        status: "failed",
        errorCode: "not_found",
        errorDetail: "Pangolin has no rule matching this intent row — nothing to retire",
      });
      await finish("failed", "rule not present at provider");
      throw new InfrastructureNotFoundError(
        `rule ${proxyResourceRuleId} has no matching Pangolin rule`,
        { proxyResourceRuleId },
      );
    }

    if (!targetObservedRule.enabled) {
      // Convergent no-op — see the module doc.
      await step({
        step: "retire.already-disabled",
        status: "succeeded",
        responseSummary: { externalRuleId: targetObservedRule.externalRuleId },
      });
      if (ruleRow.enabled || ruleRow.externalRuleId !== targetObservedRule.externalRuleId) {
        await db
          .update(proxyResourceRules)
          .set({
            enabled: false,
            externalRuleId: targetObservedRule.externalRuleId,
            updatedAt: new Date(),
          })
          .where(eq(proxyResourceRules.id, ruleRow.id));
      }
      await finish("succeeded", null);
      return {
        proxyResourceRuleId,
        proxyResourceId: resource.id,
        runId: run.id,
        status: "succeeded",
        alreadyDisabled: true,
      };
    }

    let blockedStep: { status: "blocked"; errorCode: string; errorDetail: string } | null = null;
    try {
      assertWritePolicy({
        mode: "apply",
        trigger: options.trigger,
        policyTier: options.writeAuthorization.policyTier,
        operationTier: 2,
        actorIsAdmin: options.writeAuthorization.actorIsAdmin,
        unblockHint:
          `allow tier-2 (access_affecting) writes for connection ${options.writeAuthorization.connectionId} — ` +
          "flip infrastructure.provider_write_policy to at least 'access_affecting' for this connection " +
          "to retire a Pangolin rule",
      });
    } catch (error) {
      if (error instanceof WritePolicyError) blockedStep = writePolicyBlockedStep(error);
      else throw error;
    }

    if (blockedStep === null) {
      const aliasNameByExternalRuleId = buildAliasNameByExternalRuleId(
        rules,
        desired.rules,
        matchedResource.rules,
      );
      const retiresAliasRuleNamed =
        ruleRow.owner === "dynamic_ip" ? parseIpAliasReference(ruleRow.value) : null;
      // The row being retired might not yet be recognized by the natural-key
      // match above (its CURRENT materialized value IS the observed rule
      // being disabled, so ordinarily it would be) — set it explicitly
      // regardless, so this never depends on that match succeeding.
      aliasNameByExternalRuleId.set(targetObservedRule.externalRuleId, retiresAliasRuleNamed);

      const resultingRules = toLockoutCheckRules(
        matchedResource.rules,
        aliasNameByExternalRuleId,
        targetObservedRule.externalRuleId,
      );

      const lockoutReason = wouldLockOut({
        resource: {
          fullDomain: desired.fullDomain,
          isPangolinDashboard: (options.writeAuthorization.pangolinDashboardHosts ?? []).some((h) =>
            hostMatches(desired.fullDomain, h),
          ),
          isLoxepSelf: (options.writeAuthorization.loxepSelfHosts ?? []).some((h) =>
            hostMatches(desired.fullDomain, h),
          ),
        },
        resultingRules,
        operatorContext: resolveLockoutOperatorContext(aliases, matchedResource),
        retiresAliasRuleNamed,
      });
      if (lockoutReason !== null) blockedStep = lockoutBlockedStep(lockoutReason);
    }

    if (blockedStep !== null) {
      await step({ step: "retire.blocked", ...blockedStep });
      await finish("partial", blockedStep.errorDetail);
      return {
        proxyResourceRuleId,
        proxyResourceId: resource.id,
        runId: run.id,
        status: "blocked",
        alreadyDisabled: false,
      };
    }

    const retirePayload: ProxyRulePayload = {
      action: targetObservedRule.action,
      match: targetObservedRule.match,
      value: targetObservedRule.value,
      priority: targetObservedRule.priority,
      enabled: false,
    };
    try {
      const applyResult = await options.provider.apply({
        kind: "update-rule",
        externalResourceId: matchedResource.externalResourceId,
        externalRuleId: targetObservedRule.externalRuleId,
        rule: retirePayload,
      });
      await step({
        step: "retire.rule",
        status: "succeeded",
        requestSummary: redact({ externalRuleId: targetObservedRule.externalRuleId, ...retirePayload }),
        responseSummary: redact(applyResult),
      });
    } catch (error) {
      const kind = errorKind(error);
      await step({
        step: "retire.rule",
        status: "failed",
        errorCode: kind,
        errorDetail: "pangolin rule update failed",
      });
      await finish("failed", `rule retire failed (${kind})`);
      if (error instanceof ProviderCallError) throw error;
      throw new ProviderCallError(kind, "pangolin rule retire failed", {
        proxyResourceRuleId,
        runId: run.id,
      });
    }

    await db
      .update(proxyResourceRules)
      .set({
        enabled: false,
        externalRuleId: targetObservedRule.externalRuleId,
        updatedAt: new Date(),
      })
      .where(eq(proxyResourceRules.id, ruleRow.id));

    await finish("succeeded", null);
    return {
      proxyResourceRuleId,
      proxyResourceId: resource.id,
      runId: run.id,
      status: "succeeded",
      alreadyDisabled: false,
    };
  }

  /** {@link enableRule} — mirrors `retireRule` exactly, with the outcome direction reversed. See its own interface doc for what differs (the preflight's `retiresAliasRuleNamed` is always `null` here). */
  async function enableRule(
    proxyResourceRuleId: string,
    options: {
      trigger: "intent_change" | "manual";
      provider: ProxyProviderPort;
      orgId: string;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
      writeAuthorization: ProxyWriteAuthorizationContext;
    },
  ): Promise<EnableProxyRuleResult> {
    assertRetireTriggerAllowed(options.trigger);
    const redact = options.redact ?? defaultProxyRedactor;

    const ruleRow = await requireRuleRow(db, proxyResourceRuleId);
    if (ruleRow.owner === "manual") {
      throw new InfrastructureValidationError(
        `rule ${proxyResourceRuleId} is manually owned — Loxep's reconciler never rewrites or re-enables a human's record`,
        { proxyResourceRuleId },
      );
    }

    const resource = await requireResource(db, ruleRow.proxyResourceId);
    const rules = await loadRules(db, resource.id);
    const domainName = await requireDomainName(db, resource.domainId);
    const aliases = await settings.get(ipAliasesSetting);

    const runRows = await db
      .insert(reconcileRuns)
      .values({
        kind: RECONCILE_PROXY_RESOURCE_ENABLE_RUN_KIND,
        subjectType: PROXY_RESOURCE_SUBJECT_TYPE,
        subjectId: resource.id,
        mode: "apply",
        trigger: options.trigger,
        actorUserId: options.actorUserId ?? null,
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

    let observed: ObservedProxyResource[];
    try {
      observed = await options.provider.read({ orgId: options.orgId });
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
        proxyResourceRuleId,
        runId: run.id,
      });
    }

    const matchedResource =
      observed.find((r) => r.externalResourceId === desired.externalResourceId) ??
      observed.find((r) => r.fullDomain === desired.fullDomain);
    if (matchedResource === undefined) {
      await step({
        step: "enable.resource-not-found",
        status: "failed",
        errorCode: "not_found",
        errorDetail: "this resource has no matching Pangolin object yet — nothing to re-enable",
      });
      await finish("failed", "resource not present at provider");
      throw new InfrastructureNotFoundError(
        `proxy resource ${resource.id} has no matching Pangolin resource yet`,
        { proxyResourceId: resource.id },
      );
    }

    const ruleIndex = rules.findIndex((r) => r.id === ruleRow.id);
    const targetDesiredRule = ruleIndex === -1 ? undefined : desired.rules[ruleIndex];
    if (targetDesiredRule === undefined) {
      throw new Error(`rule ${proxyResourceRuleId} not found among its own resource's rules`);
    }

    const targetObservedRule =
      (ruleRow.externalRuleId !== null
        ? matchedResource.rules.find((r) => r.externalRuleId === ruleRow.externalRuleId)
        : undefined) ??
      matchedResource.rules.find((r) => ruleNaturalKey(r) === ruleNaturalKey(targetDesiredRule));

    if (targetObservedRule === undefined) {
      await step({
        step: "enable.rule-not-found",
        status: "failed",
        errorCode: "not_found",
        errorDetail: "Pangolin has no rule matching this intent row — nothing to re-enable",
      });
      await finish("failed", "rule not present at provider");
      throw new InfrastructureNotFoundError(
        `rule ${proxyResourceRuleId} has no matching Pangolin rule`,
        { proxyResourceRuleId },
      );
    }

    if (targetObservedRule.enabled) {
      // Convergent no-op — see the module doc.
      await step({
        step: "enable.already-enabled",
        status: "succeeded",
        responseSummary: { externalRuleId: targetObservedRule.externalRuleId },
      });
      if (!ruleRow.enabled || ruleRow.externalRuleId !== targetObservedRule.externalRuleId) {
        await db
          .update(proxyResourceRules)
          .set({
            enabled: true,
            externalRuleId: targetObservedRule.externalRuleId,
            updatedAt: new Date(),
          })
          .where(eq(proxyResourceRules.id, ruleRow.id));
      }
      await finish("succeeded", null);
      return {
        proxyResourceRuleId,
        proxyResourceId: resource.id,
        runId: run.id,
        status: "succeeded",
        alreadyEnabled: true,
      };
    }

    let blockedStep: { status: "blocked"; errorCode: string; errorDetail: string } | null = null;
    try {
      assertWritePolicy({
        mode: "apply",
        trigger: options.trigger,
        policyTier: options.writeAuthorization.policyTier,
        operationTier: 2,
        actorIsAdmin: options.writeAuthorization.actorIsAdmin,
        unblockHint:
          `allow tier-2 (access_affecting) writes for connection ${options.writeAuthorization.connectionId} — ` +
          "flip infrastructure.provider_write_policy to at least 'access_affecting' for this connection " +
          "to re-enable a Pangolin rule",
      });
    } catch (error) {
      if (error instanceof WritePolicyError) blockedStep = writePolicyBlockedStep(error);
      else throw error;
    }

    if (blockedStep === null) {
      const aliasNameByExternalRuleId = buildAliasNameByExternalRuleId(
        rules,
        desired.rules,
        matchedResource.rules,
      );

      // `enableRule` flips the target rule to ENABLED in `resultingRules` —
      // the inverse of `retireRule`'s override — and `retiresAliasRuleNamed`
      // stays `null`: re-enabling never retires anything, so that clause
      // structurally cannot fire.
      const resultingRules: LockoutCheckRule[] = matchedResource.rules.map((rule) => ({
        action: rule.action,
        match: rule.match,
        value: rule.value,
        enabled: rule.externalRuleId === targetObservedRule.externalRuleId ? true : rule.enabled,
        aliasName: aliasNameByExternalRuleId.get(rule.externalRuleId) ?? null,
      }));

      const lockoutReason = wouldLockOut({
        resource: {
          fullDomain: desired.fullDomain,
          isPangolinDashboard: (options.writeAuthorization.pangolinDashboardHosts ?? []).some((h) =>
            hostMatches(desired.fullDomain, h),
          ),
          isLoxepSelf: (options.writeAuthorization.loxepSelfHosts ?? []).some((h) =>
            hostMatches(desired.fullDomain, h),
          ),
        },
        resultingRules,
        operatorContext: resolveLockoutOperatorContext(aliases, matchedResource),
        retiresAliasRuleNamed: null,
      });
      if (lockoutReason !== null) blockedStep = lockoutBlockedStep(lockoutReason);
    }

    if (blockedStep !== null) {
      await step({ step: "enable.blocked", ...blockedStep });
      await finish("partial", blockedStep.errorDetail);
      return {
        proxyResourceRuleId,
        proxyResourceId: resource.id,
        runId: run.id,
        status: "blocked",
        alreadyEnabled: false,
      };
    }

    const enablePayload: ProxyRulePayload = {
      action: targetObservedRule.action,
      match: targetObservedRule.match,
      value: targetObservedRule.value,
      priority: targetObservedRule.priority,
      enabled: true,
    };
    try {
      const applyResult = await options.provider.apply({
        kind: "update-rule",
        externalResourceId: matchedResource.externalResourceId,
        externalRuleId: targetObservedRule.externalRuleId,
        rule: enablePayload,
      });
      await step({
        step: "enable.rule",
        status: "succeeded",
        requestSummary: redact({ externalRuleId: targetObservedRule.externalRuleId, ...enablePayload }),
        responseSummary: redact(applyResult),
      });
    } catch (error) {
      const kind = errorKind(error);
      await step({
        step: "enable.rule",
        status: "failed",
        errorCode: kind,
        errorDetail: "pangolin rule update failed",
      });
      await finish("failed", `rule re-enable failed (${kind})`);
      if (error instanceof ProviderCallError) throw error;
      throw new ProviderCallError(kind, "pangolin rule re-enable failed", {
        proxyResourceRuleId,
        runId: run.id,
      });
    }

    await db
      .update(proxyResourceRules)
      .set({
        enabled: true,
        externalRuleId: targetObservedRule.externalRuleId,
        updatedAt: new Date(),
      })
      .where(eq(proxyResourceRules.id, ruleRow.id));

    await finish("succeeded", null);
    return {
      proxyResourceRuleId,
      proxyResourceId: resource.id,
      runId: run.id,
      status: "succeeded",
      alreadyEnabled: false,
    };
  }

  async function retireAliasFanOutRule(
    proxyResourceId: string,
    aliasName: string,
    options: {
      trigger: "intent_change" | "manual";
      provider: ProxyProviderPort;
      orgId: string;
      actorUserId?: string | null;
      redact?: ResponseRedactor;
      writeAuthorization: ProxyWriteAuthorizationContext;
    },
  ): Promise<RetireAliasFanOutResult> {
    assertRetireTriggerAllowed(options.trigger);
    const redact = options.redact ?? defaultProxyRedactor;

    const resource = await requireResource(db, proxyResourceId);
    const rules = await loadRules(db, resource.id);
    const domainName = await requireDomainName(db, resource.domainId);
    const aliases = await settings.get(ipAliasesSetting);
    const entry = aliases[aliasName];
    if (entry === undefined) {
      throw new InfrastructureNotFoundError(`ip alias "${aliasName}" not found`, { aliasName });
    }
    if (entry.previousAddress === null) {
      // Nothing has ever changed for this alias — a legitimate no-op
      // (ip-aliases.ts's own "a null retire is not an error" rule). No DB
      // write needed, so no run row either.
      return {
        proxyResourceId,
        aliasName,
        runId: null,
        status: "skipped",
        retiredCount: 0,
        blockedCount: 0,
        failedCount: 0,
      };
    }

    const aliasReference = formatIpAliasReference(aliasName);
    const targetRuleRows = rules.filter(
      (r) => r.owner === "dynamic_ip" && r.value === aliasReference,
    );
    if (targetRuleRows.length === 0) {
      return {
        proxyResourceId,
        aliasName,
        runId: null,
        status: "skipped",
        retiredCount: 0,
        blockedCount: 0,
        failedCount: 0,
      };
    }

    const previousValue = ipAliasCidrValue(entry.previousAddress);

    const runRows = await db
      .insert(reconcileRuns)
      .values({
        kind: RECONCILE_PROXY_RESOURCE_RETIRE_RUN_KIND,
        subjectType: PROXY_RESOURCE_SUBJECT_TYPE,
        subjectId: resource.id,
        mode: "apply",
        trigger: options.trigger,
        actorUserId: options.actorUserId ?? null,
      })
      .returning();
    const run = runRows[0];
    if (run === undefined) throw new Error("reconcile run insert returned no row");

    let sequence = 0;
    const step = async (entry2: {
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
        step: entry2.step,
        status: entry2.status,
        provider: "pangolin",
        requestSummary: entry2.requestSummary ?? null,
        responseSummary: entry2.responseSummary ?? null,
        errorCode: entry2.errorCode ?? null,
        errorDetail: entry2.errorDetail ?? null,
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

    let observed: ObservedProxyResource[];
    try {
      observed = await options.provider.read({ orgId: options.orgId });
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

    const matchedResource =
      observed.find((r) => r.externalResourceId === desired.externalResourceId) ??
      observed.find((r) => r.fullDomain === desired.fullDomain);
    if (matchedResource === undefined) {
      await step({
        step: "retire.resource-not-found",
        status: "failed",
        errorCode: "not_found",
        errorDetail: "this resource has no matching Pangolin object yet — nothing to retire",
      });
      await finish("failed", "resource not present at provider");
      throw new InfrastructureNotFoundError(
        `proxy resource ${resource.id} has no matching Pangolin resource yet`,
        { proxyResourceId: resource.id },
      );
    }

    let retiredCount = 0;
    let blockedCount = 0;
    let failedCount = 0;

    // Write-policy gate: checked ONCE — every candidate rule in this run
    // shares the same resolved connection and policy tier.
    let policyBlocked: { status: "blocked"; errorCode: string; errorDetail: string } | null = null;
    try {
      assertWritePolicy({
        mode: "apply",
        trigger: options.trigger,
        policyTier: options.writeAuthorization.policyTier,
        operationTier: 2,
        actorIsAdmin: options.writeAuthorization.actorIsAdmin,
        unblockHint:
          `allow tier-2 (access_affecting) writes for connection ${options.writeAuthorization.connectionId} — ` +
          "flip infrastructure.provider_write_policy to at least 'access_affecting' for this connection " +
          "to retire a superseded Pangolin rule",
      });
    } catch (error) {
      if (error instanceof WritePolicyError) policyBlocked = writePolicyBlockedStep(error);
      else throw error;
    }

    if (policyBlocked !== null) {
      await step({ step: "retire.blocked", ...policyBlocked });
      blockedCount = targetRuleRows.length;
    } else {
      const aliasNameByExternalRuleId = buildAliasNameByExternalRuleId(
        rules,
        desired.rules,
        matchedResource.rules,
      );

      for (const ruleRow of targetRuleRows) {
        const targetObservedRule = matchedResource.rules.find(
          (r) =>
            r.enabled &&
            r.action === ruleRow.action &&
            r.match === ruleRow.match &&
            r.value === previousValue,
        );
        if (targetObservedRule === undefined) {
          // Nothing live for the OLD address — already retired, never
          // created, or gone by some other means. Legitimate, not an error.
          await step({
            step: "retire.nothing-to-do",
            status: "succeeded",
            responseSummary: { proxyResourceRuleId: ruleRow.id, previousValue },
          });
          continue;
        }

        aliasNameByExternalRuleId.set(targetObservedRule.externalRuleId, aliasName);
        const resultingRules = toLockoutCheckRules(
          matchedResource.rules,
          aliasNameByExternalRuleId,
          targetObservedRule.externalRuleId,
        );

        const lockoutReason = wouldLockOut({
          resource: {
            fullDomain: desired.fullDomain,
            isPangolinDashboard: (options.writeAuthorization.pangolinDashboardHosts ?? []).some((h) =>
              hostMatches(desired.fullDomain, h),
            ),
            isLoxepSelf: (options.writeAuthorization.loxepSelfHosts ?? []).some((h) =>
              hostMatches(desired.fullDomain, h),
            ),
          },
          resultingRules,
          operatorContext: resolveLockoutOperatorContext(aliases, matchedResource),
          retiresAliasRuleNamed: aliasName,
        });
        if (lockoutReason !== null) {
          const blocked = lockoutBlockedStep(lockoutReason);
          await step({
            step: "retire.blocked",
            status: blocked.status,
            errorCode: blocked.errorCode,
            errorDetail: blocked.errorDetail,
            responseSummary: { proxyResourceRuleId: ruleRow.id },
          });
          blockedCount += 1;
          continue;
        }

        const retirePayload: ProxyRulePayload = {
          action: targetObservedRule.action,
          match: targetObservedRule.match,
          value: targetObservedRule.value,
          priority: targetObservedRule.priority,
          enabled: false,
        };
        try {
          const applyResult = await options.provider.apply({
            kind: "update-rule",
            externalResourceId: matchedResource.externalResourceId,
            externalRuleId: targetObservedRule.externalRuleId,
            rule: retirePayload,
          });
          await step({
            step: "retire.rule",
            status: "succeeded",
            requestSummary: redact({
              externalRuleId: targetObservedRule.externalRuleId,
              ...retirePayload,
            }),
            responseSummary: redact(applyResult),
          });
          retiredCount += 1;
        } catch (error) {
          const kind = errorKind(error);
          await step({
            step: "retire.rule",
            status: "failed",
            errorCode: kind,
            errorDetail: "pangolin rule update failed",
          });
          failedCount += 1;
        }
      }
    }

    const runFinishStatus: "succeeded" | "partial" =
      blockedCount > 0 || failedCount > 0 ? "partial" : "succeeded";
    await finish(runFinishStatus, null);

    const status: RetireAliasFanOutResult["status"] =
      blockedCount > 0 || failedCount > 0 ? "partial" : retiredCount > 0 ? "succeeded" : "skipped";

    return {
      proxyResourceId,
      aliasName,
      runId: run.id,
      status,
      retiredCount,
      blockedCount,
      failedCount,
    };
  }

  return {
    reconcile,
    reconcileDomain,
    listResourcesForDomain,
    listResourcesForHostingTarget,
    listRuns,
    listRulesReferencingAlias,
    retireRule,
    enableRule,
    retireAliasFanOutRule,
  };
}
