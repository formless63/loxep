import { describe, expect, it } from "vitest";
import {
  DECIMAL_STRING,
  MEDUSA_CURRENCY_DECIMAL_DIGITS,
  absDecimal,
  decimalFromNumber,
  decimalFromProvider,
  decimalFromUnknown,
  excessPrecisionDigits,
  isDecimalString,
  isZeroDecimal,
  medusaCurrencyDecimalDigits,
  normalizeMedusaCurrencyCode,
  subtractDecimals,
  sumDecimals,
} from "../src/index.ts";

describe("decimalFromNumber — the primary Medusa v2 money path", () => {
  it("converts a JS number in major units to an exact decimal string", () => {
    expect(decimalFromNumber(10)).toBe("10");
    expect(decimalFromNumber(10.5)).toBe("10.5");
    expect(decimalFromNumber(48.15)).toBe("48.15");
    expect(decimalFromNumber(0)).toBe("0");
  });

  it("does not round to the currency's nominal precision — passes the exact value through", () => {
    // Reproduces the documented upstream precision defect
    // (github.com/medusajs/medusa/issues/14818): more fractional digits than
    // USD's nominal 2. This module deliberately does not "fix" that.
    expect(decimalFromNumber(3.199999)).toBe("3.199999");
  });

  it("returns null for a non-finite value", () => {
    expect(decimalFromNumber(Number.NaN)).toBeNull();
    expect(decimalFromNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("returns null rather than an exponential-notation string", () => {
    expect(decimalFromNumber(1e21)).toBeNull();
    expect(decimalFromNumber(1e-9)).toBeNull();
  });

  it("returns null for a non-number input", () => {
    expect(decimalFromNumber("10.50")).toBeNull();
    expect(decimalFromNumber(null)).toBeNull();
    expect(decimalFromNumber(undefined)).toBeNull();
  });
});

describe("decimalFromProvider / decimalFromUnknown — robustness for the rare string case", () => {
  it("passes a decimal string through verbatim", () => {
    expect(decimalFromProvider("10.50")).toBe("10.50");
    expect(decimalFromProvider("")).toBeNull();
    expect(decimalFromProvider("abc")).toBeNull();
  });

  it("decimalFromUnknown accepts either a number or a string", () => {
    expect(decimalFromUnknown(10.5)).toBe("10.5");
    expect(decimalFromUnknown("10.50")).toBe("10.50");
    expect(decimalFromUnknown(null)).toBeNull();
  });
});

describe("isDecimalString / DECIMAL_STRING", () => {
  it("matches ordinary and negative decimals", () => {
    expect(isDecimalString("10.50")).toBe(true);
    expect(isDecimalString("-10.50")).toBe(true);
    expect(isDecimalString("10")).toBe(true);
    expect(isDecimalString("10.")).toBe(false);
    expect(isDecimalString("abc")).toBe(false);
    expect(isDecimalString(10.5)).toBe(false);
  });
});

describe("sumDecimals / subtractDecimals / absDecimal / isZeroDecimal", () => {
  it("sums exactly across mixed scales, no float rounding", () => {
    expect(sumDecimals(["10.10", "0.20", "0.001"])).toBe("10.301");
    expect(sumDecimals([])).toBe("0.00");
    expect(sumDecimals([], "0")).toBe("0");
  });

  it("subtracts exactly", () => {
    expect(subtractDecimals("45.00", "40.00")).toBe("5.00");
    expect(subtractDecimals("10", "12")).toBe("-2");
  });

  it("computes magnitude and zero-ness", () => {
    expect(absDecimal("-12.50")).toBe("12.50");
    expect(absDecimal("12.50")).toBe("12.50");
    expect(isZeroDecimal("0.00")).toBe(true);
    expect(isZeroDecimal("-0.00")).toBe(true);
    expect(isZeroDecimal("0.01")).toBe(false);
  });
});

describe("MEDUSA_CURRENCY_DECIMAL_DIGITS / medusaCurrencyDecimalDigits", () => {
  it("has 126 currencies, extracted verbatim from Medusa's own defaultCurrencies table", () => {
    expect(Object.keys(MEDUSA_CURRENCY_DECIMAL_DIGITS)).toHaveLength(126);
  });

  it("gives the common 2-decimal currencies their expected precision", () => {
    expect(medusaCurrencyDecimalDigits("USD")).toBe(2);
    expect(medusaCurrencyDecimalDigits("EUR")).toBe(2);
    expect(medusaCurrencyDecimalDigits("usd")).toBe(2);
  });

  it("gives 0-decimal currencies their expected precision", () => {
    expect(medusaCurrencyDecimalDigits("JPY")).toBe(0);
    expect(medusaCurrencyDecimalDigits("KRW")).toBe(0);
  });

  it("gives 3-decimal currencies their expected precision", () => {
    expect(medusaCurrencyDecimalDigits("KWD")).toBe(3);
    expect(medusaCurrencyDecimalDigits("BHD")).toBe(3);
  });

  it("mirrors Medusa's OWN table even where it diverges from strict ISO 4217 (IQD)", () => {
    // Medusa's defaultCurrencies lists IQD at 0 decimal digits; ISO 4217
    // specifies 3. This adapter intentionally follows Medusa's own
    // assumption — see money.ts.
    expect(medusaCurrencyDecimalDigits("IQD")).toBe(0);
  });

  it("falls back to 2 for a currency code absent from the table", () => {
    expect(medusaCurrencyDecimalDigits("XYZ")).toBe(2);
  });
});

describe("excessPrecisionDigits", () => {
  it("is 0 when precision matches or is coarser than expected", () => {
    expect(excessPrecisionDigits("10.50", "USD")).toBe(0);
    expect(excessPrecisionDigits("10", "USD")).toBe(0);
    expect(excessPrecisionDigits("5000", "JPY")).toBe(0);
  });

  it("flags — without correcting — a value with more fractional digits than expected", () => {
    expect(excessPrecisionDigits("3.199999", "USD")).toBe(4);
    expect(excessPrecisionDigits("5000.5", "JPY")).toBe(1);
  });
});

describe("normalizeMedusaCurrencyCode", () => {
  it("uppercases and trims", () => {
    expect(normalizeMedusaCurrencyCode("usd")).toBe("USD");
    expect(normalizeMedusaCurrencyCode("  eur  ")).toBe("EUR");
  });

  it("returns an empty string for a non-string input", () => {
    expect(normalizeMedusaCurrencyCode(null)).toBe("");
    expect(normalizeMedusaCurrencyCode(undefined)).toBe("");
  });
});
