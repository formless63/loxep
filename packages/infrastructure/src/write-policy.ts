/**
 * The write-authorization model (Pangolin chain design milestone 3,
 * `loxep-acj.3`, "The write-risk model" — its six binding rules are law).
 *
 * This module builds the GATE, not a thing behind it: nothing here calls a
 * provider, and nothing here ships a Pangolin write verb. It is the shared
 * primitive `packages/infrastructure`'s reconcilers call before an apply, and
 * the shared primitive `packages/app`'s composition root and a future
 * milestone's Pangolin apply leg (`loxep-acj.4`, M4) both consume.
 *
 * ## The two independent gates this module provides
 *
 * ```text
 * assertWritePolicy   "is this connection, this trigger, and this actor
 *                       allowed to attempt a write of this tier AT ALL?"
 *                      — throws WritePolicyError; a caller catches it and
 *                        records a 'blocked' step (never a failure, never a
 *                        silent skip — rule 1/2).
 *
 * wouldLockOut         "even if the write is allowed, would APPLYING IT
 *                       remove the operator's own way back in?"
 *                      — a PURE predicate, no throw, no policy parameter at
 *                        all. It cannot be satisfied by raising a
 *                        connection's write-policy tier, by design (rule 6 /
 *                        "never bypassable by policy tier").
 * ```
 *
 * They are deliberately separate. `assertWritePolicy` is about WHO may write
 * and HOW MUCH; `wouldLockOut` is about WHETHER THIS SPECIFIC CHANGE removes
 * a way back in, which no policy setting can make safe. A caller applying a
 * tier-2 (or higher-risk) operation must pass both.
 *
 * ## `assertWritePolicy` — the generalized form of M2's `assertCheckModeOnly`
 *
 * `proxy.ts`'s M2 refusal was unconditional: any `mode: 'apply'` throws,
 * because the gate did not exist yet. This is that gate. The comparison is
 * `policyRank(connection's stored tier) >= operationTier`
 * ({@link ProviderWritePolicyTier}'s own ordinal — see `@loxep/domain`'s
 * `provider-write-policy.ts`), plus two structural refusals that no policy
 * tier can satisfy:
 *
 * - **rule 3**: a `'sweep'` or `'poll'` trigger may never apply a tier-2 (or
 *   higher) write — only `'manual'` and `'intent_change'` may. This is
 *   UNCONDITIONAL: raising the connection's policy tier does not unlock a
 *   scheduled tier-2 apply. A tier-1 (additive) write from `'poll'`/`'sweep'`
 *   IS structurally permitted — that is deliberate, and it is the seam M5's
 *   dynamic-IP auto-apply (not built here) is expected to use, gated by the
 *   `'additive'` policy tier and its own per-alias `autoApply` flag.
 * - **owner ruling, 2026-08-15 (`pangolin-credential-constraints` memory)**:
 *   "writes are ADMIN-ONLY in Loxep." `actorIsAdmin: false` — an explicit,
 *   known, non-admin human actor — always refuses, regardless of policy
 *   tier or operation tier. `actorIsAdmin: undefined` means "no human actor
 *   is attached to this apply" (a background job on a trigger other than a
 *   live admin session, e.g. `'intent_change'` enqueued by an automated
 *   detector); such a call has no actor to check and is gated by the policy
 *   tier and rule 3 alone. The FLIP that made the policy tier permissive in
 *   the first place is itself already admin-only
 *   (`setConnectionWritePolicy`, `apps/web/src/server/admin-functions.ts`),
 *   which is where "admin-only" is actually enforced for anything a
 *   background job later does under that policy.
 *
 * ## `wouldLockOut` — the self-lockout preflight
 *
 * A pure predicate over the RESULTING rule set (never the operation itself —
 * the design's own words), for the same reason `diffDnsRecords` is pure:
 * this is where the subtle bug lives, and only a predicate with no I/O can be
 * exhaustively tested. It refuses rather than warns — "a warning on the one
 * action that removes your way back in is a warning nobody reads twice."
 *
 * Deliberately NOT a rule-matching simulator: `ruleGrantsAnyAddress` below
 * does exact/`/32`-literal comparison only, never general CIDR-range
 * containment. Reimplementing Pangolin's own matcher is rule 13's
 * reimplementation trap with a security blast radius — this predicate
 * answers the one narrow question Loxep can answer honestly ("does the
 * resulting set still contain a rule that grants THIS operator"), not the
 * general one.
 *
 * ## Coordination note (loxep-acj.3 / loxep-acj.4, 2026-08-16)
 *
 * M4 is being built concurrently against this same working tree and, before
 * this module existed, authored its own placeholder gate here
 * (`connections.config.writePolicy`, a binary `read_only`/`allow` switch) so
 * its own work was not blocked. Nothing in the tree called it yet
 * (`proxy.ts`'s apply leg — M4's own scope — had not been wired), so this is
 * the real M3 contract superseding that placeholder rather than a conflicting
 * rewrite of consumed code. The registered-setting shape below (rather than
 * `connections.config`) is what the design document and the M3 bead's own
 * scope text specify — see `@loxep/domain`'s `provider-write-policy.ts` for
 * why a registered setting can express a per-connection map at all.
 */
import { providerWritePolicyTierRank } from "@loxep/domain";
import type { ProviderWritePolicyTier } from "@loxep/domain";
import { InfrastructureValidationError } from "./errors.ts";
import type { ProxyOperation } from "./proxy-port.ts";

/* --------------------------------------------------------------- tiers --- */

/**
 * The structural risk tier of a {@link ProxyOperation}'s KIND — `create-*`
 * is always tier 1 (additive), `update-*` is always tier 2
 * (access-affecting). There is no tier-3 operation KIND: Pangolin's rule
 * `enabled` flag makes retirement `update-rule` with `rule.enabled = false`
 * (still structurally tier 2), and whether a GIVEN tier-2 operation is
 * actually lockout-class is exactly the question {@link wouldLockOut}
 * answers — it is a property of the resulting state, not of the operation's
 * kind, so it cannot be read off the union alone.
 */
export type WriteOperationTier = 1 | 2;

/** {@link WriteOperationTier} for one {@link ProxyOperation}. */
export function proxyOperationTier(operation: ProxyOperation): WriteOperationTier {
  switch (operation.kind) {
    case "create-resource":
    case "create-target":
    case "create-rule":
      return 1;
    case "update-resource":
    case "update-target":
    case "update-rule":
      return 2;
  }
}

/** The highest tier among a batch of operations — what a plan's apply must clear. */
export function highestOperationTier(
  operations: readonly ProxyOperation[],
): WriteOperationTier | null {
  let highest: WriteOperationTier | null = null;
  for (const operation of operations) {
    const tier = proxyOperationTier(operation);
    if (highest === null || tier > highest) highest = tier;
  }
  return highest;
}

/* ------------------------------------------------------- write policy --- */

/**
 * Rule 1's two named refusal reasons. `'write_policy'` is a stored-tier
 * refusal (the connection's policy is too low, or the actor/trigger
 * structurally cannot apply this tier). `'credential_scope'` is for a
 * connection whose CREDENTIAL is what makes any write unsafe regardless of
 * policy — Purelymail's admin token has no scoping at all ("there is no
 * safe-by-construction credential to ask for. Safety has to come from
 * Loxep"), which is why the design's own worked example
 * (`purelymail.add-domain`) blocks with this reason rather than
 * `'write_policy'` even though the mechanism enforcing it IS the policy
 * setting. Callers choose which reason applies; this module does not guess.
 */
export type WritePolicyBlockedReason = "write_policy" | "credential_scope";

/**
 * An apply was refused by the write-authorization gate. Never thrown for
 * `mode: 'check'` — reads are always permitted, no gate, no confirmation, no
 * policy flag (tier 0's own rule).
 */
export class WritePolicyError extends InfrastructureValidationError {
  readonly blockedReason: WritePolicyBlockedReason;
  constructor(
    message: string,
    blockedReason: WritePolicyBlockedReason,
    detail: Record<string, unknown> = {},
  ) {
    super(message, detail);
    this.name = "WritePolicyError";
    this.blockedReason = blockedReason;
  }
}

export interface AssertWritePolicyInput {
  mode: "apply" | "check";
  trigger: "intent_change" | "sweep" | "manual" | "poll";
  /** The connection's stored tier — `resolveProviderWritePolicy`'s own `'read_only'` fallback when unset. */
  policyTier: ProviderWritePolicyTier;
  /** The tier of the operation(s) about to be applied — the highest tier among them. */
  operationTier: WriteOperationTier;
  /**
   * `true`/`false` when a known human actor is attached to this apply
   * (`false` always refuses — writes are admin-only); `undefined` when no
   * human actor is attached (a background trigger) — see the module doc.
   */
  actorIsAdmin?: boolean;
  /** Which reason a refusal carries — see {@link WritePolicyBlockedReason}. Defaults to `'write_policy'`. */
  blockedReason?: WritePolicyBlockedReason;
  /**
   * Required, operator-facing copy naming the exact flip that unblocks this
   * — rule 1/2's "it names the exact flip that unblocks it", never a bare
   * "blocked".
   */
  unblockHint: string;
}

/**
 * Throws {@link WritePolicyError} when this apply must be refused; returns
 * normally otherwise (including always, for `mode: 'check'`). See the module
 * doc for the exact rules this enforces.
 */
export function assertWritePolicy(input: AssertWritePolicyInput): void {
  if (input.mode !== "apply") return;

  // Rule 3: unconditional, regardless of policy tier or actor.
  if (
    (input.trigger === "sweep" || input.trigger === "poll") &&
    input.operationTier >= 2
  ) {
    throw new WritePolicyError(
      `a '${input.trigger}' trigger may never apply a tier-${input.operationTier} write — only 'manual' or 'intent_change' triggers may (the write-authorization model's rule 3)`,
      input.blockedReason ?? "write_policy",
      { trigger: input.trigger, operationTier: input.operationTier },
    );
  }

  // Owner ruling: writes are admin-only. Only refuses when a KNOWN non-admin
  // actor is attached — see the module doc for why `undefined` passes.
  if (input.actorIsAdmin === false) {
    throw new WritePolicyError(
      "writes are admin-only in Loxep",
      input.blockedReason ?? "write_policy",
      { actorIsAdmin: false },
    );
  }

  if (providerWritePolicyTierRank(input.policyTier) < input.operationTier) {
    throw new WritePolicyError(
      input.unblockHint,
      input.blockedReason ?? "write_policy",
      { policyTier: input.policyTier, operationTier: input.operationTier },
    );
  }
}

/**
 * The `reconcile_run_steps` fields a caught {@link WritePolicyError} becomes
 * — rule 2's 'blocked' step state: never a silent skip, never a failure. A
 * caller still owns finishing the containing run `'partial'` (already a
 * valid `reconcile_runs.status`, no migration needed) and returning
 * normally, matching `mail-sync.ts`'s existing `awaiting_delegation`
 * precedent for "correctly waiting is not a failure".
 */
export function writePolicyBlockedStep(error: WritePolicyError): {
  status: "blocked";
  errorCode: WritePolicyBlockedReason;
  errorDetail: string;
} {
  return {
    status: "blocked",
    errorCode: error.blockedReason,
    errorDetail: error.message,
  };
}

/* ------------------------------------------------ self-lockout preflight --- */

/** One rule in the RESULTING set, in the vocabulary {@link wouldLockOut} needs — a subset of `ObservedProxyRule`/`DesiredProxyRule`. */
export interface LockoutCheckRule {
  action: string;
  match: string;
  value: string;
  enabled: boolean;
  /**
   * The `ip_aliases` name this rule's value resolves from, or `null` for a
   * literal. M5's own field to populate at materialization — this module
   * only reads it, never resolves an alias itself.
   */
  aliasName: string | null;
}

export interface LockoutCheckOperatorContext {
  /**
   * Address(es) the operator currently holds, compared LITERALLY against a
   * rule's `value` (optionally trimmed of a trailing `/32`) — never a
   * CIDR-range containment check. See the module doc's "not a simulator"
   * note.
   */
  currentAddresses: readonly string[];
  /**
   * Non-address auth methods the operator holds independent of any address
   * rule (an SSO identity, a resource password). Non-empty means the
   * operator can still get in some other way even with no matching address
   * rule.
   */
  heldAuthMethods: readonly string[];
}

export interface WouldLockOutInput {
  resource: {
    fullDomain: string | null;
    /** This resource IS the Pangolin connection's own dashboard resource. */
    isPangolinDashboard: boolean;
    /** This resource fronts THIS Loxep installation itself. */
    isLoxepSelf: boolean;
  };
  /** The rule set AFTER the proposed operation — never the operation itself. */
  resultingRules: readonly LockoutCheckRule[];
  operatorContext: LockoutCheckOperatorContext;
  /**
   * Set only when the operation under evaluation retires (disables) a rule
   * that referenced this named alias. `null`/`undefined` for every other
   * operation (a create, or an update that does not disable an
   * alias-referencing rule).
   */
  retiresAliasRuleNamed?: string | null;
}

export type WouldLockOutReason =
  | "loxep_self"
  | "pangolin_dashboard_self"
  | "no_operator_access"
  | "retires_only_live_alias_rule";

/** A `/32`-literal-only strip — see the module doc's "not a simulator" note. */
function ruleValueMatchesAddress(value: string, address: string): boolean {
  const literal = value.endsWith("/32") ? value.slice(0, -"/32".length) : value;
  return literal === address;
}

function ruleGrantsAnyAddress(
  rule: LockoutCheckRule,
  addresses: readonly string[],
): boolean {
  if (!rule.enabled) return false;
  if (rule.action !== "ACCEPT") return false;
  if (rule.match !== "CIDR" && rule.match !== "IP") return false;
  return addresses.some((address) => ruleValueMatchesAddress(rule.value, address));
}

/**
 * Refuses (never warns) a tier ≥ 2 apply that would remove the operator's
 * own way back in. Pure — no I/O, no clock, no policy parameter (see the
 * module doc: this cannot be satisfied by a connection's write-policy tier,
 * by design). Returns `null` when the apply is safe by this predicate's own
 * narrow question.
 */
export function wouldLockOut(input: WouldLockOutInput): WouldLockOutReason | null {
  if (input.resource.isLoxepSelf) return "loxep_self";
  if (input.resource.isPangolinDashboard) return "pangolin_dashboard_self";

  const grantsOperatorAddress = input.resultingRules.some((rule) =>
    ruleGrantsAnyAddress(rule, input.operatorContext.currentAddresses),
  );
  const operatorHoldsAuthMethod = input.operatorContext.heldAuthMethods.length > 0;
  if (!grantsOperatorAddress && !operatorHoldsAuthMethod) {
    return "no_operator_access";
  }

  const retiredAlias = input.retiresAliasRuleNamed ?? null;
  if (retiredAlias !== null) {
    const stillLive = input.resultingRules.some(
      (rule) => rule.enabled && rule.aliasName === retiredAlias,
    );
    if (!stillLive) return "retires_only_live_alias_rule";
  }

  return null;
}

/** A tier ≥ 2 apply was refused by the self-lockout preflight. */
export class SelfLockoutError extends InfrastructureValidationError {
  readonly reason: WouldLockOutReason;
  constructor(message: string, reason: WouldLockOutReason, detail: Record<string, unknown> = {}) {
    super(message, detail);
    this.name = "SelfLockoutError";
    this.reason = reason;
  }
}

const WOULD_LOCK_OUT_MESSAGES: Record<WouldLockOutReason, string> = {
  loxep_self:
    "refused: this resource fronts Loxep itself — manage it from the Pangolin dashboard directly, out of band",
  pangolin_dashboard_self:
    "refused: this is the Pangolin dashboard's own resource — Loxep never manages it",
  no_operator_access:
    "refused: the resulting rule set would grant the operator neither a matching address rule nor an auth method they hold",
  retires_only_live_alias_rule:
    "refused: this retires the only live rule referencing this alias — add the replacement first (add-then-retire, rule 2)",
};

/**
 * Throws {@link SelfLockoutError} when {@link wouldLockOut} refuses; returns
 * normally otherwise. A convenience wrapper for callers that want
 * throw-on-refuse ergonomics — the exhaustively tested primitive is the pure
 * function above, not this wrapper.
 */
export function assertWouldNotLockOut(input: WouldLockOutInput): void {
  const reason = wouldLockOut(input);
  if (reason !== null) {
    throw new SelfLockoutError(WOULD_LOCK_OUT_MESSAGES[reason], reason, {
      fullDomain: input.resource.fullDomain,
    });
  }
}
