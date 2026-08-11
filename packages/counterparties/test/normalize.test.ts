/**
 * Normalization. Unit-only: no database.
 *
 * These tests double as the specification of what exact-normalized matching
 * catches and, just as importantly, what it deliberately does not — because
 * the gaps are the argument for shipping no fuzzy matcher, and a gap nobody
 * wrote down is indistinguishable from a bug.
 */
import { describe, expect, it } from "vitest";
import { normalizeChannelValue, normalizeName } from "../src/normalize.ts";

describe("normalizeName", () => {
  it("folds case, punctuation, whitespace, and a leading `the`", () => {
    expect(normalizeName("The Acme Roofing Co., Inc.")).toBe(
      "acme roofing co inc",
    );
    expect(normalizeName("  ACME   ROOFING  ")).toBe("acme roofing");
  });

  it("collapses the legal-form variants that are the same business", () => {
    expect(normalizeName("Acme Limited")).toBe(normalizeName("Acme Ltd"));
    expect(normalizeName("Acme Incorporated")).toBe(normalizeName("Acme Inc."));
    expect(normalizeName("Acme Company")).toBe(normalizeName("Acme Co"));
    expect(normalizeName("Acme Corporation")).toBe(normalizeName("Acme Corp."));
    expect(normalizeName("Smith and Sons")).toBe(normalizeName("Smith & Sons"));
  });

  it("folds diacritics — a transcription variant is the same business", () => {
    expect(normalizeName("Åkerman & Sons")).toBe(normalizeName("Akerman & Sons"));
  });

  it("turns punctuation into a space rather than deleting it", () => {
    // "acme,inc" must not become "acmeinc", which would group with a
    // different string than "acme inc" does.
    expect(normalizeName("Acme,Inc")).toBe("acme inc");
  });

  it("does NOT collapse a suffix with its absence — a documented gap", () => {
    expect(normalizeName("Acme Roofing")).not.toBe(
      normalizeName("Acme Roofing LLC"),
    );
  });

  it("does NOT correct a misspelling — the other documented gap", () => {
    expect(normalizeName("Acme Roofing")).not.toBe(
      normalizeName("Acme Rooofing"),
    );
  });
});

describe("normalizeChannelValue", () => {
  it("lowercases and trims an email", () => {
    expect(normalizeChannelValue("email", "  Jane.Doe@Example.COM ")).toBe(
      "jane.doe@example.com",
    );
  });

  it("does NOT strip plus-addressing or dots — those are provider rules", () => {
    expect(normalizeChannelValue("email", "jane+invoices@example.com")).toBe(
      "jane+invoices@example.com",
    );
    expect(
      normalizeChannelValue("email", "jane.doe@example.com"),
    ).not.toBe(normalizeChannelValue("email", "janedoe@example.com"));
  });

  it("reduces a phone number to digits, keeping a leading plus", () => {
    expect(normalizeChannelValue("phone", "+1 (555) 010-9999")).toBe(
      "+15550109999",
    );
    expect(normalizeChannelValue("mobile", "555.010.9999")).toBe("5550109999");
    expect(normalizeChannelValue("fax", "555 010 9999")).toBe("5550109999");
  });

  it("does NOT infer a region — a local number never matches its E.164 form", () => {
    expect(normalizeChannelValue("phone", "020 7946 0018")).not.toBe(
      normalizeChannelValue("phone", "+44 20 7946 0018"),
    );
  });

  it("strips scheme, www, and a trailing slash from a website", () => {
    expect(normalizeChannelValue("website", "HTTPS://WWW.Example.com/")).toBe(
      "example.com",
    );
    expect(normalizeChannelValue("website", "http://example.com/shop")).toBe(
      "example.com/shop",
    );
  });

  it("lowercases and collapses whitespace for handles and everything else", () => {
    expect(
      normalizeChannelValue("marketplace_handle", "  Vintage__Finds  "),
    ).toBe("vintage__finds");
    expect(normalizeChannelValue("other", "Ask  For   Bob")).toBe(
      "ask for bob",
    );
  });
});
