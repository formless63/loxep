/**
 * `ip-aliases.ts`: alias materialization (pure resolution, unresolvable
 * refusal) and the add-then-retire fan-out plan. Pure — no database, no
 * provider, no clock — mirroring `proxy-port.test.ts`'s own discipline.
 */
import { describe, expect, it } from "vitest";
import { MaterializationError, wouldLockOut } from "../src/index.ts";
import type { LockoutCheckRule } from "../src/index.ts";
import {
  materializeProxyRuleValue,
  planIpAliasFanOut,
} from "../src/ip-aliases.ts";
import type {
  IpAliasFanOutResourceInput,
  IpAliasFanOutRuleInput,
} from "../src/ip-aliases.ts";
import type { IpAliasMap } from "@loxep/domain";
import type { ObservedProxyResource, ObservedProxyRule } from "../src/proxy-port.ts";

function aliasMap(overrides: IpAliasMap = {}): IpAliasMap {
  return {
    home: {
      address: "203.0.113.7",
      source: "manual",
      hostname: null,
      connectionId: null,
      siteId: null,
      previousAddress: "203.0.113.4",
      observedAt: "2026-08-16T00:00:00.000Z",
      confirmedAt: "2026-08-15T00:00:00.000Z",
      autoApply: false,
    },
    ...overrides,
  };
}

describe("materializeProxyRuleValue", () => {
  it("returns a literal value unchanged, with aliasName null", () => {
    const result = materializeProxyRuleValue("198.51.100.9/32", aliasMap());
    expect(result).toEqual({ value: "198.51.100.9/32", aliasName: null });
  });

  it("resolves 'alias:<name>' to the alias's current address as a /32 CIDR", () => {
    const result = materializeProxyRuleValue("alias:home", aliasMap());
    expect(result).toEqual({ value: "203.0.113.7/32", aliasName: "home" });
  });

  it("refuses (MaterializationError, never a fallback) when the alias has no registered entry", () => {
    expect(() => materializeProxyRuleValue("alias:office", aliasMap())).toThrow(
      MaterializationError,
    );
  });

  it("refuses when the alias map is entirely empty — never silently treats the reference as a literal", () => {
    expect(() => materializeProxyRuleValue("alias:home", {})).toThrow(
      MaterializationError,
    );
  });

  it("a malformed alias reference (empty name) is NOT parsed as a reference and passes through as a literal", () => {
    // 'alias:' with nothing after it fails `ipAliasNameSchema`, so
    // `parseIpAliasReference` returns null and this is treated as an
    // ordinary (almost certainly wrong, but not this function's problem)
    // literal value rather than throwing.
    const result = materializeProxyRuleValue("alias:", aliasMap());
    expect(result).toEqual({ value: "alias:", aliasName: null });
  });
});

function rule(overrides: Partial<IpAliasFanOutRuleInput> = {}): IpAliasFanOutRuleInput {
  return { action: "ACCEPT", match: "CIDR", priority: 100, enabled: true, ...overrides };
}

function observedRule(overrides: Partial<ObservedProxyRule> = {}): ObservedProxyRule {
  return {
    externalRuleId: "900",
    action: "ACCEPT",
    match: "CIDR",
    value: "203.0.113.4/32",
    priority: 100,
    enabled: true,
    ...overrides,
  };
}

function observedResource(rules: ObservedProxyRule[] = []): ObservedProxyResource {
  return {
    externalResourceId: "42",
    niceId: "brave-otter",
    name: "api",
    fullDomain: "api.example.com",
    domainId: "7",
    subdomain: "api",
    mode: "http",
    proxyPort: null,
    ssl: true,
    enabled: true,
    ssoEnabled: null,
    blockAccess: false,
    applyRules: true,
    emailWhitelistEnabled: null,
    targets: [],
    rules,
  };
}

describe("planIpAliasFanOut", () => {
  it("emits ADD only, no retire, when this is the alias's first-ever materialization (no previousAddress)", () => {
    const resources: IpAliasFanOutResourceInput[] = [
      { proxyResourceId: "r1", observed: observedResource([]), rules: [rule()] },
    ];
    const plan = planIpAliasFanOut({
      aliasName: "home",
      previousAddress: null,
      newAddress: "203.0.113.7",
      resources,
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.add).toEqual({
      action: "ACCEPT",
      match: "CIDR",
      value: "203.0.113.7/32",
      priority: 100,
      enabled: true,
    });
    expect(plan.actions[0]?.retire).toBeNull();
  });

  it("add-then-retire: ADD carries the NEW address, RETIRE carries the OLD address with enabled:false — never a single replace", () => {
    const resources: IpAliasFanOutResourceInput[] = [
      {
        proxyResourceId: "r1",
        observed: observedResource([observedRule({ externalRuleId: "900", value: "203.0.113.4/32" })]),
        rules: [rule()],
      },
    ];
    const plan = planIpAliasFanOut({
      aliasName: "home",
      previousAddress: "203.0.113.4",
      newAddress: "203.0.113.7",
      resources,
    });
    expect(plan.actions).toHaveLength(1);
    const [action] = plan.actions;
    expect(action?.add.value).toBe("203.0.113.7/32");
    expect(action?.add.enabled).toBe(true);
    expect(action?.retire).toEqual({
      externalRuleId: "900",
      rule: {
        action: "ACCEPT",
        match: "CIDR",
        value: "203.0.113.4/32",
        priority: 100,
        enabled: false,
      },
    });
  });

  it("retire is null when no live rule for the OLD address is observed at the provider (nothing to retire yet is not an error)", () => {
    const resources: IpAliasFanOutResourceInput[] = [
      { proxyResourceId: "r1", observed: observedResource([]), rules: [rule()] },
    ];
    const plan = planIpAliasFanOut({
      aliasName: "home",
      previousAddress: "203.0.113.4",
      newAddress: "203.0.113.7",
      resources,
    });
    expect(plan.actions[0]?.retire).toBeNull();
  });

  it("retire is null when the resource has no observed provider state yet", () => {
    const resources: IpAliasFanOutResourceInput[] = [
      { proxyResourceId: "r1", observed: null, rules: [rule()] },
    ];
    const plan = planIpAliasFanOut({
      aliasName: "home",
      previousAddress: "203.0.113.4",
      newAddress: "203.0.113.7",
      resources,
    });
    expect(plan.actions[0]?.add.value).toBe("203.0.113.7/32");
    expect(plan.actions[0]?.retire).toBeNull();
  });

  it("ignores a DISABLED rule at the old address — never retires something already inert", () => {
    const resources: IpAliasFanOutResourceInput[] = [
      {
        proxyResourceId: "r1",
        observed: observedResource([
          observedRule({ externalRuleId: "900", value: "203.0.113.4/32", enabled: false }),
        ]),
        rules: [rule()],
      },
    ];
    const plan = planIpAliasFanOut({
      aliasName: "home",
      previousAddress: "203.0.113.4",
      newAddress: "203.0.113.7",
      resources,
    });
    expect(plan.actions[0]?.retire).toBeNull();
  });

  it("fans out across multiple resources and multiple rules per resource, counting distinct resources correctly", () => {
    const resources: IpAliasFanOutResourceInput[] = [
      {
        proxyResourceId: "r1",
        observed: observedResource([observedRule({ externalRuleId: "900", value: "203.0.113.4/32" })]),
        rules: [rule(), rule({ priority: 200 })],
      },
      {
        proxyResourceId: "r2",
        observed: observedResource([observedRule({ externalRuleId: "901", value: "203.0.113.4/32" })]),
        rules: [rule({ priority: 50 })],
      },
    ];
    const plan = planIpAliasFanOut({
      aliasName: "home",
      previousAddress: "203.0.113.4",
      newAddress: "203.0.113.7",
      resources,
    });
    expect(plan.ruleCount).toBe(3);
    expect(plan.resourceCount).toBe(2);
    expect(plan.actions.every((a) => a.retire !== null)).toBe(true);
  });

  it("is idempotent in shape: calling it again with the same old/new addresses produces the identical plan (no hidden state)", () => {
    const resources: IpAliasFanOutResourceInput[] = [
      {
        proxyResourceId: "r1",
        observed: observedResource([observedRule({ externalRuleId: "900", value: "203.0.113.4/32" })]),
        rules: [rule()],
      },
    ];
    const input = {
      aliasName: "home",
      previousAddress: "203.0.113.4",
      newAddress: "203.0.113.7",
      resources,
    };
    expect(planIpAliasFanOut(input)).toEqual(planIpAliasFanOut(input));
  });
});

/**
 * Ground: `bd show loxep-acj.5` — "wouldLockOut still refuses a plan that
 * would retire the only live alias rule on a resource fronting the
 * operator (the case M3 built for you)." `write-policy.test.ts` already
 * exercises `wouldLockOut`'s `retiresAliasRuleNamed` clause directly with
 * hand-built rows; these two tests instead prove the WIRING — that feeding
 * `planIpAliasFanOut`'s own `retire` output through to `wouldLockOut`
 * (the shape M7's future apply orchestration will actually pass) refuses
 * exactly when the fan-out's retire target is the resource's only live
 * rule for this alias, and permits it otherwise. M5 never calls
 * `wouldLockOut` itself (it never applies a retire — see this module's own
 * doc), so this is the proof that the plan it DOES produce is preflight-
 * shaped, not a claim that M5 wires the preflight into an apply path.
 */
describe("planIpAliasFanOut's retire output, fed through wouldLockOut", () => {
  function resultingRulesAfterRetire(
    observed: ObservedProxyResource,
    retiredExternalRuleId: string,
    aliasName: string,
  ): LockoutCheckRule[] {
    return observed.rules.map((r) => ({
      action: r.action,
      match: r.match,
      value: r.value,
      enabled: r.externalRuleId === retiredExternalRuleId ? false : r.enabled,
      aliasName,
    }));
  }

  it("refuses: the fan-out's retire target is the ONLY live rule referencing this alias on the resource", () => {
    const resource = observedResource([
      observedRule({ externalRuleId: "900", value: "203.0.113.4/32" }),
    ]);
    const plan = planIpAliasFanOut({
      aliasName: "home",
      previousAddress: "203.0.113.4",
      newAddress: "203.0.113.7",
      resources: [{ proxyResourceId: "r1", observed: resource, rules: [rule()] }],
    });
    const retire = plan.actions[0]?.retire;
    expect(retire).not.toBeNull();

    const reason = wouldLockOut({
      resource: { fullDomain: "api.example.com", isPangolinDashboard: false, isLoxepSelf: false },
      resultingRules: resultingRulesAfterRetire(resource, retire!.externalRuleId, "home"),
      operatorContext: { currentAddresses: [], heldAuthMethods: ["sso"] },
      retiresAliasRuleNamed: "home",
    });
    expect(reason).toBe("retires_only_live_alias_rule");
  });

  it("permits: another enabled rule still references the same alias after the fan-out's retire is applied", () => {
    const resource = observedResource([
      observedRule({ externalRuleId: "900", value: "203.0.113.4/32" }),
      // The NEW address's rule, already added by the ADD half — still live.
      observedRule({ externalRuleId: "901", value: "203.0.113.7/32" }),
    ]);
    const plan = planIpAliasFanOut({
      aliasName: "home",
      previousAddress: "203.0.113.4",
      newAddress: "203.0.113.7",
      resources: [{ proxyResourceId: "r1", observed: resource, rules: [rule()] }],
    });
    const retire = plan.actions[0]?.retire;
    expect(retire).not.toBeNull();

    const reason = wouldLockOut({
      resource: { fullDomain: "api.example.com", isPangolinDashboard: false, isLoxepSelf: false },
      resultingRules: resultingRulesAfterRetire(resource, retire!.externalRuleId, "home"),
      operatorContext: { currentAddresses: [], heldAuthMethods: ["sso"] },
      retiresAliasRuleNamed: "home",
    });
    expect(reason).toBeNull();
  });
});
