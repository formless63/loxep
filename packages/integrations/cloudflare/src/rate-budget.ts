/**
 * Per-connection API rate budget for the Cloudflare boundary: a token bucket
 * every request must acquire from before hitting the network.
 *
 * This is deliberately a LOCAL copy of the eBay/WooCommerce budget shape
 * rather than an import. Integration packages must not depend on each other
 * (ADR-0009 boundaries are per provider), and the alternative — a shared
 * `@loxep/integration-core` — would couple every provider's release to one
 * package. The type surface is intentionally identical so a caller can hold
 * several behind one structural interface.
 *
 * Semantics (identical to the siblings):
 * - the bucket starts full (`capacity` tokens) and refills continuously at
 *   `refillPerSecond`, capped at `capacity`;
 * - `acquire(cost)` resolves immediately when tokens are available; otherwise
 *   it reserves the deficit and waits for refill, approximately FIFO;
 * - when the required wait would exceed `maxWaitMs` (default 30s), `acquire`
 *   throws a `CloudflareAdapterError` of kind `rate_limited` with
 *   `detail.source = "local_rate_budget"` and consumes nothing;
 * - `tryAcquire(cost)` never waits; `stats()` exposes remaining budget.
 *
 * ## The real Cloudflare limit, verified 2026-08-13
 *
 * *"The global rate limit for the Cloudflare API is 1,200 requests per five
 * minute period per user"*, and it *"applies cumulatively regardless of
 * whether the request is made via the dashboard, API key, or API token"*
 * (developers.cloudflare.com/fundamentals/api/reference/limits/). That is 4
 * requests per second, **shared with the operator's own dashboard use and
 * every other tool pointed at the same account**. Exceeding it blocks all API
 * calls for the next five minutes with HTTP 429.
 *
 * The default below is therefore a fraction of the ceiling, not close to it: a
 * reconciler that spends the operator's whole budget makes their dashboard
 * stop working, which is a worse failure than being slow. Cloudflare also
 * returns `Ratelimit` / `Ratelimit-Policy` headers and a `retry-after` on
 * refusal; the adapter surfaces those on the `rate_limited` error rather than
 * mutating the bucket from them, because the header describes a limit this
 * budget does not own.
 *
 * LIMITATION (documented on purpose): this budget is in-memory and
 * per-process, matching the single-worker default. If multiple workers ever
 * drive the same Cloudflare account, the budget must move to shared state or
 * the per-process budgets must be divided.
 */
import { CloudflareAdapterError } from "./errors.ts";

export interface CloudflareAdapterLogger {
  debug?: (fields: Record<string, unknown>, message?: string) => void;
  info?: (fields: Record<string, unknown>, message?: string) => void;
  warn?: (fields: Record<string, unknown>, message?: string) => void;
  error?: (fields: Record<string, unknown>, message?: string) => void;
}

export interface RateBudgetStats {
  capacity: number;
  refillPerSecond: number;
  /** Tokens available right now (0 when waiters have reserved ahead). */
  available: number;
  /** Acquisitions currently waiting on refill. */
  pending: number;
  /** Total successful acquisitions since creation. */
  acquired: number;
  /** Total acquisitions rejected as rate_limited since creation. */
  rejected: number;
}

export interface RateBudget {
  acquire(cost?: number, options?: { maxWaitMs?: number }): Promise<void>;
  tryAcquire(cost?: number): boolean;
  stats(): RateBudgetStats;
}

export interface CreateRateBudgetOptions {
  capacity: number;
  refillPerSecond: number;
  /** Default bound on how long one acquire may wait. Default 30 000 ms. */
  maxWaitMs?: number;
  logger?: CloudflareAdapterLogger;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

/**
 * Cloudflare's documented global ceiling, expressed per second: 1200 requests
 * per five minutes. Exported so a caller can show how much of the account's
 * budget a configured refill rate claims.
 */
export const CLOUDFLARE_GLOBAL_LIMIT_PER_SECOND = 1200 / 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateBudget(
  options: CreateRateBudgetOptions,
): RateBudget {
  const { capacity, refillPerSecond, logger } = options;
  const defaultMaxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new CloudflareAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new CloudflareAdapterError(
      "invalid_request",
      "rate budget refillPerSecond must be a positive number",
    );
  }

  let tokens = capacity;
  let lastRefillAt = Date.now();
  let pending = 0;
  let acquired = 0;
  let rejected = 0;

  const refill = (): void => {
    const now = Date.now();
    const elapsedMs = now - lastRefillAt;
    if (elapsedMs > 0) {
      tokens = Math.min(capacity, tokens + (elapsedMs / 1000) * refillPerSecond);
      lastRefillAt = now;
    }
  };

  const assertCost = (cost: number): void => {
    if (!Number.isFinite(cost) || cost <= 0 || cost > capacity) {
      throw new CloudflareAdapterError(
        "invalid_request",
        "rate budget cost must be a positive number no greater than capacity",
        { cost, capacity },
      );
    }
  };

  return {
    async acquire(cost = 1, acquireOptions) {
      assertCost(cost);
      refill();
      if (tokens >= cost) {
        tokens -= cost;
        acquired += 1;
        return;
      }
      const requiredWaitMs = ((cost - tokens) / refillPerSecond) * 1000;
      const maxWaitMs = acquireOptions?.maxWaitMs ?? defaultMaxWaitMs;
      if (requiredWaitMs > maxWaitMs) {
        rejected += 1;
        logger?.warn?.(
          { requiredWaitMs: Math.ceil(requiredWaitMs), maxWaitMs },
          "Cloudflare rate budget exhausted; rejecting acquisition",
        );
        throw new CloudflareAdapterError(
          "rate_limited",
          "local Cloudflare rate budget exhausted",
          {
            source: "local_rate_budget",
            requiredWaitMs: Math.ceil(requiredWaitMs),
            maxWaitMs,
          },
        );
      }
      tokens -= cost;
      pending += 1;
      try {
        await sleep(requiredWaitMs);
      } finally {
        pending -= 1;
      }
      acquired += 1;
    },

    tryAcquire(cost = 1) {
      assertCost(cost);
      refill();
      if (tokens >= cost) {
        tokens -= cost;
        acquired += 1;
        return true;
      }
      return false;
    },

    stats() {
      refill();
      return {
        capacity,
        refillPerSecond,
        available: Math.max(0, tokens),
        pending,
        acquired,
        rejected,
      };
    },
  };
}
