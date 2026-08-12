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
 */
import type { LoxepDb } from "@loxep/db";
import {
  createSettingsService,
  ebayRateBudgetSetting,
  monitorDefaultsSetting,
  monitorObservationCapsSetting,
  wooRateBudgetSetting,
} from "@loxep/domain";
import type { SettingsService } from "@loxep/domain";

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
