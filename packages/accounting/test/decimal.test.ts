/**
 * Exact decimal arithmetic. Unit-only: no database, no scratch DB.
 *
 * These assertions are the reason `@loxep/accounting` re-declares the
 * primitives instead of importing `@loxep/commerce`'s — the behaviour has to be
 * identical, and a test that says so is cheaper than a package edge.
 */
import { describe, expect, it } from "vitest";
import {
  ZERO,
  absDecimal,
  compareDecimals,
  fromUnits,
  isDecimalString,
  isNegative,
  isZeroDecimal,
  negateDecimal,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
  toUnits,
} from "../src/decimal.ts";
import { AccountingValidationError } from "../src/errors.ts";

describe("decimal strings", () => {
  it("recognizes plain decimals and rejects exponent notation", () => {
    expect(isDecimalString("0")).toBe(true);
    expect(isDecimalString("-12.345678")).toBe(true);
    expect(isDecimalString("1e6")).toBe(false);
    expect(isDecimalString(12 as unknown)).toBe(false);
  });

  it("renders at numeric(20,6) scale exactly as PostgreSQL echoes it", () => {
    expect(toMoneyString("0")).toBe(ZERO);
    expect(toMoneyString("19.99")).toBe("19.990000");
    expect(toMoneyString("-4")).toBe("-4.000000");
  });

  it("refuses to reduce scale, because that would round money", () => {
    expect(() => toUnits("0.1234567", 6)).toThrow(AccountingValidationError);
  });

  it("round-trips through scaled units", () => {
    expect(fromUnits(toUnits("123.456789", 6))).toBe("123.456789");
    expect(toUnits("1.5")).toBe(1_500_000n);
  });
});

describe("exact arithmetic", () => {
  it("sums without floating-point drift", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754; it is exactly 0.3 here.
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.300000");
    expect(sumDecimals([])).toBe(ZERO);
    expect(sumDecimals(["10.000001", "-10.000002"])).toBe("-0.000001");
  });

  it("subtracts, negates, and takes magnitude exactly", () => {
    expect(subtractDecimals("100", "33.333333")).toBe("66.666667");
    expect(negateDecimal("-7.5")).toBe("7.500000");
    expect(absDecimal("-0.000001")).toBe("0.000001");
  });

  it("compares by value, never through Number", () => {
    // 9007199254740993 is not representable as an IEEE 754 double.
    expect(compareDecimals("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareDecimals("1.000000", "1")).toBe(0);
    expect(compareDecimals("-1", "1")).toBe(-1);
  });

  it("identifies zero and sign", () => {
    expect(isZeroDecimal("0.000000")).toBe(true);
    expect(isZeroDecimal("-0")).toBe(true);
    expect(isNegative("-0.000001")).toBe(true);
    expect(isNegative("0")).toBe(false);
  });
});
