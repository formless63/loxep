/**
 * Resolved runtime settings for the worker (loxep-62y.2.3).
 *
 * The typed definitions live in `@loxep/domain`'s `settings-defaults.ts` so
 * the `/settings` surface and the worker share one registry (see that module
 * for why). This module is the WORKER'S READER: it turns the registered
 * cadence/cap/rate-budget settings into one small resolved value the
 * composition root and the poll executors can consume, and it caches that
 * value briefly.
 *
 * ## Why a cache, and why a short one
 *
 * Every poll wants the observation caps, and every adapter build wants the
 * rate budget. One `application_settings` read per registered key per poll
 * would be a handful of pointless round trips, so the value is memoized for
 * {@link DEFAULT_SETTINGS_TTL_MS}. The TTL is deliberately short and the
 * cache deliberately dumb: an operator changing a cadence setting expects it
 * to take effect in seconds without restarting the worker, and no correctness
 * rule depends on the value being fresh to the millisecond. Tests pass
 * `ttlMs: 0` to read through on every call.
 *
 * A stored value that no longer matches its registered schema throws
 * (`SettingValidationError`) rather than being silently replaced by the
 * default: a poll running on a cap the operator did not configure is worse
 * than a poll that fails loudly.
 *
 * ## DEVIATION: `integration.woo.rate_budget` is defined HERE, not in @loxep/domain
 *
 * {@link wooRateBudgetSetting} is declared in this module rather than beside
 * its three siblings in `@loxep/domain`'s `settings-defaults.ts`, purely
 * because `packages/domain` was outside the implementing change's write
 * fence. That placement has one real consequence and it is worth stating
 * plainly: the module-level settings registry only shows what the RUNNING
 * PROCESS has imported, and `apps/web` deliberately never imports
 * `@loxep/app` (ADR-0013/ADR-0018), so this key is invisible to the
 * `/settings` surface until the definition moves. The worker reads and
 * honours it either way, and the default is the documented one, so nothing
 * misbehaves — an operator simply cannot yet change it from the UI.
 *
 * Moving the definition into `settings-defaults.ts` (and deleting it here) is
 * the whole fix; it is filed as a follow-up bead. Do NOT declare the same key
 * in both places — `defineSetting` throws on a duplicate key, which in a
 * worker process that imports both would be an import-time crash.
 */
import type { LoxepDb } from "@loxep/db";
import {
  createSettingsService,
  defineSetting,
  ebayRateBudgetSetting,
  monitorDefaultsSetting,
  monitorObservationCapsSetting,
} from "@loxep/domain";
import type { SettingsService } from "@loxep/domain";
import { z } from "zod";
import {
  WOO_RATE_BUDGET_CAPACITY,
  WOO_RATE_BUDGET_REFILL_PER_SECOND,
} from "./woo.ts";

/**
 * The per-connection WooCommerce token bucket (`capacity`,
 * `refillPerSecond`), the Woo sibling of `integration.ebay.rate_budget`.
 *
 * As with eBay, `refillPerSecond` also derives the per-connection adaptive
 * INTERVAL FLOOR (`wooRateBudgetIntervalFloorSeconds`), so tightening the
 * budget slows every order sync on the connection — a rate budget is a safety
 * constraint, not a preference. The defaults are deliberately gentler than
 * eBay's: the other end is a self-hosted WordPress install, not a marketplace
 * API built to be polled.
 */
export const wooRateBudgetSetting = defineSetting({
  key: "integration.woo.rate_budget",
  schema: z.strictObject({
    /** Burst size, in provider calls. */
    capacity: z.number().int().min(1).max(1000),
    /** Sustained provider calls per second. */
    refillPerSecond: z.number().positive().max(100),
  }),
  description:
    "Per-connection WooCommerce rate budget (token-bucket capacity and " +
    "refill per second); the refill rate also derives the adaptive interval " +
    "floor for that store's order sync",
  schemaVersion: 1,
  defaultValue: {
    capacity: WOO_RATE_BUDGET_CAPACITY,
    refillPerSecond: WOO_RATE_BUDGET_REFILL_PER_SECOND,
  },
});

/** How long a resolved settings snapshot is reused (see the module doc). */
export const DEFAULT_SETTINGS_TTL_MS = 15_000;

/** The resolved shape the worker consumes. */
export interface ResolvedMonitorSettings {
  /** Baseline cadence a new monitor target inherits, in seconds. */
  defaultIntervalSeconds: number;
  /** Watchlist member snapshots per poll (one provider call each). */
  watchlistItemsPerPoll: number;
  /** Search/seller summaries observed per discovery poll. */
  searchItemsPerPoll: number;
  /** Per-connection eBay token bucket. */
  ebayRateBudget: { capacity: number; refillPerSecond: number };
  /** Per-connection WooCommerce token bucket. */
  wooRateBudget: { capacity: number; refillPerSecond: number };
}

export interface MonitorSettingsReader {
  /** The current resolved settings (cached for the configured TTL). */
  read: () => Promise<ResolvedMonitorSettings>;
  /** Drop the cached snapshot; the next `read()` hits the database. */
  invalidate: () => void;
  /** The underlying registry-backed service (writes, `/settings` listing). */
  service: SettingsService;
}

export interface CreateMonitorSettingsReaderOptions {
  db: LoxepDb;
  /** Cache lifetime in ms; `0` disables caching (default 15 000). */
  ttlMs?: number;
  /** Reuse an existing settings service instead of creating one. */
  service?: SettingsService;
}

export function createMonitorSettingsReader(
  options: CreateMonitorSettingsReaderOptions,
): MonitorSettingsReader {
  const service = options.service ?? createSettingsService({ db: options.db });
  const ttlMs = options.ttlMs ?? DEFAULT_SETTINGS_TTL_MS;

  let cached: { value: ResolvedMonitorSettings; expiresAtMs: number } | null =
    null;
  // One in-flight read: a burst of concurrent polls must not each query.
  let pending: Promise<ResolvedMonitorSettings> | null = null;

  async function load(): Promise<ResolvedMonitorSettings> {
    const [defaults, caps, rateBudget, wooBudget] = await Promise.all([
      service.get(monitorDefaultsSetting),
      service.get(monitorObservationCapsSetting),
      service.get(ebayRateBudgetSetting),
      service.get(wooRateBudgetSetting),
    ]);
    return {
      defaultIntervalSeconds: defaults.intervalSeconds,
      watchlistItemsPerPoll: caps.watchlistItemsPerPoll,
      searchItemsPerPoll: caps.searchItemsPerPoll,
      ebayRateBudget: rateBudget,
      wooRateBudget: wooBudget,
    };
  }

  async function read(): Promise<ResolvedMonitorSettings> {
    if (cached !== null && Date.now() < cached.expiresAtMs) {
      return cached.value;
    }
    if (pending !== null) return pending;
    pending = load()
      .then((value) => {
        if (ttlMs > 0) {
          cached = { value, expiresAtMs: Date.now() + ttlMs };
        }
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return {
    read,
    invalidate: () => {
      cached = null;
    },
    service,
  };
}
