/**
 * Dynamic-IP named aliases: schema and reference syntax — pure, no database
 * (Pangolin chain design M5, `loxep-acj.5`).
 */
import { describe, expect, it } from "vitest";
import {
  IP_ALIAS_SOURCES,
  formatIpAliasReference,
  ipAliasCidrValue,
  ipAliasEntrySchema,
  ipAliasNameSchema,
  ipAliasesSchema,
  parseIpAliasReference,
} from "../src/index.ts";

function entry(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    address: "203.0.113.7",
    source: "manual",
    hostname: null,
    connectionId: null,
    siteId: null,
    previousAddress: null,
    observedAt: null,
    confirmedAt: null,
    autoApply: false,
    ...overrides,
  };
}

describe("ipAliasNameSchema", () => {
  it("accepts lowercase names starting with a letter", () => {
    for (const name of ["home", "office2", "vpn-eu", "site_a"]) {
      expect(ipAliasNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("rejects a name starting with a digit, uppercase letters, or empty", () => {
    for (const name of ["2home", "Home", "", "home!", " home"]) {
      expect(ipAliasNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe("ipAliasEntrySchema", () => {
  it("accepts one entry per registered source", () => {
    for (const source of IP_ALIAS_SOURCES) {
      expect(ipAliasEntrySchema.safeParse(entry({ source })).success).toBe(true);
    }
  });

  it("rejects an unregistered source", () => {
    expect(ipAliasEntrySchema.safeParse(entry({ source: "http_probe" })).success).toBe(
      false,
    );
  });

  it("rejects an unknown extra field — strict, matching the settings-defaults precedent", () => {
    expect(
      ipAliasEntrySchema.safeParse(entry({ extraField: "nope" })).success,
    ).toBe(false);
  });

  it("requires autoApply to be a boolean, defaulting to nothing (explicit is mandatory)", () => {
    const { autoApply: _drop, ...withoutAutoApply } = entry() as Record<string, unknown>;
    expect(ipAliasEntrySchema.safeParse(withoutAutoApply).success).toBe(false);
  });
});

describe("ipAliasesSchema", () => {
  it("accepts an empty map — the setting's own default", () => {
    expect(ipAliasesSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a map keyed by valid alias names", () => {
    const result = ipAliasesSchema.safeParse({ home: entry(), office: entry({ source: "dns" }) });
    expect(result.success).toBe(true);
  });

  it("rejects a map with an invalid key", () => {
    const result = ipAliasesSchema.safeParse({ "Not Valid": entry() });
    expect(result.success).toBe(false);
  });
});

describe("parseIpAliasReference / formatIpAliasReference", () => {
  it("round-trips a name through format then parse", () => {
    expect(parseIpAliasReference(formatIpAliasReference("home"))).toBe("home");
  });

  it("returns null for a literal value (no 'alias:' prefix)", () => {
    expect(parseIpAliasReference("203.0.113.7/32")).toBeNull();
  });

  it("returns null for a reference whose name portion is not a valid alias name", () => {
    expect(parseIpAliasReference("alias:Not Valid")).toBeNull();
    expect(parseIpAliasReference("alias:")).toBeNull();
  });

  it("never throws — every input is parsed or rejected, never an exception", () => {
    for (const value of ["", "alias", "alias:", "alias:home", "literal", "alias:a".repeat(50)]) {
      expect(() => parseIpAliasReference(value)).not.toThrow();
    }
  });
});

describe("ipAliasCidrValue", () => {
  it("appends /32 to a bare address", () => {
    expect(ipAliasCidrValue("203.0.113.7")).toBe("203.0.113.7/32");
  });
});
