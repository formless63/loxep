/**
 * Per-connection API rate budget for the Termix boundary: a token bucket
 * every request must acquire from before touching the network. A LOCAL copy
 * of the shape every sibling integration package carries (ADR-0009) — not
 * imported across packages.
 *
 * ## What Termix publishes about rate limits, verified 2026-08-13
 *
 * `openapi.json` documents a `429 "Too many login attempts."` response on
 * `POST /users/login` specifically — evidence of a login-attempt limiter —
 * but no numeric threshold, and no rate limit at all on the read paths this
 * adapter otherwise uses. {@link TERMIX_SUGGESTED_CAPACITY} /
 * {@link TERMIX_SUGGESTED_REFILL_PER_SECOND} are therefore a politeness
 * budget, matching Beszel's and Dockhand's identical reasoning for an
 * undocumented ceiling: a poll cycle is at most one login, one token fetch,
 * then a couple of reads, so two requests per second sustained with a burst
 * of eight is generous headroom.
 *
 * A 429 is still surfaced as `rate_limited` with `detail.source =
 * "provider"` rather than mutating this bucket from a header describing a
 * limit it does not own.
 *
 * LIMITATION (documented on purpose): in-memory and per-process, matching
 * the single-worker default.
 */
import { TermixAdapterError } from "./errors.ts";

export interface TermixAdapterLogger {
  debug?: (fields: Record<string, unknown>, message?: string) => void;
  info?: (fields: Record<string, unknown>, message?: string) => void;
  warn?: (fields: Record<string, unknown>, message?: string) => void;
  error?: (fields: Record<string, unknown>, message?: string) => void;
}

export interface RateBudgetStats {
  capacity: number;
  refillPerSecond: number;
  available: number;
  pending: number;
  acquired: number;
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
  maxWaitMs?: number;
  logger?: TermixAdapterLogger;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

export const TERMIX_SUGGESTED_CAPACITY = 8;
export const TERMIX_SUGGESTED_REFILL_PER_SECOND = 2;

/**
 * The login endpoint's own documented limiter argues for spending fewer of
 * this budget's tokens per login than an ordinary read — mirroring
 * Dockhand's `DOCKHAND_LOGIN_COST` for the same reason (its account-lockout
 * risk is smaller here, since Termix documents no lockout duration, but the
 * caution costs nothing).
 */
export const TERMIX_LOGIN_COST = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateBudget(options: CreateRateBudgetOptions): RateBudget {
  const { capacity, refillPerSecond, logger } = options;
  const defaultMaxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new TermixAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new TermixAdapterError(
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
      throw new TermixAdapterError(
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
          "Termix rate budget exhausted; rejecting acquisition",
        );
        throw new TermixAdapterError(
          "rate_limited",
          "local Termix rate budget exhausted",
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
