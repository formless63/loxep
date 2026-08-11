/**
 * Exact decimal arithmetic and the largest-remainder distribution.
 *
 * The distribution is the only piece of Phase 4 arithmetic that two separate
 * design commitments both depend on — lot cost allocation and read-model pro
 * rata — so its edges are tested directly rather than only through the services
 * that call it. Every expectation here is hand-computed.
 */
import { describe, expect, it } from "vitest";
import {
  clampNonNegative,
  distributeByWeights,
  isNegative,
  multiplyDecimals,
  negateDecimal,
  sumDecimals,
  toMoneyString,
} from "../src/decimal.ts";
import { InventoryValidationError } from "../src/errors.ts";

describe("multiplyDecimals", () => {
  it("is exact when the product fits the scale", () => {
    expect(multiplyDecimals("2.5", "4")).toEqual({
      value: "10.000000",
      exact: true,
    });
  });

  it("reports inexactness rather than hiding a rounded product", () => {
    const result = multiplyDecimals("0.0000001", "1");
    expect(result.exact).toBe(false);
    expect(result.value).toBe("0.000000");
  });

  it("rounds half-up on the magnitude, so -x rounds like x", () => {
    expect(multiplyDecimals("0.0000005", "1").value).toBe("0.000001");
    expect(multiplyDecimals("-0.0000005", "1").value).toBe("-0.000001");
  });
});

describe("negateDecimal / isNegative / clampNonNegative", () => {
  it("round-trips a sign without changing scale", () => {
    expect(negateDecimal("12.50")).toBe("-12.50");
    expect(negateDecimal("-12.50")).toBe("12.50");
    expect(isNegative("-0.000001")).toBe(true);
    expect(isNegative("0")).toBe(false);
    expect(clampNonNegative("-5")).toBe("0.000000");
    expect(clampNonNegative("5")).toBe("5");
  });
});

describe("distributeByWeights", () => {
  it("splits a divisible amount exactly", () => {
    const { shares, unallocated } = distributeByWeights("300", ["1", "1", "1"]);
    expect(shares).toEqual(["100.000000", "100.000000", "100.000000"]);
    expect(unallocated).toBe("0.000000");
  });

  it("hands the indivisible remainder to the largest remainders, earliest first", () => {
    // 0.01 across three equal weights: 0.003333|3 each, one unit of 1e-6 left.
    const { shares } = distributeByWeights("0.01", ["1", "1", "1"]);
    expect(shares).toEqual(["0.003334", "0.003333", "0.003333"]);
    expect(sumDecimals(shares)).toBe("0.010000");
  });

  it("always sums to the original amount, whatever the weights", () => {
    const { shares } = distributeByWeights("100", ["7", "11", "13"]);
    expect(sumDecimals(shares)).toBe("100.000000");
    // 700/31 = 22.580645|16… -> floor 22.580645, remainder 5/31
    // 1100/31 = 35.483870|97… -> floor 35.483870, remainder 27/31  <- largest
    // 1300/31 = 41.935483|87… -> floor 41.935483, remainder 27/31  <- tie, later
    expect(shares).toEqual(["22.580645", "35.483871", "41.935484"]);
  });

  it("gives a zero weight NO share, and leaves the shortfall with the payers", () => {
    const { shares } = distributeByWeights("100", ["1", "0", "1"]);
    expect(shares).toEqual(["50.000000", "0.000000", "50.000000"]);
  });

  it("distributes a credit exactly as it distributes a charge", () => {
    const charge = distributeByWeights("0.03", ["1", "1", "1"]).shares;
    const credit = distributeByWeights("-0.03", ["1", "1", "1"]).shares;
    expect(charge).toEqual(["0.010000", "0.010000", "0.010000"]);
    expect(credit).toEqual(["-0.010000", "-0.010000", "-0.010000"]);
  });

  it("reports the whole amount as unallocated when every weight is zero", () => {
    const { shares, unallocated } = distributeByWeights("250", ["0", "0"]);
    expect(shares).toEqual(["0.000000", "0.000000"]);
    expect(unallocated).toBe("250.000000");
  });

  it("refuses a negative weight rather than handing out a negative share", () => {
    expect(() => distributeByWeights("100", ["1", "-1"])).toThrow(
      InventoryValidationError,
    );
  });

  it("handles the design's own example: $250 across 3 items by estimated value", () => {
    // Estimated values 100 / 60 / 40 -> 125.00 / 75.00 / 50.00 exactly.
    const { shares } = distributeByWeights("250", ["100", "60", "40"]);
    expect(shares).toEqual(["125.000000", "75.000000", "50.000000"]);
  });

  it("keeps a stubborn thirds case exact", () => {
    const { shares } = distributeByWeights("100", ["1", "1", "1"]);
    expect(shares).toEqual(["33.333334", "33.333333", "33.333333"]);
    expect(sumDecimals(shares)).toBe("100.000000");
  });
});

describe("toMoneyString", () => {
  it("widens to numeric(20,6) exactly as PostgreSQL echoes it", () => {
    expect(toMoneyString("12.5")).toBe("12.500000");
  });

  it("refuses to round away a scale numeric(20,6) cannot hold", () => {
    expect(() => toMoneyString("1.0000001")).toThrow();
  });
});
