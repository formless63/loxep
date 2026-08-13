/**
 * Per-connection API rate budget for the Tailscale boundary: a token bucket
 * every request must acquire from before touching the network. A LOCAL copy
 * of the shape every sibling integration package carries — see Beszel's
 * `rate-budget.ts` for the full rationale; it is not imported across
 * packages (ADR-0009).
 *
 * ## What Tailscale publishes about rate limits, verified 2026-08-13
 *
 * **Nothing.** No documented numeric limit, no documented header, and an
 * open upstream feature request asking for one to be published
 * (github.com/tailscale/tailscale#14328, "FR: Question regarding Tailscale
 * API quotas and limits. Do you have any, and if so, what are they?").
 * {@link TAILSCALE_SUGGESTED_CAPACITY} /
 * {@link TAILSCALE_SUGGESTED_REFILL_PER_SECOND} are therefore a politeness
 * budget Loxep imposes on itself, not a measured ceiling: a poll cycle is a
 * handful of calls (at most one OAuth token exchange, then one devices
 * list), so two requests per second sustained with a burst of eight is
 * generous headroom, matching Beszel's identical reasoning for an
 * equally-undocumented ceiling.
 *
 * If a 429 ever appears, the adapter surfaces it as `rate_limited` with
 * `detail.source = "provider"` rather than mutating this bucket from a
 * header describing a limit it does not own.
 *
 * LIMITATION (documented on purpose): in-memory and per-process, matching
 * the single-worker default.
 */
import { TailscaleAdapterError } from "./errors.ts";

export interface TailscaleAdapterLogger {
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
  logger?: TailscaleAdapterLogger;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

export const TAILSCALE_SUGGESTED_CAPACITY = 8;
export const TAILSCALE_SUGGESTED_REFILL_PER_SECOND = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateBudget(options: CreateRateBudgetOptions): RateBudget {
  const { capacity, refillPerSecond, logger } = options;
  const defaultMaxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new TailscaleAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new TailscaleAdapterError(
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
      throw new TailscaleAdapterError(
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
          "Tailscale rate budget exhausted; rejecting acquisition",
        );
        throw new TailscaleAdapterError(
          "rate_limited",
          "local Tailscale rate budget exhausted",
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
