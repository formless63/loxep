/**
 * Per-connection API rate budget for the Purelymail boundary: a token bucket
 * every request must acquire from before touching the network.
 *
 * This is deliberately a LOCAL copy of the eBay/WooCommerce/Cloudflare budget
 * shape rather than an import. Integration packages must not depend on each
 * other (ADR-0009 boundaries are per provider), and the alternative — a shared
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
 *   throws a `PurelymailAdapterError` of kind `rate_limited` with
 *   `detail.source = "local_rate_budget"` and consumes nothing;
 * - `tryAcquire(cost)` never waits; `stats()` exposes remaining budget.
 *
 * ## What Purelymail publishes about rate limits, verified 2026-08-13
 *
 * **Nothing about the API.** Neither the OpenAPI document
 * (`news.purelymail.com/api/swagger-spec.js`) nor the documentation index
 * mentions an API request limit, a throttling header, or a 429. The only rate
 * limits Purelymail documents are on *account actions*, in its FAQ: accounts
 * have limits on *"sending email externally"* and similar sensitive operations,
 * trial accounts' limits *"for certain sensitive actions ... are very low"*,
 * and the remedy offered is *"contact support if you need these rate limits
 * adjusted for your account"*.
 *
 * That absence is a reason for a SMALLER default, not a larger one. An
 * undocumented limit is one nobody can design against, the account being spent
 * is the operator's own, and this domain's call volume is inherently tiny —
 * milestone 2's whole workflow is roughly five calls per domain, once, plus one
 * cheap read per bounded poll. {@link PURELYMAIL_SUGGESTED_REFILL_PER_SECOND}
 * encodes that: one request per second sustained, a burst of six.
 *
 * If a 429 ever appears, the adapter surfaces it as `rate_limited` with
 * `detail.source = "provider"` and any `retry-after` header verbatim, rather
 * than mutating this bucket from a header describing a limit it does not own.
 *
 * LIMITATION (documented on purpose): this budget is in-memory and
 * per-process, matching the single-worker default. If multiple workers ever
 * drive the same Purelymail account, the budget must move to shared state or
 * the per-process budgets must be divided.
 */
import { PurelymailAdapterError } from "./errors.ts";

export interface PurelymailAdapterLogger {
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
  logger?: PurelymailAdapterLogger;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

/**
 * The politeness default this adapter recommends, in the absence of any
 * published provider limit. See the module doc for why "no documented limit"
 * argues for a small number rather than a large one.
 */
export const PURELYMAIL_SUGGESTED_CAPACITY = 6;
export const PURELYMAIL_SUGGESTED_REFILL_PER_SECOND = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateBudget(options: CreateRateBudgetOptions): RateBudget {
  const { capacity, refillPerSecond, logger } = options;
  const defaultMaxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new PurelymailAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new PurelymailAdapterError(
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
      throw new PurelymailAdapterError(
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
          "Purelymail rate budget exhausted; rejecting acquisition",
        );
        throw new PurelymailAdapterError(
          "rate_limited",
          "local Purelymail rate budget exhausted",
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
