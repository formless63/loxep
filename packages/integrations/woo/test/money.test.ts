import { describe, expect, it } from "vitest";
import {
  absDecimal,
  decimalFromNumber,
  decimalFromProvider,
  decimalFromUnknown,
  isDecimalString,
  isZeroDecimal,
  subtractDecimals,
  sumDecimals,
} from "../src/index.ts";

describe("decimal-string discipline", () => {
  it("accepts provider decimal strings verbatim, trailing zeros preserved", () => {
    expect(decimalFromProvider("0.00")).toBe("0.00");
    expect(decimalFromProvider("192.64")).toBe("192.64");
    expect(decimalFromProvider("-10.00")).toBe("-10.00");
    expect(decimalFromProvider(" 12.50 ")).toBe("12.50");
  });

  it("rejects non-decimal provider values rather than coercing", () => {
    for (const value of ["", "N/A", "1,234.00", "1e3", "0x10", null, undefined, {}]) {
      expect(decimalFromProvider(value)).toBeNull();
    }
  });

  it("converts the one float money field WooCommerce emits", () => {
    // `line_items[].price` arrives as a JSON number; shortest round-trip
    // formatting recovers the original literal for realistic money values.
    expect(decimalFromNumber(179.99)).toBe("179.99");
    expect(decimalFromNumber(22.5)).toBe("22.5");
    expect(decimalFromNumber(0.001)).toBe("0.001");
    expect(decimalFromNumber(0)).toBe("0");
    expect(decimalFromNumber(-4.25)).toBe("-4.25");
  });

  it("returns null rather than guessing for values it cannot write in plain decimal", () => {
    expect(decimalFromNumber(1e21)).toBeNull();
    expect(decimalFromNumber(1e-7)).toBeNull();
    expect(decimalFromNumber(Number.NaN)).toBeNull();
    expect(decimalFromNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(decimalFromNumber("22.50")).toBeNull();
  });

  it("decimalFromUnknown accepts either representation", () => {
    expect(decimalFromUnknown("22.50")).toBe("22.50");
    expect(decimalFromUnknown(22.5)).toBe("22.5");
    expect(decimalFromUnknown(true)).toBeNull();
  });

  it("isDecimalString guards the exported invariant", () => {
    expect(isDecimalString("1")).toBe(true);
    expect(isDecimalString("1.")).toBe(false);
    expect(isDecimalString(1)).toBe(false);
  });
});

describe("exact arithmetic (never floats)", () => {
  it("sums 2-decimal amounts exactly", () => {
    expect(sumDecimals(["179.99", "12.65"])).toBe("192.64");
    expect(sumDecimals(["0.00", "0.00"])).toBe("0.00");
  });

  it("survives the classic binary-float traps", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754; scaled BigInt makes it exact.
    expect(sumDecimals(["0.10", "0.20"])).toBe("0.30");
    expect(sumDecimals(["1.005", "2.005"])).toBe("3.010");
    expect(
      sumDecimals(Array.from({ length: 10 }, () => "0.1")),
    ).toBe("1.0");
  });

  it("promotes to the greatest input scale", () => {
    expect(sumDecimals(["10.10", "0.20", "0.001"])).toBe("10.301");
    expect(sumDecimals(["1", "0.5"])).toBe("1.5");
  });

  it("returns the supplied empty value for an empty list", () => {
    expect(sumDecimals([])).toBe("0.00");
    expect(sumDecimals([], "0")).toBe("0");
  });

  it("subtracts exactly, including sign flips", () => {
    expect(subtractDecimals("45.00", "40.00")).toBe("5.00");
    expect(subtractDecimals("40.00", "45.00")).toBe("-5.00");
    expect(subtractDecimals("0.3", "0.1")).toBe("0.2");
    expect(subtractDecimals("1", "1.25")).toBe("-0.25");
  });

  it("takes magnitudes and detects zero across scales", () => {
    expect(absDecimal("-10.00")).toBe("10.00");
    expect(absDecimal("10.00")).toBe("10.00");
    expect(isZeroDecimal("0")).toBe(true);
    expect(isZeroDecimal("0.000")).toBe(true);
    expect(isZeroDecimal("-0.00")).toBe(true);
    expect(isZeroDecimal("0.01")).toBe(false);
  });

  it("handles very large amounts without precision loss", () => {
    expect(sumDecimals(["99999999999999.99", "0.01"])).toBe("100000000000000.00");
  });
});
