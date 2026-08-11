/**
 * `buildAppServices` — the composition root's service graph.
 *
 * One database handle, one keyring, the ADR-0016/ADR-0019 domain services,
 * the resolved application settings reader, and the connection-scoped eBay
 * adapter factory. Nothing here is a singleton by module side effect: the
 * caller owns the lifetime and closes the handle when the process shuts down.
 *
 * The settings reader is wired INTO the adapter factory (`resolveRateBudget`)
 * rather than read once at construction, so `integration.ebay.rate_budget`
 * stays operator-editable at runtime — see `settings.ts` and `ebay.ts`.
 *
 * This package is what turns the Phase 1 parts into a running pipeline;
 * `apps/web` never imports it (the web mode must not pull graphile-worker or
 * the provider integrations into the request process).
 */
import { closeDb, createDb } from "@loxep/db";
import type { DbHandle, LoxepDb } from "@loxep/db";
import type { BootstrapConfig } from "@loxep/config";
import {
  createConnectionCredentialsService,
  createConnectionsService,
  createSecretsService,
} from "@loxep/domain";
import type {
  ConnectionCredentialsService,
  ConnectionsService,
  SecretsService,
  SettingsService,
} from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import { createEbayAdapterFactory } from "./ebay.ts";
import type { EbayAdapterFactory } from "./ebay.ts";
import { createMonitorSettingsReader } from "./settings.ts";
import type { MonitorSettingsReader } from "./settings.ts";

export interface BuildAppServicesOptions {
  config: BootstrapConfig;
  /** Structural logger; provider/adapter diagnostics are logged through it. */
  logger?: JobsLogger;
  /**
   * Override the per-connection eBay token bucket. Production reads the
   * registered `integration.ebay.rate_budget` setting (falling back to the
   * documented defaults in `ebay.ts`); an explicit value here WINS over the
   * setting, which is how tests get a wide-open budget without spending
   * wall-clock time waiting on refills.
   */
  ebayRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Cache lifetime for resolved application settings, in ms (default 15 000;
   * `0` reads through on every access — used by tests that flip a setting and
   * expect the very next poll to see it).
   */
  settingsCacheTtlMs?: number;
}

export interface AppServices {
  config: BootstrapConfig;
  handle: DbHandle;
  db: LoxepDb;
  secrets: SecretsService;
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  /** Typed application settings (ADR-0016) — the registry-backed service. */
  settings: SettingsService;
  /**
   * Resolved monitor defaults (cadence baseline, observation caps, eBay rate
   * budget) read from the registered settings. Executors call `read()` per
   * poll; the reader caches briefly, so an operator's change lands within
   * seconds without a restart.
   */
  monitorSettings: MonitorSettingsReader;
  /** Connection-scoped eBay adapter (keyset + budget + refreshed user token). */
  getEbayAdapterForConnection: EbayAdapterFactory;
  /** Drop a cached adapter (after an `auth`-class provider failure). */
  invalidateEbayAdapter: (connectionId: string) => void;
  /**
   * The interval floor implied by the DEFAULT (or explicitly overridden)
   * budget. The authoritative per-connection value is
   * `adapter.minIntervalSeconds`, which follows the stored setting.
   */
  ebayIntervalFloorSeconds: number;
  /** Release the database pool. Idempotent. */
  close: () => Promise<void>;
}

export function buildAppServices(
  options: BuildAppServicesOptions,
): AppServices {
  const { config, logger } = options;
  const handle = createDb(config.databaseUrl);
  const db = handle.db;

  const secrets = createSecretsService({ db, keyring: config.keyring });
  const connections = createConnectionsService({
    db,
    keyring: config.keyring,
  });
  const connectionCredentials = createConnectionCredentialsService({
    db,
    keyring: config.keyring,
  });

  const monitorSettings = createMonitorSettingsReader({
    db,
    ...(options.settingsCacheTtlMs !== undefined
      ? { ttlMs: options.settingsCacheTtlMs }
      : {}),
  });

  const ebay = createEbayAdapterFactory({
    db,
    secrets,
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.ebayRateBudget !== undefined
      ? { rateBudget: options.ebayRateBudget }
      : {}),
    resolveRateBudget: async () =>
      (await monitorSettings.read()).ebayRateBudget,
  });

  let closed = false;
  return {
    config,
    handle,
    db,
    secrets,
    connections,
    connectionCredentials,
    settings: monitorSettings.service,
    monitorSettings,
    getEbayAdapterForConnection: ebay.getAdapterForConnection,
    invalidateEbayAdapter: ebay.invalidate,
    ebayIntervalFloorSeconds: ebay.intervalFloorSeconds,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeDb(handle);
    },
  };
}
