/**
 * Exact decimal-string arithmetic. No database, no floats, no rounding except
 * where {@link divideDecimals} reports it.
 */
import { describe, expect, it } from "vitest";
import {
  absDecimal,
  compareDecimals,
  divideDecimals,
  isZeroDecimal,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
} from "../src/decimal.ts";
import { CommerceValidationError } from "../src/errors.ts";

describe("decimal arithmetic", () => {
  it("widens to numeric(20,6) without rounding", () => {
    expect(toMoneyString("12.5")).toBe("12.500000");
    expect(toMoneyString("0")).toBe("0.000000");
    expect(toMoneyString("-3.25")).toBe("-3.250000");
    expect(toMoneyString("1.234567")).toBe("1.234567");
  });

  it("refuses to silently round money it cannot store", () => {
    expect(() => toMoneyString("1.2345678")).toThrow(CommerceValidationError);
    expect(() => toMoneyString("1e3")).toThrow(CommerceValidationError);
  });

  it("sums exactly, including the cases floats get wrong", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754 binary floating point.
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["19.99", "0.01"])).toBe("20.00");
    expect(sumDecimals(["1.005", "2.5", "-0.505"])).toBe("3.000");
    expect(sumDecimals([], "0.00")).toBe("0.00");
  });

  it("subtracts exactly across differing scales", () => {
    expect(subtractDecimals("50.00", "49.999")).toBe("0.001");
    expect(subtractDecimals("10", "12.50")).toBe("-2.50");
  });

  it("reports whether a quotient is exact", () => {
    expect(divideDecimals("50.00", "2")).toEqual({
      value: "25.000000",
      exact: true,
    });
    const inexact = divideDecimals("10.00", "3");
    expect(inexact.exact).toBe(false);
    expect(inexact.value).toBe("3.333333");
    // Half-up on the magnitude, matching PostgreSQL numeric rounding.
    expect(divideDecimals("2.0000005", "1").value).toBe("2.000001");
    expect(divideDecimals("-2.0000005", "1").value).toBe("-2.000001");
    expect(() => divideDecimals("1", "0")).toThrow(CommerceValidationError);
  });

  it("compares independently of trailing zeros", () => {
    expect(compareDecimals("1.50", "1.5")).toBe(0);
    expect(compareDecimals("1.5", "1.500001")).toBe(-1);
    expect(compareDecimals("2", "1.999999")).toBe(1);
    expect(isZeroDecimal("-0.000")).toBe(true);
    expect(absDecimal("-12.50")).toBe("12.50");
  });
});
