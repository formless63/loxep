/**
 * Dynamic-IP named aliases: materialization and the add-then-retire fan-out
 * plan (Pangolin chain design milestone 5, `loxep-acj.5`).
 *
 * `@loxep/domain`'s `ip-aliases.ts` owns the setting's SHAPE (the schema, the
 * `alias:<name>` reference syntax); this module owns the two PURE operations
 * that shape feeds:
 *
 * ```text
 * materializeProxyRuleValue   'alias:home' + {home: {address: ...}}
 *                                -> '203.0.113.7/32', pure, no I/O
 *                                -> throws MaterializationError when the
 *                                   alias is unresolvable (an ERROR, never a
 *                                   fallback — the identical rule
 *                                   materialize.ts's resolveHostingAddress
 *                                   already enforces for a broken fronting
 *                                   chain, applied here to the case where
 *                                   publishing the WRONG thing removes
 *                                   access instead of adding it)
 *
 * planIpAliasFanOut            an alias's old/new address + the
 *                                dynamic_ip-owned rules that reference it
 *                                -> one ADD payload and, when a live rule for
 *                                   the OLD address is still observed at the
 *                                   provider, one RETIRE payload (enabled:
 *                                   false) per affected rule — never emitted
 *                                   as a single replace
 * ```
 *
 * ## Why materialization resolves to a LITERAL, and the row's own `value`
 * ## column never changes
 *
 * `proxy_resource_rules.value` stores the STABLE REFERENCE (`alias:home`)
 * forever — never the resolved literal — so the row's own
 * `proxy_resource_rules_natural_key_uq` (`proxy_resource_id, action, match,
 * value`) never collides across an address change and the row's identity
 * survives however many times the alias's address changes. `proxy.ts`'s
 * `buildDesired()` is the one caller that resolves the reference into a
 * `DesiredProxyRule.value` a provider request can actually carry — this
 * module supplies that resolution, not the write site.
 *
 * ## Why `planIpAliasFanOut` never actually retires anything itself
 *
 * The design's own rule 2 (add-then-retire) makes retirement a SEPARATE,
 * LATER, tier-3 action (`loxep-acj.7`, M7) — this milestone's own scope text
 * is explicit: "Retiring the previous address is a separate tier-3 action
 * ... and the design deliberately makes that the slow half." This function
 * therefore returns the retire half as DATA (an operator-reviewable plan, and
 * the shape `wouldLockOut`'s `retiresAliasRuleNamed` preflight clause is
 * built to evaluate once M7 actually applies it) — it never calls
 * `ProxyProviderPort.apply()` and this module takes no provider dependency at
 * all. The ADD half needs no bespoke apply path either: because no milestone
 * has ever persisted `proxy_resource_rules.externalRuleId` back after a
 * create (M4's own gap — resources self-retire their id, rules do not), a
 * changed alias value makes `planProxyResourceOperations`'s ordinary natural-
 * key match fail to find the (now differently-valued) desired rule among
 * observed rules, so it emits an ordinary `create-rule` — the SAME tier-1,
 * ledgered path M4 already ships, ADD-shaped by construction, not by a
 * special case. `proxy.ts`'s own module doc cross-references this.
 */
import {
  IP_ALIAS_REFERENCE_PREFIX,
  ipAliasCidrValue,
  parseIpAliasReference,
} from "@loxep/domain";
import type { IpAliasMap } from "@loxep/domain";
import { MaterializationError } from "./errors.ts";
import type { ObservedProxyResource, ProxyRulePayload } from "./proxy-port.ts";

export { IP_ALIAS_REFERENCE_PREFIX };

/** {@link materializeProxyRuleValue}'s result: the literal value a provider request can carry, plus which alias (if any) it came from. */
export interface MaterializedProxyRuleValue {
  /** The literal `value` to send to Pangolin — unchanged from `rawValue` when it was already a literal. */
  value: string;
  /** The `ip_aliases` name this value was resolved from, or `null` for an ordinary literal. */
  aliasName: string | null;
}

/**
 * Resolve one `proxy_resource_rules.value` — a literal, or an `alias:<name>`
 * reference — into the literal a provider request needs. PURE: no I/O, no
 * clock. Throws {@link MaterializationError} when `rawValue` references an
 * alias with no registered entry — the design's own "unresolvable alias is
 * an error, not a fallback" rule.
 */
export function materializeProxyRuleValue(
  rawValue: string,
  aliases: IpAliasMap,
): MaterializedProxyRuleValue {
  const aliasName = parseIpAliasReference(rawValue);
  if (aliasName === null) return { value: rawValue, aliasName: null };
  const entry = aliases[aliasName];
  if (entry === undefined) {
    throw new MaterializationError(
      `rule value "${rawValue}" references dynamic-IP alias "${aliasName}", which has no registered infrastructure.ip_aliases entry — an unresolvable alias is refused, never silently dropped or fronted with a stale literal`,
      { aliasName },
    );
  }
  return { value: ipAliasCidrValue(entry.address), aliasName };
}

/** One `dynamic_ip`-owned rule's template fields — action/match/priority/enabled travel from intent; the row's own `value` (`alias:<name>`) is not part of this input because the caller already knows which alias changed. */
export interface IpAliasFanOutRuleInput {
  action: string;
  match: string;
  priority: number;
  enabled: boolean;
}

/** One resource's `dynamic_ip` rules bound to the alias under evaluation, plus its currently observed provider state (`null` when the resource has not been created at the provider yet). */
export interface IpAliasFanOutResourceInput {
  proxyResourceId: string;
  observed: ObservedProxyResource | null;
  rules: readonly IpAliasFanOutRuleInput[];
}

/** One rule's add-then-retire pair. */
export interface IpAliasFanOutRuleAction {
  proxyResourceId: string;
  /** The new rule to create — tier 1, ledgered through the ordinary `create-rule` path. Never applied by THIS function. */
  add: ProxyRulePayload;
  /**
   * The previously-live rule to retire (`enabled: false`), once the operator
   * (or M7) chooses to. `null` when no live rule for the PREVIOUS address was
   * found at the provider — either this is the alias's first-ever
   * materialization (`previousAddress === null`), or the resource has no
   * observed state yet, or the old rule was already retired by some other
   * means. A `null` retire is not an error: "nothing to retire yet" is a
   * legitimate state, not a failure.
   */
  retire: { externalRuleId: string; rule: ProxyRulePayload } | null;
}

export interface IpAliasFanOutPlan {
  aliasName: string;
  previousAddress: string | null;
  newAddress: string;
  actions: IpAliasFanOutRuleAction[];
  /** Distinct resources referenced by `actions` — the notification's own "N rules across M resources" count. */
  resourceCount: number;
  /** `actions.length` — one row per affected rule. */
  ruleCount: number;
}

/**
 * Build the add-then-retire fan-out plan for one alias's address change.
 * PURE: no I/O, no clock, no provider call — matches `diffDnsRecords` and
 * `planProxyResourceOperations`'s own purity, for the identical reason: this
 * is where the subtle bug ("did I retire the wrong rule") would live, and
 * only a predicate/planner with no I/O can be exhaustively tested.
 */
export function planIpAliasFanOut(input: {
  aliasName: string;
  previousAddress: string | null;
  newAddress: string;
  resources: readonly IpAliasFanOutResourceInput[];
}): IpAliasFanOutPlan {
  const newValue = ipAliasCidrValue(input.newAddress);
  const previousValue =
    input.previousAddress === null ? null : ipAliasCidrValue(input.previousAddress);

  const actions: IpAliasFanOutRuleAction[] = [];
  for (const resource of input.resources) {
    for (const rule of resource.rules) {
      const add: ProxyRulePayload = {
        action: rule.action,
        match: rule.match,
        value: newValue,
        priority: rule.priority,
        enabled: rule.enabled,
      };

      let retire: IpAliasFanOutRuleAction["retire"] = null;
      if (previousValue !== null && resource.observed !== null) {
        const observedRule = resource.observed.rules.find(
          (r) =>
            r.enabled &&
            r.action === rule.action &&
            r.match === rule.match &&
            r.value === previousValue,
        );
        if (observedRule !== undefined) {
          retire = {
            externalRuleId: observedRule.externalRuleId,
            rule: {
              action: observedRule.action,
              match: observedRule.match,
              value: observedRule.value,
              priority: observedRule.priority,
              enabled: false,
            },
          };
        }
      }

      actions.push({ proxyResourceId: resource.proxyResourceId, add, retire });
    }
  }

  return {
    aliasName: input.aliasName,
    previousAddress: input.previousAddress,
    newAddress: input.newAddress,
    actions,
    resourceCount: new Set(actions.map((a) => a.proxyResourceId)).size,
    ruleCount: actions.length,
  };
}
