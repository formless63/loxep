/**
 * Per-connection API rate budget for the Beszel boundary: a token bucket every
 * request must acquire from before touching the network.
 *
 * This is deliberately a LOCAL copy of the eBay/WooCommerce/Cloudflare/
 * Purelymail budget shape rather than an import. Integration packages must not
 * depend on each other (ADR-0009 boundaries are per provider), and the
 * alternative — a shared `@loxep/integration-core` — would couple every
 * provider's release to one package. The type surface is intentionally
 * identical so a caller can hold several behind one structural interface.
 *
 * Semantics are identical to the siblings: the bucket starts full and refills
 * continuously; `acquire(cost)` waits for refill, approximately FIFO; a
 * required wait longer than `maxWaitMs` (default 30s) throws `rate_limited`
 * with `detail.source = "local_rate_budget"` and consumes nothing.
 *
 * ## What Beszel publishes about rate limits, verified 2026-08-13
 *
 * **Nothing.** Beszel's REST guide (https://beszel.dev/guide/rest-api) documents
 * no request limit, no throttling header, and no 429. What it does establish is
 * that the hub *"is built on PocketBase"*, and PocketBase ships a configurable
 * rate limiter that an operator may have set to anything or left off entirely.
 *
 * So the ceiling is unknown *and operator-controlled*, which argues for a small
 * default from a different direction than Purelymail's: the number Loxep picks
 * is not a guess at the provider's limit but a promise about Loxep's own
 * politeness toward a machine the operator is also using interactively. A
 * status poll is a handful of calls per cycle — one login when the token has
 * expired, then one or two list pages — so
 * {@link BESZEL_SUGGESTED_REFILL_PER_SECOND} encodes two requests per second
 * sustained with a burst of eight, which covers a full fleet read without ever
 * being the reason a dashboard feels slow.
 *
 * If a 429 ever appears, the adapter surfaces it as `rate_limited` with
 * `detail.source = "provider"` rather than mutating this bucket from a header
 * describing a limit it does not own.
 *
 * LIMITATION (documented on purpose): this budget is in-memory and
 * per-process, matching the single-worker default. If multiple workers ever
 * drive the same Beszel hub, the budget must move to shared state or the
 * per-process budgets must be divided.
 */
import { BeszelAdapterError } from "./errors.ts";

export interface BeszelAdapterLogger {
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
  logger?: BeszelAdapterLogger;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

/** See the module doc for why "no documented limit" argues for a small number. */
export const BESZEL_SUGGESTED_CAPACITY = 8;
export const BESZEL_SUGGESTED_REFILL_PER_SECOND = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateBudget(options: CreateRateBudgetOptions): RateBudget {
  const { capacity, refillPerSecond, logger } = options;
  const defaultMaxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new BeszelAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new BeszelAdapterError(
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
      throw new BeszelAdapterError(
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
          "Beszel rate budget exhausted; rejecting acquisition",
        );
        throw new BeszelAdapterError(
          "rate_limited",
          "local Beszel rate budget exhausted",
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
