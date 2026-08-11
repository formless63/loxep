import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EbayAdapterError, createRateBudget } from "../src/index.ts";

describe("createRateBudget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects invalid construction and costs", async () => {
    expect(() =>
      createRateBudget({ capacity: 0, refillPerSecond: 1 }),
    ).toThrowError(EbayAdapterError);
    expect(() =>
      createRateBudget({ capacity: 1, refillPerSecond: 0 }),
    ).toThrowError(EbayAdapterError);
    const budget = createRateBudget({ capacity: 2, refillPerSecond: 1 });
    // cost > capacity can never succeed — fail fast.
    expect(() => budget.tryAcquire(3)).toThrowError(EbayAdapterError);
    await expect(budget.acquire(3)).rejects.toThrowError(EbayAdapterError);
  });

  it("acquires immediately while tokens remain, then waits for refill", async () => {
    const budget = createRateBudget({ capacity: 2, refillPerSecond: 1 });
    await budget.acquire();
    await budget.acquire();
    expect(budget.stats().available).toBe(0);

    let resolved = false;
    const waiting = budget.acquire().then(() => {
      resolved = true;
    });
    expect(budget.stats().pending).toBe(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    await waiting;
    expect(resolved).toBe(true);
    expect(budget.stats().acquired).toBe(3);
  });

  it("throws rate_limited without consuming when the wait would exceed maxWaitMs", async () => {
    const budget = createRateBudget({
      capacity: 1,
      refillPerSecond: 0.001, // 1000s per token
      maxWaitMs: 50,
    });
    await budget.acquire();
    const error = await budget.acquire().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EbayAdapterError);
    const adapterError = error as EbayAdapterError;
    expect(adapterError.kind).toBe("rate_limited");
    expect(adapterError.detail["source"]).toBe("local_rate_budget");
    expect(adapterError.detail["requiredWaitMs"]).toBeGreaterThan(50);
    const stats = budget.stats();
    expect(stats.rejected).toBe(1);
    expect(stats.pending).toBe(0);
    // The rejected acquire consumed nothing: a per-call maxWaitMs override
    // long enough to cover the deficit still succeeds.
    const patient = budget.acquire(1, { maxWaitMs: 2_000_000 });
    await vi.advanceTimersByTimeAsync(1_000_000);
    await patient;
  });

  it("tryAcquire never waits", () => {
    const budget = createRateBudget({ capacity: 1, refillPerSecond: 1 });
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(budget.tryAcquire()).toBe(true);
  });

  it("caps refill at capacity", () => {
    const budget = createRateBudget({ capacity: 3, refillPerSecond: 10 });
    expect(budget.tryAcquire(3)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(budget.stats().available).toBe(3);
  });

  it("serves concurrent waiters roughly FIFO (reservation order)", async () => {
    const budget = createRateBudget({ capacity: 1, refillPerSecond: 1 });
    await budget.acquire();
    const order: number[] = [];
    const first = budget.acquire().then(() => order.push(1));
    const second = budget.acquire().then(() => order.push(2));
    const third = budget.acquire().then(() => order.push(3));
    await vi.advanceTimersByTimeAsync(3_100);
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("exposes remaining budget through stats", async () => {
    const budget = createRateBudget({ capacity: 4, refillPerSecond: 2 });
    await budget.acquire(3);
    const stats = budget.stats();
    expect(stats.capacity).toBe(4);
    expect(stats.refillPerSecond).toBe(2);
    expect(stats.available).toBeCloseTo(1, 5);
    expect(stats.acquired).toBe(1);
    expect(stats.rejected).toBe(0);
  });
});
