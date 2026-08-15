/**
 * The proxy resource planner: desired state plus an observed inventory in,
 * provider operations out. Pure — no database, no provider, no clock.
 *
 * The property that matters most, mirroring `container-host-intent.test.ts`:
 * the operation union has NO `delete` member, and this suite never produces
 * one because the type cannot express it. A second property specific to this
 * planner: an `owner: 'manual'` rule that differs from the provider produces
 * NO operation, in either direction (create or update) — the
 * `dns_records.owner` precedent applied per-rule.
 */
import { describe, expect, it } from "vitest";
import { planProxyResourceOperations } from "../src/index.ts";
import type {
  DesiredProxyResource,
  DesiredProxyRule,
  DesiredProxyTarget,
  ObservedProxyResource,
  ObservedProxyRule,
  ObservedProxyTarget,
} from "../src/index.ts";

function observedResource(
  overrides: Partial<ObservedProxyResource> = {},
): ObservedProxyResource {
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
    rules: [],
    ...overrides,
  };
}

function observedTarget(
  overrides: Partial<ObservedProxyTarget> = {},
): ObservedProxyTarget {
  return {
    externalTargetId: "500",
    siteId: "3",
    ip: "10.0.0.5",
    port: 8080,
    method: "http",
    enabled: true,
    path: null,
    pathMatchType: null,
    priority: 100,
    ...overrides,
  };
}

function observedRule(
  overrides: Partial<ObservedProxyRule> = {},
): ObservedProxyRule {
  return {
    externalRuleId: "900",
    action: "ACCEPT",
    match: "CIDR",
    value: "203.0.113.7/32",
    priority: 100,
    enabled: true,
    ...overrides,
  };
}

function desiredResource(
  overrides: Partial<DesiredProxyResource> = {},
): DesiredProxyResource {
  return {
    proxyResourceId: "11111111-1111-4111-8111-111111111111",
    hostingTargetId: "22222222-2222-4222-8222-222222222222",
    domainId: "33333333-3333-4333-8333-333333333333",
    externalDomainId: "7",
    fullDomain: "api.example.com",
    subdomain: "api",
    mode: "http",
    proxyPort: null,
    ssl: true,
    enabled: true,
    externalResourceId: null,
    targets: [],
    rules: [],
    ...overrides,
  };
}

function desiredTarget(
  overrides: Partial<DesiredProxyTarget> = {},
): DesiredProxyTarget {
  return {
    externalTargetId: null,
    siteId: "3",
    ip: "10.0.0.5",
    port: 8080,
    method: "http",
    enabled: true,
    path: null,
    pathMatchType: null,
    priority: 100,
    ...overrides,
  };
}

function desiredRule(overrides: Partial<DesiredProxyRule> = {}): DesiredProxyRule {
  return {
    externalRuleId: null,
    action: "ACCEPT",
    match: "CIDR",
    value: "203.0.113.7/32",
    priority: 100,
    enabled: true,
    owner: "manual",
    ...overrides,
  };
}

describe("resource matching", () => {
  it("emits nothing when a resource is fully converged", () => {
    const plan = planProxyResourceOperations({
      desired: [desiredResource({ externalResourceId: "42" })],
      observed: [observedResource()],
    });
    expect(plan.operations).toEqual([]);
    expect(plan.unmatchedObserved).toEqual([]);
  });

  it("creates a resource that has no observed match, and defers targets/rules", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({
          externalResourceId: null,
          targets: [desiredTarget()],
          rules: [desiredRule({ owner: "template" })],
        }),
      ],
      observed: [],
    });
    expect(plan.operations).toEqual([
      {
        kind: "create-resource",
        resource: {
          name: "api.example.com",
          domainId: "7",
          subdomain: "api",
          mode: "http",
          proxyPort: null,
          ssl: true,
          enabled: true,
        },
      },
    ]);
  });

  it("matches an unbootstrapped desired resource by fullDomain", () => {
    const plan = planProxyResourceOperations({
      desired: [desiredResource({ externalResourceId: null })],
      observed: [observedResource({ fullDomain: "api.example.com" })],
    });
    expect(plan.operations).toEqual([]);
    expect(plan.unmatchedObserved).toEqual([]);
  });

  it("prefers externalResourceId over fullDomain once bootstrapped", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({
          externalResourceId: "42",
          fullDomain: "renamed.example.com",
        }),
      ],
      observed: [observedResource({ externalResourceId: "42", fullDomain: "api.example.com" })],
    });
    expect(plan.operations).toEqual([]);
  });

  it("updates resource-level fields that differ", () => {
    const plan = planProxyResourceOperations({
      desired: [desiredResource({ externalResourceId: "42", ssl: false, enabled: false })],
      observed: [observedResource()],
    });
    expect(plan.operations).toEqual([
      {
        kind: "update-resource",
        externalResourceId: "42",
        resource: { ssl: false, enabled: false },
      },
    ]);
  });

  it("surfaces an observed resource no desired record matched as unmatchedObserved, never a delete", () => {
    const plan = planProxyResourceOperations({
      desired: [],
      observed: [observedResource({ externalResourceId: "99", fullDomain: "extra.example.com" })],
    });
    expect(plan.operations).toEqual([]);
    expect(plan.unmatchedObserved).toEqual([
      observedResource({ externalResourceId: "99", fullDomain: "extra.example.com" }),
    ]);
  });
});

describe("target diff", () => {
  it("creates a target with no observed match on an already-matched resource", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({
          externalResourceId: "42",
          targets: [desiredTarget()],
        }),
      ],
      observed: [observedResource()],
    });
    expect(plan.operations).toEqual([
      {
        kind: "create-target",
        externalResourceId: "42",
        target: {
          siteId: "3",
          ip: "10.0.0.5",
          port: 8080,
          method: "http",
          enabled: true,
          path: null,
          pathMatchType: null,
          priority: 100,
        },
      },
    ]);
  });

  it("matches a target by (siteId, ip, port) and emits nothing when converged", () => {
    const plan = planProxyResourceOperations({
      desired: [desiredResource({ externalResourceId: "42", targets: [desiredTarget()] })],
      observed: [observedResource({ targets: [observedTarget()] })],
    });
    expect(plan.operations).toEqual([]);
  });

  it("updates only the fields that differ on a matched target", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({
          externalResourceId: "42",
          targets: [desiredTarget({ enabled: false })],
        }),
      ],
      observed: [observedResource({ targets: [observedTarget()] })],
    });
    expect(plan.operations).toEqual([
      {
        kind: "update-target",
        externalTargetId: "500",
        target: { enabled: false },
      },
    ]);
  });
});

describe("rule diff", () => {
  it("creates a template-owned rule with no observed match", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({
          externalResourceId: "42",
          rules: [desiredRule({ owner: "template" })],
        }),
      ],
      observed: [observedResource()],
    });
    expect(plan.operations).toEqual([
      {
        kind: "create-rule",
        externalResourceId: "42",
        rule: {
          action: "ACCEPT",
          match: "CIDR",
          value: "203.0.113.7/32",
          priority: 100,
          enabled: true,
        },
      },
    ]);
  });

  it("never creates a manual-owned rule that is missing at the provider", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({
          externalResourceId: "42",
          rules: [desiredRule({ owner: "manual" })],
        }),
      ],
      observed: [observedResource()],
    });
    expect(plan.operations).toEqual([]);
  });

  it("never rewrites a manual-owned rule that differs from the provider", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({
          externalResourceId: "42",
          rules: [desiredRule({ owner: "manual", priority: 500 })],
        }),
      ],
      observed: [observedResource({ rules: [observedRule({ priority: 100 })] })],
    });
    expect(plan.operations).toEqual([]);
  });

  it("updates a dynamic_ip-owned rule whose priority changed, carrying the full comparable set", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({
          externalResourceId: "42",
          rules: [desiredRule({ owner: "dynamic_ip", priority: 500 })],
        }),
      ],
      observed: [observedResource({ rules: [observedRule({ priority: 100 })] })],
    });
    expect(plan.operations).toEqual([
      {
        kind: "update-rule",
        externalResourceId: "42",
        externalRuleId: "900",
        rule: {
          action: "ACCEPT",
          match: "CIDR",
          value: "203.0.113.7/32",
          priority: 500,
          enabled: true,
        },
      },
    ]);
  });

  it("emits nothing when a rule is fully converged", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({ externalResourceId: "42", rules: [desiredRule({ owner: "template" })] }),
      ],
      observed: [observedResource({ rules: [observedRule()] })],
    });
    expect(plan.operations).toEqual([]);
  });
});

describe("the operation union has no delete member", () => {
  it("every emitted operation kind is one of the six create/update kinds", () => {
    const plan = planProxyResourceOperations({
      desired: [
        desiredResource({ externalResourceId: null }),
        desiredResource({
          proxyResourceId: "44444444-4444-4444-8444-444444444444",
          fullDomain: "other.example.com",
          externalResourceId: "42",
          ssl: false,
          targets: [desiredTarget({ port: 9090 })],
          rules: [desiredRule({ owner: "template", value: "different" })],
        }),
      ],
      observed: [observedResource({ fullDomain: "other.example.com" })],
    });
    const allowed = new Set([
      "create-resource",
      "update-resource",
      "create-target",
      "update-target",
      "create-rule",
      "update-rule",
    ]);
    expect(plan.operations.length).toBeGreaterThan(0);
    for (const op of plan.operations) {
      expect(allowed.has(op.kind)).toBe(true);
    }
  });
});
