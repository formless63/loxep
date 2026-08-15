/**
 * Per-connection API rate budget for the Pangolin boundary: a token bucket
 * every request must acquire from before touching the network. A LOCAL copy
 * of the shape every sibling integration package carries (see Beszel's
 * `rate-budget.ts` for the full rationale); it is not imported across
 * packages (ADR-0009). Registered as the `integration.pangolin.rate_budget`
 * setting so an operator can raise the numbers without a restart.
 *
 * ## What Pangolin publishes about rate limits, verified 2026-08-15
 *
 * **Nothing, and verified absent in source.**
 * `fosrl/pangolin@main`'s `server/integrationApiServer.ts` installs no
 * `express-rate-limit` (or any) rate-limit middleware on the standalone
 * Integration API server — unlike the dashboard's own API server, which
 * does (`express-rate-limit`, defaults of 500 requests/minute, per the
 * design document's own citation), on a *different port* entirely. The
 * design's own conclusion applies directly, restated from
 * `@loxep/integration-purelymail`'s identical situation: *"the absence of a
 * published limit is an argument for a smaller default, not a larger
 * one."* {@link PANGOLIN_SUGGESTED_CAPACITY} /
 * {@link PANGOLIN_SUGGESTED_REFILL_PER_SECOND} adopt Purelymail's own
 * numbers, per the design document's explicit recommendation.
 *
 * If a 429 ever appears, the adapter surfaces it as `rate_limited` with
 * `detail.source = "provider"` rather than mutating this bucket from a
 * header describing a limit it does not own.
 *
 * LIMITATION (documented on purpose): in-memory and per-process, matching
 * the single-worker default.
 */
import { PangolinAdapterError } from "./errors.ts";

export interface PangolinAdapterLogger {
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
  logger?: PangolinAdapterLogger;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

/** Matches `@loxep/integration-purelymail`'s equally-undocumented ceiling. */
export const PANGOLIN_SUGGESTED_CAPACITY = 6;
export const PANGOLIN_SUGGESTED_REFILL_PER_SECOND = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateBudget(options: CreateRateBudgetOptions): RateBudget {
  const { capacity, refillPerSecond, logger } = options;
  const defaultMaxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new PangolinAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new PangolinAdapterError(
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
      throw new PangolinAdapterError(
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
          "Pangolin rate budget exhausted; rejecting acquisition",
        );
        throw new PangolinAdapterError(
          "rate_limited",
          "local Pangolin rate budget exhausted",
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
