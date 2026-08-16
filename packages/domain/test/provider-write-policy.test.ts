/**
 * The write-authorization tier vocabulary — pure, no database (Pangolin
 * chain design M3, `loxep-acj.3`).
 */
import { describe, expect, it } from "vitest";
import {
  PROVIDER_WRITE_POLICY_TIERS,
  PROVIDER_WRITE_POLICY_TIER_DESCRIPTIONS,
  PROVIDER_WRITE_POLICY_TIER_LABELS,
  providerWritePolicyTierRank,
  providerWritePolicyTierSchema,
  resolveProviderWritePolicy,
} from "../src/index.ts";

describe("PROVIDER_WRITE_POLICY_TIERS", () => {
  it("is ordered least to most permissive, and read_only is first", () => {
    expect(PROVIDER_WRITE_POLICY_TIERS).toEqual([
      "read_only",
      "additive",
      "access_affecting",
      "lockout_class",
    ]);
  });

  it("has a label and a description for every tier, with no extras", () => {
    for (const tier of PROVIDER_WRITE_POLICY_TIERS) {
      expect(PROVIDER_WRITE_POLICY_TIER_LABELS[tier]).toBeTruthy();
      expect(PROVIDER_WRITE_POLICY_TIER_DESCRIPTIONS[tier]).toBeTruthy();
    }
    expect(Object.keys(PROVIDER_WRITE_POLICY_TIER_LABELS)).toHaveLength(
      PROVIDER_WRITE_POLICY_TIERS.length,
    );
    expect(Object.keys(PROVIDER_WRITE_POLICY_TIER_DESCRIPTIONS)).toHaveLength(
      PROVIDER_WRITE_POLICY_TIERS.length,
    );
  });
});

describe("providerWritePolicyTierRank", () => {
  it("ranks strictly ascending with the array's own order", () => {
    const ranks = PROVIDER_WRITE_POLICY_TIERS.map(providerWritePolicyTierRank);
    expect(ranks).toEqual([0, 1, 2, 3]);
  });
});

describe("providerWritePolicyTierSchema", () => {
  it("accepts every registered tier", () => {
    for (const tier of PROVIDER_WRITE_POLICY_TIERS) {
      expect(providerWritePolicyTierSchema.safeParse(tier).success).toBe(true);
    }
  });

  it("rejects an unregistered value", () => {
    expect(providerWritePolicyTierSchema.safeParse("allow").success).toBe(false);
    expect(providerWritePolicyTierSchema.safeParse("").success).toBe(false);
    expect(providerWritePolicyTierSchema.safeParse(null).success).toBe(false);
  });
});

describe("resolveProviderWritePolicy", () => {
  it("defaults an absent connection id to read_only", () => {
    expect(resolveProviderWritePolicy({}, "conn-1")).toBe("read_only");
    expect(
      resolveProviderWritePolicy({ "conn-2": "additive" }, "conn-1"),
    ).toBe("read_only");
  });

  it("returns the stored tier for a present connection id", () => {
    expect(
      resolveProviderWritePolicy({ "conn-1": "lockout_class" }, "conn-1"),
    ).toBe("lockout_class");
  });
});
