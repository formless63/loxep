/**
 * The materializer, exhaustively — the design's pre-implementation checklist
 * item 5: *"write the materializer's tests before the materializer — the
 * fronting-node hop, mail records never proxied, manual records passed through
 * untouched, and the mail-only domain shape are the four cases that must be
 * covered before a line of provider code exists."*
 *
 * All four are here, plus the two failure modes that must be errors rather
 * than fallbacks and the CAA gate that open question 2 resolved to "empty until
 * reviewed".
 *
 * Pure: no database, no network, no clock.
 */
import { describe, expect, it } from "vitest";
import {
  MaterializationError,
  caaContent,
  materializeCaaRecords,
  materializeDesiredRecords,
  resolveHostingAddress,
} from "../src/index.ts";
import type {
  CaaPolicy,
  HostingTargetNode,
  MaterializeInput,
} from "../src/index.ts";

const UNREVIEWED_CAA: CaaPolicy = {
  reviewed: false,
  issuers: [],
  wildcardIssuers: [],
  iodef: null,
};

const FULL_CAPABILITIES = {
  proxying: true,
  proxiedWildcards: true,
  proxiableTypes: ["A", "AAAA", "CNAME"] as const,
};

function target(overrides: Partial<HostingTargetNode> & { id: string }): HostingTargetNode {
  return {
    name: overrides.id,
    controlSurface: "direct_reverse_proxy",
    addressV4: "203.0.113.10",
    addressV6: null,
    frontedByTargetId: null,
    ...overrides,
  };
}

function input(overrides: Partial<MaterializeInput> = {}): MaterializeInput {
  return {
    domain: {
      name: "example.test",
      apexTargetId: null,
      apexProxied: true,
      wildcardProxied: true,
      mailEnabled: false,
    },
    targets: new Map(),
    caaPolicy: UNREVIEWED_CAA,
    mailRecords: null,
    capabilities: { ...FULL_CAPABILITIES },
    ...overrides,
  };
}

describe("resolveHostingAddress — the fronting-node hop", () => {
  it("returns a directly-addressed target's own address with zero hops", () => {
    const node = target({ id: "t1", addressV4: "203.0.113.10" });
    expect(resolveHostingAddress(node, new Map([["t1", node]]))).toEqual({
      addressV4: "203.0.113.10",
      addressV6: null,
      sourceTargetId: "t1",
      hops: 0,
    });
  });

  it("resolves a TUNNEL CLIENT to its fronting node, not to its own address", () => {
    // The subtle bug the design names: publishing the origin's address for a
    // host reachable only through a tunnel looks like a propagation problem
    // for as long as it takes somebody to check.
    const node = target({
      id: "node",
      controlSurface: "proxy_node",
      addressV4: "198.51.100.5",
    });
    const origin = target({
      id: "origin",
      controlSurface: "tunnel_client",
      // The origin HAS an address, and it must not be the one published.
      addressV4: "10.0.0.4",
      frontedByTargetId: "node",
    });
    const resolved = resolveHostingAddress(
      origin,
      new Map([
        ["node", node],
        ["origin", origin],
      ]),
    );
    expect(resolved.addressV4).toBe("198.51.100.5");
    expect(resolved.sourceTargetId).toBe("node");
    expect(resolved.hops).toBe(1);
  });

  it("carries the fronting node's IPv6 address too", () => {
    const node = target({
      id: "node",
      controlSurface: "proxy_node",
      addressV4: "198.51.100.5",
      addressV6: "2001:db8::5",
    });
    const origin = target({
      id: "origin",
      controlSurface: "tunnel_client",
      addressV4: null,
      frontedByTargetId: "node",
    });
    const resolved = resolveHostingAddress(
      origin,
      new Map([
        ["node", node],
        ["origin", origin],
      ]),
    );
    expect(resolved.addressV6).toBe("2001:db8::5");
  });

  it("FAILS rather than falling back when the fronting node has no address", () => {
    const node = target({
      id: "node",
      controlSurface: "proxy_node",
      addressV4: null,
      addressV6: null,
    });
    const origin = target({
      id: "origin",
      controlSurface: "tunnel_client",
      addressV4: "10.0.0.4",
      frontedByTargetId: "node",
    });
    expect(() =>
      resolveHostingAddress(
        origin,
        new Map([
          ["node", node],
          ["origin", origin],
        ]),
      ),
    ).toThrow(MaterializationError);
  });

  it("fails on a fronting cycle rather than looping", () => {
    const a = target({
      id: "a",
      controlSurface: "tunnel_client",
      frontedByTargetId: "b",
      addressV4: null,
    });
    const b = target({
      id: "b",
      controlSurface: "tunnel_client",
      frontedByTargetId: "a",
      addressV4: null,
    });
    expect(() =>
      resolveHostingAddress(
        a,
        new Map([
          ["a", a],
          ["b", b],
        ]),
      ),
    ).toThrow(/fronting cycle/);
  });

  it("fails when a tunnel client's fronting node was not supplied", () => {
    const origin = target({
      id: "origin",
      controlSurface: "tunnel_client",
      frontedByTargetId: "missing",
      addressV4: null,
    });
    expect(() =>
      resolveHostingAddress(origin, new Map([["origin", origin]])),
    ).toThrow(/not supplied/);
  });
});

describe("materializeDesiredRecords — the apex and wildcard", () => {
  it("emits A records for @ and * with the domain's own proxy intent", () => {
    const node = target({ id: "t1", addressV4: "203.0.113.10" });
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: "t1",
          apexProxied: true,
          wildcardProxied: false,
          mailEnabled: false,
        },
        targets: new Map([["t1", node]]),
      }),
    );
    expect(records).toEqual([
      {
        type: "A",
        name: "@",
        content: "203.0.113.10",
        ttlSeconds: null,
        priority: null,
        proxied: true,
        owner: "apex",
      },
      {
        type: "A",
        name: "*",
        content: "203.0.113.10",
        ttlSeconds: null,
        priority: null,
        proxied: false,
        owner: "wildcard",
      },
    ]);
  });

  it("emits both A and AAAA when the target has both addresses", () => {
    const node = target({
      id: "t1",
      addressV4: "203.0.113.10",
      addressV6: "2001:db8::10",
    });
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: "t1",
          apexProxied: false,
          wildcardProxied: false,
          mailEnabled: false,
        },
        targets: new Map([["t1", node]]),
      }),
    );
    expect(records.map((record) => `${record.type} ${record.name}`)).toEqual([
      "A @",
      "A *",
      "AAAA @",
      "AAAA *",
    ]);
  });

  it("publishes the FRONTING node's address for a tunnel-client apex", () => {
    const node = target({
      id: "node",
      controlSurface: "proxy_node",
      addressV4: "198.51.100.5",
    });
    const origin = target({
      id: "origin",
      controlSurface: "tunnel_client",
      addressV4: "10.0.0.4",
      frontedByTargetId: "node",
    });
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: "origin",
          apexProxied: true,
          wildcardProxied: true,
          mailEnabled: false,
        },
        targets: new Map([
          ["node", node],
          ["origin", origin],
        ]),
      }),
    );
    for (const record of records) {
      expect(record.content).toBe("198.51.100.5");
      expect(record.content).not.toBe("10.0.0.4");
    }
  });

  it("refuses a control surface of 'none' as an apex target", () => {
    const node = target({
      id: "t1",
      controlSurface: "none",
      addressV4: null,
    });
    expect(() =>
      materializeDesiredRecords(
        input({
          domain: {
            name: "example.test",
            apexTargetId: "t1",
            apexProxied: false,
            wildcardProxied: false,
            mailEnabled: false,
          },
          targets: new Map([["t1", node]]),
        }),
      ),
    ).toThrow(/control surface is 'none'/);
  });

  it("REFUSES to degrade silently when the provider cannot proxy", () => {
    // "Silent degradation here means an origin address is published that the
    // operator believes is hidden."
    const node = target({ id: "t1" });
    expect(() =>
      materializeDesiredRecords(
        input({
          domain: {
            name: "example.test",
            apexTargetId: "t1",
            apexProxied: true,
            wildcardProxied: false,
            mailEnabled: false,
          },
          targets: new Map([["t1", node]]),
          capabilities: {
            proxying: false,
            proxiedWildcards: false,
            proxiableTypes: [],
          },
        }),
      ),
    ).toThrow(/cannot proxy records/);
  });

  it("refuses a proxied WILDCARD when only wildcard proxying is unavailable", () => {
    const node = target({ id: "t1" });
    expect(() =>
      materializeDesiredRecords(
        input({
          domain: {
            name: "example.test",
            apexTargetId: "t1",
            apexProxied: true,
            wildcardProxied: true,
            mailEnabled: false,
          },
          targets: new Map([["t1", node]]),
          capabilities: {
            proxying: true,
            proxiedWildcards: false,
            proxiableTypes: ["A", "AAAA", "CNAME"],
          },
        }),
      ),
    ).toThrow(/cannot proxy WILDCARD/);
  });
});

describe("materializeDesiredRecords — the mail-only domain shape", () => {
  it("is a first-class shape: no apex target, mail enabled, records emitted", () => {
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: null,
          apexProxied: true,
          wildcardProxied: true,
          mailEnabled: true,
        },
        mailRecords: [
          { type: "MX", name: "@", content: "mx.provider.test", priority: 10 },
          { type: "TXT", name: "@", content: "v=spf1 include:provider.test -all" },
          {
            type: "CNAME",
            name: "key1._domainkey",
            content: "key1.provider.test",
          },
        ],
      }),
    );
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.owner === "mail")).toBe(true);
    // No address records at all — and that is correct, not a gap.
    expect(records.some((record) => record.type === "A")).toBe(false);
  });

  it("emits mail records UNPROXIED unconditionally", () => {
    // The invariant whose violation is invisible for weeks: proxying a mail
    // provider's key-publication CNAME breaks signature alignment while mail
    // keeps flowing.
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: null,
          apexProxied: true,
          wildcardProxied: true,
          mailEnabled: true,
        },
        mailRecords: [
          { type: "CNAME", name: "key1._domainkey", content: "key1.provider.test" },
          { type: "CNAME", name: "key2._domainkey", content: "key2.provider.test" },
        ],
      }),
    );
    expect(records.every((record) => record.proxied === false)).toBe(true);
  });

  it("emits nothing for mail when mail is disabled, even with a record set", () => {
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: null,
          apexProxied: true,
          wildcardProxied: true,
          mailEnabled: false,
        },
        mailRecords: [
          { type: "MX", name: "@", content: "mx.provider.test", priority: 10 },
        ],
      }),
    );
    expect(records).toHaveLength(0);
  });

  it("emits nothing for mail when the provider registration has not happened", () => {
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: null,
          apexProxied: true,
          wildcardProxied: true,
          mailEnabled: true,
        },
        mailRecords: null,
      }),
    );
    expect(records).toHaveLength(0);
  });

  it("lets explicit mail records coexist with a wildcard — they do NOT conflict", () => {
    // Looks like a conflict and is not: DNS resolution already prefers the
    // explicit name over the wildcard. Worth a test precisely because a reader
    // will expect special handling that is not there.
    const node = target({ id: "t1" });
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: "t1",
          apexProxied: false,
          wildcardProxied: false,
          mailEnabled: true,
        },
        targets: new Map([["t1", node]]),
        mailRecords: [
          { type: "CNAME", name: "key1._domainkey", content: "key1.provider.test" },
        ],
      }),
    );
    const names = records.map((record) => `${record.type} ${record.name}`);
    expect(names).toContain("A *");
    expect(names).toContain("CNAME key1._domainkey");
  });
});

describe("materializeDesiredRecords — manual records", () => {
  it("has no way to emit or touch one: they are not in the signature", () => {
    // The structural version of "the reconciler never rewrites a manual
    // record". There is no input for them and no output that could carry one,
    // so no code path here can produce one.
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: null,
          apexProxied: true,
          wildcardProxied: true,
          mailEnabled: true,
        },
        mailRecords: [
          { type: "MX", name: "@", content: "mx.provider.test", priority: 10 },
        ],
      }),
    );
    expect(
      records.some((record) => (record.owner as string) === "manual"),
    ).toBe(false);
  });
});

describe("the CAA gate (open question 2, PROVISIONAL)", () => {
  it("emits NOTHING while the policy is unreviewed, even with issuers set", () => {
    // "Never ship a guessed issuer list as a working default." A wrong CAA
    // record breaks certificate renewal silently, at expiry.
    expect(
      materializeCaaRecords({
        reviewed: false,
        issuers: ["letsencrypt.org"],
        wildcardIssuers: [],
        iodef: null,
      }),
    ).toEqual([]);
  });

  it("emits nothing for a REVIEWED but empty policy", () => {
    expect(
      materializeCaaRecords({
        reviewed: true,
        issuers: [],
        wildcardIssuers: [],
        iodef: null,
      }),
    ).toEqual([]);
  });

  it("renders issue, issuewild, and iodef in RFC 8659 presentation format", () => {
    const records = materializeCaaRecords({
      reviewed: true,
      issuers: ["letsencrypt.org", "pki.goog"],
      wildcardIssuers: ["letsencrypt.org"],
      iodef: "mailto:security@example.test",
    });
    expect(records.map((record) => record.content)).toEqual([
      '0 issue "letsencrypt.org"',
      '0 issue "pki.goog"',
      '0 issuewild "letsencrypt.org"',
      '0 iodef "mailto:security@example.test"',
    ]);
    expect(records.every((record) => record.owner === "caa")).toBe(true);
    expect(records.every((record) => record.name === "@")).toBe(true);
    expect(records.every((record) => record.proxied === false)).toBe(true);
  });

  it("formats one record's content", () => {
    expect(caaContent("issue", "letsencrypt.org")).toBe(
      '0 issue "letsencrypt.org"',
    );
  });

  it("appends the CAA set after the address and mail sets", () => {
    const node = target({ id: "t1" });
    const records = materializeDesiredRecords(
      input({
        domain: {
          name: "example.test",
          apexTargetId: "t1",
          apexProxied: false,
          wildcardProxied: false,
          mailEnabled: false,
        },
        targets: new Map([["t1", node]]),
        caaPolicy: {
          reviewed: true,
          issuers: ["letsencrypt.org"],
          wildcardIssuers: [],
          iodef: null,
        },
      }),
    );
    expect(records.map((record) => record.owner)).toEqual([
      "apex",
      "wildcard",
      "caa",
    ]);
  });
});
