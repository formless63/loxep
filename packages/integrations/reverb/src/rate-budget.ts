/**
 * API rate budget (loxep-g4t.3): a token bucket every Reverb API call must
 * acquire from before hitting the network.
 *
 * ## THIS BUDGET IS PER CONNECTION — the eBay/WooCommerce pattern, NOT
 * Etsy's shared-per-application one
 *
 * Per the binding design (`reverb-integration-design.md`, "Rate limits" and
 * "Budget-scoping choice"): Reverb documents no numeric QPS/daily limit at
 * all — only that a large request volume "may issue a Rate Limit response...
 * HTTP status code of 429" (source:
 * https://www.reverb-api.com/docs/rate-limiting-and-terms-of-service,
 * fetched 2026-08-13). Unlike Etsy, Reverb has no shared installation-wide
 * credential: every connection's Personal Access Token is minted
 * independently from a DIFFERENT Reverb account's own settings, so two
 * Loxep connections draw against two unrelated Reverb-side quotas. There is
 * therefore nothing to pool them onto — `packages/app/src/reverb.ts` builds
 * ONE `RateBudget` PER CONNECTION (a `Map<connectionId, RateBudget>`),
 * exactly like `woo.ts`/`ebay.ts`, never a single shared instance the way
 * `etsy.ts` deliberately is.
 *
 * This module only implements the token-bucket ALGORITHM — identical to
 * `@loxep/integration-ebay`/`-etsy`/`-woo`'s (duplicated, not imported;
 * integration packages must not depend on each other, ADR-0009).
 *
 * Semantics (identical to every sibling adapter's bucket):
 * - The bucket starts full (`capacity` tokens) and refills continuously at
 *   `refillPerSecond`, capped at `capacity`.
 * - `acquire(cost)` resolves immediately when tokens are available;
 *   otherwise it reserves the deficit (tokens go negative) and waits for the
 *   refill to cover it. Reservation order is call order, so concurrent
 *   waiters resolve approximately FIFO.
 * - When the required wait would exceed `maxWaitMs` (default 30s,
 *   overridable per call), `acquire` throws a `ReverbAdapterError` of kind
 *   `rate_limited` with `detail.source = "local_rate_budget"` and consumes
 *   nothing.
 * - `tryAcquire(cost)` never waits; `stats()` exposes remaining budget for
 *   integration-health surfaces.
 *
 * DEFAULTS ARE A DOCUMENTED GUESS, not a verified Reverb number — see
 * `packages/app/src/reverb.ts`'s module doc. Revisit once real 429 behavior
 * has been observed against a live account.
 *
 * LIMITATION (documented on purpose, same as every sibling): this budget is
 * in-memory and per-process. That matches the Phase 1 single-worker default
 * (`LOXEP_MODE=worker`, one process polls providers). If multiple workers
 * ever poll Reverb concurrently, the budget must move to shared state or be
 * divided across processes — revisit before enabling multi-worker polling.
 */
import { ReverbAdapterError } from "./errors.ts";

export interface ReverbAdapterLogger {
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
  logger?: ReverbAdapterLogger;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateBudget(
  options: CreateRateBudgetOptions,
): RateBudget {
  const { capacity, refillPerSecond, logger } = options;
  const defaultMaxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new ReverbAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new ReverbAdapterError(
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
      throw new ReverbAdapterError(
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
          "Reverb rate budget exhausted; rejecting acquisition",
        );
        throw new ReverbAdapterError(
          "rate_limited",
          "local Reverb rate budget exhausted",
          {
            source: "local_rate_budget",
            requiredWaitMs: Math.ceil(requiredWaitMs),
            maxWaitMs,
          },
        );
      }
      // Reserve now (FIFO by call order), then wait for refill to cover it.
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
