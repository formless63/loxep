import { describe, expect, it } from "vitest";
import {
  DECIMAL_STRING,
  decimalFromNumber,
  decimalFromProvider,
  decimalFromUnknown,
  isDecimalString,
  numberFromDecimal,
} from "../src/index.ts";

describe("isDecimalString / DECIMAL_STRING", () => {
  it("accepts plain decimal strings, signed and unsigned", () => {
    expect(isDecimalString("10.50")).toBe(true);
    expect(isDecimalString("-3.25")).toBe(true);
    expect(isDecimalString("0")).toBe(true);
  });

  it("rejects non-decimal shapes", () => {
    expect(isDecimalString("1e10")).toBe(false);
    expect(isDecimalString("abc")).toBe(false);
    expect(isDecimalString(10.5)).toBe(false);
  });
});

describe("decimalFromNumber — Invoice Ninja's (float)-cast major-unit money", () => {
  it("converts a plain JSON number to its exact decimal string", () => {
    expect(decimalFromNumber(48.15)).toBe("48.15");
    expect(decimalFromNumber(500)).toBe("500");
    expect(decimalFromNumber(0)).toBe("0");
  });

  it("returns null for non-finite or non-number input", () => {
    expect(decimalFromNumber(Number.NaN)).toBeNull();
    expect(decimalFromNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(decimalFromNumber("48.15")).toBeNull();
    expect(decimalFromNumber(null)).toBeNull();
  });

  it("returns null rather than guessing for a value JS formats with an exponent", () => {
    expect(decimalFromNumber(1e21)).toBeNull();
  });
});

describe("decimalFromProvider", () => {
  it("passes a provider decimal string through verbatim, trailing zeros included", () => {
    expect(decimalFromProvider("48.150")).toBe("48.150");
  });

  it("returns null for a non-string or non-decimal-shaped string", () => {
    expect(decimalFromProvider(48.15)).toBeNull();
    expect(decimalFromProvider("not a number")).toBeNull();
  });
});

describe("decimalFromUnknown", () => {
  it("prefers the number path, falling back to the string path", () => {
    expect(decimalFromUnknown(48.15)).toBe("48.15");
    expect(decimalFromUnknown("48.150")).toBe("48.150");
    expect(decimalFromUnknown(null)).toBeNull();
  });
});

describe("numberFromDecimal — the outbound direction", () => {
  it("converts a decimal string to the JSON number Invoice Ninja expects", () => {
    expect(numberFromDecimal("48.15")).toBe(48.15);
    expect(numberFromDecimal("500")).toBe(500);
    expect(numberFromDecimal("-3.25")).toBe(-3.25);
  });

  it("throws on a non-decimal-string input rather than sending NaN", () => {
    expect(() => numberFromDecimal("not a number")).toThrow(RangeError);
    expect(() => numberFromDecimal("1e10")).toThrow(RangeError);
  });

  it("round-trips through DECIMAL_STRING", () => {
    expect(DECIMAL_STRING.test(String(numberFromDecimal("12.50")))).toBe(true);
  });
});
