import { describe, expect, it } from "vitest";
import { decimalFromReverbMoney, normalizeReverbMoney, reverbMoneyCurrency } from "../src/index.ts";

describe("decimalFromReverbMoney", () => {
  it("passes through a valid decimal string verbatim", () => {
    expect(decimalFromReverbMoney({ amount: "2999.99", currency: "USD" })).toBe("2999.99");
  });

  it("accepts a whole-number decimal string", () => {
    expect(decimalFromReverbMoney({ amount: "0", currency: "USD" })).toBe("0");
  });

  it("accepts a negative decimal string (a refund/adjustment)", () => {
    expect(decimalFromReverbMoney({ amount: "-10.00", currency: "USD" })).toBe("-10.00");
  });

  it("returns null when amount is a JS number, not a string", () => {
    // Reverb's own wire format uses a decimal STRING; a raw number here
    // would mean the boundary contract changed and must not be silently
    // accepted.
    expect(decimalFromReverbMoney({ amount: 2999.99, currency: "USD" })).toBeNull();
  });

  it("returns null for a malformed decimal string", () => {
    expect(decimalFromReverbMoney({ amount: "not-a-number", currency: "USD" })).toBeNull();
  });

  it("returns null when amount is missing", () => {
    expect(decimalFromReverbMoney({ currency: "USD" })).toBeNull();
  });

  it("returns null for a non-object input", () => {
    expect(decimalFromReverbMoney("2999.99")).toBeNull();
    expect(decimalFromReverbMoney(null)).toBeNull();
    expect(decimalFromReverbMoney(undefined)).toBeNull();
  });

  it("ignores amount_cents/symbol/display — amount is the only source of truth", () => {
    expect(
      decimalFromReverbMoney({
        amount: "95.00",
        amount_cents: 9500,
        currency: "USD",
        symbol: "$",
        display: "$95",
      }),
    ).toBe("95.00");
  });
});

describe("reverbMoneyCurrency", () => {
  it("uppercases a lowercase currency code", () => {
    expect(reverbMoneyCurrency({ amount: "1.00", currency: "usd" })).toBe("USD");
  });

  it("returns null for a malformed currency code", () => {
    expect(reverbMoneyCurrency({ amount: "1.00", currency: "US" })).toBeNull();
    expect(reverbMoneyCurrency({ amount: "1.00", currency: 840 })).toBeNull();
  });
});

describe("normalizeReverbMoney", () => {
  it("normalizes a full Money object", () => {
    expect(normalizeReverbMoney({ amount: "2999.99", currency: "usd" })).toEqual({
      value: "2999.99",
      currency: "USD",
    });
  });

  it("returns null when either half is unusable", () => {
    expect(normalizeReverbMoney({ amount: "2999.99" })).toBeNull();
    expect(normalizeReverbMoney({ currency: "USD" })).toBeNull();
    expect(normalizeReverbMoney(null)).toBeNull();
  });
});
