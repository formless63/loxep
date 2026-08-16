/**
 * The write-authorization model (Pangolin chain design M3, `loxep-acj.3`):
 * `assertWritePolicy` and the self-lockout preflight `wouldLockOut`. Pure —
 * no database, no provider, no clock — for the same reason `diffDnsRecords`'s
 * own suite is: this is where the subtle bug lives.
 */
import { describe, expect, it } from "vitest";
import {
  SelfLockoutError,
  WritePolicyError,
  assertWouldNotLockOut,
  assertWritePolicy,
  highestOperationTier,
  proxyOperationTier,
  wouldLockOut,
  writePolicyBlockedStep,
} from "../src/index.ts";
import type {
  AssertWritePolicyInput,
  LockoutCheckRule,
  ProxyOperation,
  WouldLockOutInput,
} from "../src/index.ts";

/* ------------------------------------------------------- operation tiers --- */

describe("proxyOperationTier", () => {
  it("classes every create-* operation as tier 1", () => {
    const creates: ProxyOperation[] = [
      { kind: "create-resource", resource: { name: "a", domainId: "1", subdomain: null, mode: "http" } },
      { kind: "create-target", externalResourceId: "1", target: { siteId: "1", ip: "10.0.0.1", port: 80 } },
      { kind: "create-rule", externalResourceId: "1", rule: { action: "ACCEPT", match: "CIDR", value: "1.2.3.4/32", priority: 1, enabled: true } },
    ];
    for (const op of creates) expect(proxyOperationTier(op)).toBe(1);
  });

  it("classes every update-* operation as tier 2, including a disable (retirement)", () => {
    const updates: ProxyOperation[] = [
      { kind: "update-resource", externalResourceId: "1", resource: { enabled: false } },
      { kind: "update-target", externalTargetId: "1", target: { enabled: false } },
      { kind: "update-rule", externalResourceId: "1", externalRuleId: "1", rule: { action: "ACCEPT", match: "CIDR", value: "1.2.3.4/32", priority: 1, enabled: false } },
    ];
    for (const op of updates) expect(proxyOperationTier(op)).toBe(2);
  });

  it("highestOperationTier finds the max across a batch, and null for an empty batch", () => {
    expect(highestOperationTier([])).toBeNull();
    expect(
      highestOperationTier([
        { kind: "create-resource", resource: { name: "a", domainId: "1", subdomain: null, mode: "http" } },
      ]),
    ).toBe(1);
    expect(
      highestOperationTier([
        { kind: "create-resource", resource: { name: "a", domainId: "1", subdomain: null, mode: "http" } },
        { kind: "update-target", externalTargetId: "1", target: { enabled: false } },
      ]),
    ).toBe(2);
  });
});

/* ------------------------------------------------------- assertWritePolicy --- */

function baseInput(overrides: Partial<AssertWritePolicyInput> = {}): AssertWritePolicyInput {
  return {
    mode: "apply",
    trigger: "manual",
    policyTier: "access_affecting",
    operationTier: 1,
    actorIsAdmin: true,
    unblockHint: "allow writes for this connection to continue",
    ...overrides,
  };
}

function caught(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe("assertWritePolicy", () => {
  it("never throws for mode: 'check', regardless of every other input", () => {
    expect(() =>
      assertWritePolicy(
        baseInput({
          mode: "check",
          trigger: "poll",
          policyTier: "read_only",
          operationTier: 2,
          actorIsAdmin: false,
        }),
      ),
    ).not.toThrow();
  });

  it("permits a tier-1 apply on the default read_only-or-above additive policy", () => {
    expect(() =>
      assertWritePolicy(baseInput({ policyTier: "additive", operationTier: 1 })),
    ).not.toThrow();
  });

  it("refuses a tier-1 apply when the policy is still read_only", () => {
    const error = caught(() =>
      assertWritePolicy(baseInput({ policyTier: "read_only", operationTier: 1 })),
    );
    expect(error).toBeInstanceOf(WritePolicyError);
    expect((error as WritePolicyError).blockedReason).toBe("write_policy");
    expect((error as WritePolicyError).message).toBe(
      "allow writes for this connection to continue",
    );
  });

  it("refuses a tier-2 apply when the policy only permits additive (tier 1)", () => {
    const error = caught(() =>
      assertWritePolicy(baseInput({ policyTier: "additive", operationTier: 2 })),
    );
    expect(error).toBeInstanceOf(WritePolicyError);
  });

  it("permits a tier-2 apply once the policy is access_affecting or lockout_class", () => {
    expect(() =>
      assertWritePolicy(baseInput({ policyTier: "access_affecting", operationTier: 2 })),
    ).not.toThrow();
    expect(() =>
      assertWritePolicy(baseInput({ policyTier: "lockout_class", operationTier: 2 })),
    ).not.toThrow();
  });

  // Rule 3: unconditional, regardless of policy tier.
  it("refuses a tier-2 apply on a 'sweep' or 'poll' trigger EVEN AT the most permissive policy", () => {
    for (const trigger of ["sweep", "poll"] as const) {
      const error = caught(() =>
        assertWritePolicy(
          baseInput({ trigger, policyTier: "lockout_class", operationTier: 2 }),
        ),
      );
      expect(error).toBeInstanceOf(WritePolicyError);
      expect((error as WritePolicyError).message).toContain(trigger);
    }
  });

  it("permits a tier-1 apply on a 'sweep' or 'poll' trigger when policy allows it — the M5 auto-apply seam", () => {
    for (const trigger of ["sweep", "poll"] as const) {
      expect(() =>
        assertWritePolicy(
          baseInput({ trigger, policyTier: "additive", operationTier: 1, actorIsAdmin: undefined }),
        ),
      ).not.toThrow();
    }
  });

  it("'manual' and 'intent_change' triggers may apply a tier-2 write when policy allows", () => {
    for (const trigger of ["manual", "intent_change"] as const) {
      expect(() =>
        assertWritePolicy(
          baseInput({ trigger, policyTier: "access_affecting", operationTier: 2 }),
        ),
      ).not.toThrow();
    }
  });

  it("refuses when a known actor is explicitly not an admin, regardless of policy tier", () => {
    const error = caught(() =>
      assertWritePolicy(
        baseInput({ policyTier: "lockout_class", operationTier: 1, actorIsAdmin: false }),
      ),
    );
    expect(error).toBeInstanceOf(WritePolicyError);
    expect((error as WritePolicyError).message).toContain("admin-only");
  });

  it("does not refuse on actor grounds when no human actor is attached (actorIsAdmin: undefined)", () => {
    expect(() =>
      assertWritePolicy(
        baseInput({ policyTier: "additive", operationTier: 1, actorIsAdmin: undefined }),
      ),
    ).not.toThrow();
  });

  it("defaults the blocked reason to 'write_policy' but honors an explicit 'credential_scope'", () => {
    const defaulted = caught(() =>
      assertWritePolicy(baseInput({ policyTier: "read_only", operationTier: 1 })),
    );
    expect((defaulted as WritePolicyError).blockedReason).toBe("write_policy");

    const scoped = caught(() =>
      assertWritePolicy(
        baseInput({
          policyTier: "read_only",
          operationTier: 1,
          blockedReason: "credential_scope",
        }),
      ),
    );
    expect((scoped as WritePolicyError).blockedReason).toBe("credential_scope");
  });

  it("writePolicyBlockedStep maps a caught error onto the 'blocked' step shape", () => {
    const error = caught(() =>
      assertWritePolicy(baseInput({ policyTier: "read_only", operationTier: 1 })),
    ) as WritePolicyError;
    expect(writePolicyBlockedStep(error)).toEqual({
      status: "blocked",
      errorCode: "write_policy",
      errorDetail: "allow writes for this connection to continue",
    });
  });
});

/* ------------------------------------------------------------ wouldLockOut --- */

function rule(overrides: Partial<LockoutCheckRule> = {}): LockoutCheckRule {
  return {
    action: "ACCEPT",
    match: "CIDR",
    value: "203.0.113.7/32",
    enabled: true,
    aliasName: null,
    ...overrides,
  };
}

function lockoutInput(overrides: Partial<WouldLockOutInput> = {}): WouldLockOutInput {
  return {
    resource: { fullDomain: "app.example.com", isPangolinDashboard: false, isLoxepSelf: false },
    resultingRules: [rule()],
    operatorContext: { currentAddresses: ["203.0.113.7"], heldAuthMethods: [] },
    ...overrides,
  };
}

describe("wouldLockOut", () => {
  it("refuses when the resource fronts Loxep itself, before any other check", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resource: { fullDomain: "loxep.example.com", isPangolinDashboard: false, isLoxepSelf: true },
          resultingRules: [],
          operatorContext: { currentAddresses: [], heldAuthMethods: [] },
        }),
      ),
    ).toBe("loxep_self");
  });

  it("refuses when the resource is the Pangolin dashboard's own resource", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resource: { fullDomain: "pangolin.example.com", isPangolinDashboard: true, isLoxepSelf: false },
        }),
      ),
    ).toBe("pangolin_dashboard_self");
  });

  it("isLoxepSelf takes priority over isPangolinDashboard when (hypothetically) both are true", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resource: { fullDomain: "x", isPangolinDashboard: true, isLoxepSelf: true },
        }),
      ),
    ).toBe("loxep_self");
  });

  it("refuses when the resulting rules grant the operator no address and no auth method", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resultingRules: [rule({ value: "198.51.100.9/32" })],
          operatorContext: { currentAddresses: ["203.0.113.7"], heldAuthMethods: [] },
        }),
      ),
    ).toBe("no_operator_access");
  });

  it("permits when the resulting rules grant a matching address rule", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resultingRules: [rule({ value: "203.0.113.7/32" })],
          operatorContext: { currentAddresses: ["203.0.113.7"], heldAuthMethods: [] },
        }),
      ),
    ).toBeNull();
  });

  it("matches a bare (non-/32) literal value the same as its /32 form", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resultingRules: [rule({ value: "203.0.113.7" })],
          operatorContext: { currentAddresses: ["203.0.113.7"], heldAuthMethods: [] },
        }),
      ),
    ).toBeNull();
  });

  it("a DISABLED matching rule does not count as granting access", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resultingRules: [rule({ value: "203.0.113.7/32", enabled: false })],
          operatorContext: { currentAddresses: ["203.0.113.7"], heldAuthMethods: [] },
        }),
      ),
    ).toBe("no_operator_access");
  });

  it("a DROP or PASS rule matching the operator's address does not count as granting access", () => {
    for (const action of ["DROP", "PASS"] as const) {
      expect(
        wouldLockOut(
          lockoutInput({
            resultingRules: [rule({ value: "203.0.113.7/32", action })],
            operatorContext: { currentAddresses: ["203.0.113.7"], heldAuthMethods: [] },
          }),
        ),
      ).toBe("no_operator_access");
    }
  });

  it("a PATH/COUNTRY/ASN match does not count as an address grant even with the right value", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resultingRules: [rule({ match: "PATH", value: "203.0.113.7" })],
          operatorContext: { currentAddresses: ["203.0.113.7"], heldAuthMethods: [] },
        }),
      ),
    ).toBe("no_operator_access");
  });

  it("permits when the operator holds an auth method even with no matching address rule", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resultingRules: [rule({ value: "198.51.100.9/32" })],
          operatorContext: { currentAddresses: ["203.0.113.7"], heldAuthMethods: ["sso"] },
        }),
      ),
    ).toBeNull();
  });

  it("refuses when the operation retires the only live rule referencing an alias", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resultingRules: [
            rule({ value: "203.0.113.7/32" }), // keeps operator access, unrelated to the alias
            rule({ value: "203.0.113.8/32", enabled: false, aliasName: "home" }),
          ],
          retiresAliasRuleNamed: "home",
        }),
      ),
    ).toBe("retires_only_live_alias_rule");
  });

  it("permits retiring an alias rule when another enabled rule still references the same alias", () => {
    expect(
      wouldLockOut(
        lockoutInput({
          resultingRules: [
            rule({ value: "203.0.113.7/32" }),
            rule({ value: "203.0.113.9/32", enabled: true, aliasName: "home" }),
            rule({ value: "203.0.113.8/32", enabled: false, aliasName: "home" }),
          ],
          retiresAliasRuleNamed: "home",
        }),
      ),
    ).toBeNull();
  });

  it("has no policy parameter at all — cannot be satisfied by a permissive write policy", () => {
    // Type-level proof: WouldLockOutInput carries no `policyTier` field, so
    // there is nothing for a caller to raise. Runtime proof: the loxep_self
    // refusal above is unconditional regardless of any other input.
    const reason = wouldLockOut(
      lockoutInput({
        resource: { fullDomain: "loxep.example.com", isPangolinDashboard: false, isLoxepSelf: true },
        resultingRules: [rule({ value: "203.0.113.7/32" })],
        operatorContext: { currentAddresses: ["203.0.113.7"], heldAuthMethods: ["sso"] },
      }),
    );
    expect(reason).toBe("loxep_self");
  });
});

describe("assertWouldNotLockOut", () => {
  it("throws SelfLockoutError with the matching reason when wouldLockOut refuses", () => {
    const error = caught(() =>
      assertWouldNotLockOut(
        lockoutInput({
          resultingRules: [],
          operatorContext: { currentAddresses: [], heldAuthMethods: [] },
        }),
      ),
    );
    expect(error).toBeInstanceOf(SelfLockoutError);
    expect((error as SelfLockoutError).reason).toBe("no_operator_access");
  });

  it("does not throw when wouldLockOut permits", () => {
    expect(() => assertWouldNotLockOut(lockoutInput())).not.toThrow();
  });
});
