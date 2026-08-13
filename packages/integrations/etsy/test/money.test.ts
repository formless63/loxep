import { describe, expect, it } from "vitest";
import {
  decimalFromEtsyMoney,
  etsyMoneyCurrency,
  EtsyAdapterError,
  normalizeEtsyMoney,
  requireEtsyMoney,
} from "../src/index.ts";

describe("decimalFromEtsyMoney — divisor 100 (USD/EUR/GBP-shaped)", () => {
  it("converts a typical amount exactly, never through JS float division", () => {
    expect(decimalFromEtsyMoney({ amount: 2999, divisor: 100, currency_code: "USD" })).toBe(
      "29.99",
    );
  });

  it("preserves the two-decimal scale for zero", () => {
    expect(decimalFromEtsyMoney({ amount: 0, divisor: 100, currency_code: "USD" })).toBe(
      "0.00",
    );
  });

  it("handles a large amount without losing precision", () => {
    expect(
      decimalFromEtsyMoney({ amount: 999_999_999_999, divisor: 100, currency_code: "USD" }),
    ).toBe("9999999999.99");
  });

  it("handles a negative amount (a refund/adjustment context)", () => {
    expect(decimalFromEtsyMoney({ amount: -1500, divisor: 100, currency_code: "USD" })).toBe(
      "-15.00",
    );
  });

  it("handles an amount smaller than the divisor (leading zero)", () => {
    expect(decimalFromEtsyMoney({ amount: 5, divisor: 100, currency_code: "USD" })).toBe(
      "0.05",
    );
  });
});

describe("decimalFromEtsyMoney — divisor 1 (JPY-shaped, no fractional unit)", () => {
  it("passes the integer through with no decimal point", () => {
    expect(decimalFromEtsyMoney({ amount: 3200, divisor: 1, currency_code: "JPY" })).toBe(
      "3200",
    );
  });

  it("preserves zero with no decimal point", () => {
    expect(decimalFromEtsyMoney({ amount: 0, divisor: 1, currency_code: "JPY" })).toBe("0");
  });
});

describe("decimalFromEtsyMoney — non-power-of-ten divisor (never observed live, defensive)", () => {
  it("returns the exact quotient when it terminates", () => {
    // 500 / 8 = 62.5 exactly.
    expect(decimalFromEtsyMoney({ amount: 500, divisor: 8, currency_code: "USD" })).toBe(
      "62.5",
    );
  });

  it("returns null rather than a rounded guess when the quotient never terminates", () => {
    // 100 / 3 = 33.333... — never terminates in decimal.
    expect(decimalFromEtsyMoney({ amount: 100, divisor: 3, currency_code: "USD" })).toBeNull();
  });
});

describe("decimalFromEtsyMoney — malformed input", () => {
  it("returns null for a non-object, a missing field, or a non-integer amount", () => {
    expect(decimalFromEtsyMoney(null)).toBeNull();
    expect(decimalFromEtsyMoney(undefined)).toBeNull();
    expect(decimalFromEtsyMoney("29.99")).toBeNull();
    expect(decimalFromEtsyMoney({ amount: 2999 })).toBeNull();
    expect(decimalFromEtsyMoney({ amount: 29.99, divisor: 100 })).toBeNull();
    expect(decimalFromEtsyMoney({ amount: 2999, divisor: 0 })).toBeNull();
    expect(decimalFromEtsyMoney({ amount: 2999, divisor: -100 })).toBeNull();
  });

  it("never performs the division in JS number arithmetic (no float artifacts)", () => {
    // A value chosen because amount/divisor in binary float is NOT exact
    // (0.1 + 0.2 territory) — an implementation using `amount / divisor`
    // would risk a trailing-digit artifact; the BigInt path must not.
    expect(decimalFromEtsyMoney({ amount: 110, divisor: 100, currency_code: "USD" })).toBe(
      "1.10",
    );
    expect(decimalFromEtsyMoney({ amount: 29, divisor: 100, currency_code: "USD" })).toBe(
      "0.29",
    );
  });
});

describe("etsyMoneyCurrency", () => {
  it("uppercases and validates a 3-letter code", () => {
    expect(etsyMoneyCurrency({ currency_code: "usd" })).toBe("USD");
  });

  it("returns null for a missing or malformed code", () => {
    expect(etsyMoneyCurrency({})).toBeNull();
    expect(etsyMoneyCurrency({ currency_code: "US" })).toBeNull();
    expect(etsyMoneyCurrency({ currency_code: 840 })).toBeNull();
  });
});

describe("normalizeEtsyMoney / requireEtsyMoney", () => {
  it("normalizes a full Money object", () => {
    expect(normalizeEtsyMoney({ amount: 2999, divisor: 100, currency_code: "USD" })).toEqual({
      value: "29.99",
      currency: "USD",
    });
  });

  it("returns null when either half is unusable", () => {
    expect(normalizeEtsyMoney({ amount: 2999, divisor: 100 })).toBeNull();
    expect(normalizeEtsyMoney({ divisor: 100, currency_code: "USD" })).toBeNull();
  });

  it("requireEtsyMoney throws provider_unavailable on an unusable value", () => {
    try {
      requireEtsyMoney(null, "listing 123's price");
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EtsyAdapterError);
      expect((error as EtsyAdapterError).kind).toBe("provider_unavailable");
    }
  });
});
