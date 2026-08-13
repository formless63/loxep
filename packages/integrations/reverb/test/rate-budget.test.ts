/**
 * The token-bucket algorithm itself (identical to eBay's/Etsy's). The
 * PER-CONNECTION composition decision this module's doc describes is tested
 * at `packages/app/test/reverb.test.ts`, where it actually matters (this
 * module has no notion of "connections" at all).
 */
import { describe, expect, it, vi } from "vitest";
import { createRateBudget, ReverbAdapterError } from "../src/index.ts";

describe("createRateBudget", () => {
  it("rejects a non-positive capacity or refillPerSecond", () => {
    expect(() => createRateBudget({ capacity: 0, refillPerSecond: 1 })).toThrowError(
      ReverbAdapterError,
    );
    expect(() => createRateBudget({ capacity: 1, refillPerSecond: 0 })).toThrowError(
      ReverbAdapterError,
    );
  });

  it("acquires immediately while tokens remain", async () => {
    const budget = createRateBudget({ capacity: 5, refillPerSecond: 1 });
    for (let i = 0; i < 5; i++) {
      await budget.acquire(1);
    }
    expect(budget.stats().available).toBeCloseTo(0, 5);
    expect(budget.stats().acquired).toBe(5);
  });

  it("tryAcquire never waits and reports false when exhausted", () => {
    const budget = createRateBudget({ capacity: 1, refillPerSecond: 1 });
    expect(budget.tryAcquire(1)).toBe(true);
    expect(budget.tryAcquire(1)).toBe(false);
    expect(budget.stats().rejected).toBe(0); // tryAcquire failures aren't counted as rejections
  });

  it("rejects with rate_limited when a wait would exceed maxWaitMs", async () => {
    const budget = createRateBudget({ capacity: 1, refillPerSecond: 0.01, maxWaitMs: 10 });
    await budget.acquire(1);
    await expect(budget.acquire(1)).rejects.toMatchObject({
      kind: "rate_limited",
      detail: expect.objectContaining({ source: "local_rate_budget" }),
    });
    expect(budget.stats().rejected).toBe(1);
  });

  it("waits for refill and then succeeds when the wait is within budget", async () => {
    vi.useFakeTimers();
    try {
      const budget = createRateBudget({ capacity: 1, refillPerSecond: 10 });
      await budget.acquire(1);
      const pending = budget.acquire(1);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(60);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a cost of zero, negative, or above capacity", () => {
    const budget = createRateBudget({ capacity: 3, refillPerSecond: 1 });
    expect(() => budget.tryAcquire(0)).toThrowError(ReverbAdapterError);
    expect(() => budget.tryAcquire(-1)).toThrowError(ReverbAdapterError);
    expect(() => budget.tryAcquire(4)).toThrowError(ReverbAdapterError);
  });
});
