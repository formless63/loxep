/**
 * The manual-assisted backend and its exact-decimal-string normalization
 * helpers. Unit-only — no database needed, mirroring `@loxep/accounting`'s
 * `decimal.test.ts` tier.
 */
import { describe, expect, it } from "vitest";
import { MANUAL_PARSER_ID, manualParser, normalizeDateString, normalizeMoneyString } from "../src/index.ts";

describe("manualParser", () => {
  it("returns zero lines and at least one warning — it never guesses", async () => {
    const result = await manualParser.parse({
      mediaObjectId: "11111111-1111-1111-1111-111111111111",
      documentKind: "receipt",
    });
    expect(result.parserId).toBe(MANUAL_PARSER_ID);
    expect(result.lines).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("carries hints through to currency/documentTotal", async () => {
    const result = await manualParser.parse({
      mediaObjectId: "11111111-1111-1111-1111-111111111111",
      documentKind: "invoice",
      hints: { currency: "usd", expectedTotal: "42.500000" },
    });
    expect(result.currency).toBe("usd");
    expect(result.documentTotal).toBe("42.500000");
  });
});

describe("normalizeMoneyString", () => {
  it("passes through a plain decimal string unchanged", () => {
    expect(normalizeMoneyString("12.50")).toBe("12.50");
    expect(normalizeMoneyString("0")).toBe("0");
  });

  it("strips a leading currency symbol", () => {
    expect(normalizeMoneyString("$12.50")).toBe("12.50");
    expect(normalizeMoneyString("£9.99")).toBe("9.99");
  });

  it("strips thousands-separator commas", () => {
    expect(normalizeMoneyString("1,234.56")).toBe("1234.56");
    expect(normalizeMoneyString("$1,234.56")).toBe("1234.56");
  });

  it("reads parenthesized amounts as negative (the accounting convention for a credit)", () => {
    expect(normalizeMoneyString("(12.50)")).toBe("-12.50");
    expect(normalizeMoneyString("($1,234.56)")).toBe("-1234.56");
  });

  it("reads an explicit leading minus as negative", () => {
    expect(normalizeMoneyString("-12.50")).toBe("-12.50");
  });

  it("returns null for unreadable input rather than guessing", () => {
    expect(normalizeMoneyString("")).toBeNull();
    expect(normalizeMoneyString("N/A")).toBeNull();
    expect(normalizeMoneyString("twelve dollars")).toBeNull();
    expect(normalizeMoneyString("1.2.3")).toBeNull();
  });

  it("never uses parseFloat/Number — exact digit round-trip for many decimals", () => {
    expect(normalizeMoneyString("1234567890.123456789")).toBe("1234567890.123456789");
  });
});

describe("normalizeDateString", () => {
  it("passes through ISO YYYY-MM-DD unchanged", () => {
    expect(normalizeDateString("2026-03-15")).toBe("2026-03-15");
  });

  it("reads US MM/DD/YYYY, zero-padding single digits", () => {
    expect(normalizeDateString("3/5/2026")).toBe("2026-03-05");
    expect(normalizeDateString("12/31/2026")).toBe("2026-12-31");
  });

  it("reads US MM-DD-YYYY", () => {
    expect(normalizeDateString("3-5-2026")).toBe("2026-03-05");
  });

  it("returns null for unreadable input rather than guessing day-first vs month-first", () => {
    expect(normalizeDateString("")).toBeNull();
    expect(normalizeDateString("March 5, 2026")).toBeNull();
    expect(normalizeDateString("not a date")).toBeNull();
  });
});
