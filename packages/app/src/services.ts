/**
 * `buildAppServices` — the composition root's service graph.
 *
 * One database handle, one keyring, the ADR-0016/ADR-0019 domain services,
 * the resolved application settings reader, and the connection-scoped
 * provider adapter factories (eBay and WooCommerce). Nothing here is a
 * singleton by module side effect: the caller owns the lifetime and closes
 * the handle when the process shuts down.
 *
 * The settings reader is wired INTO both adapter factories
 * (`resolveRateBudget`) rather than read once at construction, so
 * `integration.ebay.rate_budget` and `integration.woo.rate_budget` stay
 * operator-editable at runtime — see `settings.ts`, `ebay.ts`, and `woo.ts`.
 * The two factories are separate objects on purpose: they resolve different
 * credentials, keep separate per-connection token buckets, and derive
 * different interval floors (30 s politeness for a marketplace API, 300 s for
 * somebody's self-hosted WordPress store).
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
import { createCloudflareAdapterFactory } from "./cloudflare.ts";
import type { CloudflareAdapterFactory } from "./cloudflare.ts";
import { createEbayAdapterFactory } from "./ebay.ts";
import type { EbayAdapterFactory } from "./ebay.ts";
import { createEtsyAdapterFactory } from "./etsy.ts";
import type { EtsyAdapterFactory } from "./etsy.ts";
import { createMonitorSettingsReader } from "./settings.ts";
import type { MonitorSettingsReader } from "./settings.ts";
import { createWooAdapterFactory } from "./woo.ts";
import type { WooAdapterFactory } from "./woo.ts";

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
   * Override the per-connection WooCommerce token bucket. Production reads
   * the registered `integration.woo.rate_budget` setting (falling back to the
   * documented defaults in `woo.ts`); an explicit value here WINS, which is
   * how tests get a wide-open budget without spending wall-clock time waiting
   * on refills.
   */
  wooRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Override the SHARED-PER-APPLICATION Etsy token bucket (see
   * `etsy.ts`'s module doc — this is the one budget the whole installation's
   * Etsy traffic draws from, not a per-connection value the way
   * `ebayRateBudget`/`wooRateBudget` are). An explicit value here WINS; tests
   * use it for a wide-open budget.
   */
  etsyRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Override the per-connection Cloudflare token bucket (Phase 7 milestone 1
   * composition-root wiring, loxep-lmy.1). Production uses `cloudflare.ts`'s
   * documented defaults (no registered-setting resolver is wired yet — a
   * documented follow-up, matching Etsy's own `resolveRateBudget` gap); an
   * explicit value here WINS, which is how tests get a wide-open budget
   * without spending wall-clock time waiting on refills.
   */
  cloudflareRateBudget?: { capacity: number; refillPerSecond: number };
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
  /** Connection-scoped WooCommerce adapter (store URL + key pair + budget). */
  getWooAdapterForConnection: WooAdapterFactory;
  /** Drop a cached Woo adapter (after an `auth`-class provider failure). */
  invalidateWooAdapter: (connectionId: string) => void;
  /** The Woo interval floor implied by the DEFAULT/overridden budget. */
  wooIntervalFloorSeconds: number;
  /**
   * Connection-scoped Etsy adapter — but the underlying `EtsyAdapter` and its
   * `RateBudget` are ONE SHARED INSTANCE for the whole installation, not
   * built per connection (see `etsy.ts`'s module doc; this is the load-
   * bearing divergence from `getEbayAdapterForConnection`/
   * `getWooAdapterForConnection`).
   */
  getEtsyAdapterForConnection: EtsyAdapterFactory;
  /** Drop a cached per-connection Etsy view (after an `auth`-class provider failure). */
  invalidateEtsyAdapter: (connectionId: string) => void;
  /** The interval floor implied by the shared Etsy budget. */
  etsyIntervalFloorSeconds: number;
  /**
   * Connection-scoped Cloudflare adapter (API token + account id + budget) —
   * Phase 7 milestone 1's composition-root wiring (loxep-lmy.1). Per-
   * CONNECTION, like eBay/Woo, not shared-per-installation like Etsy: see
   * `cloudflare.ts`'s module doc for why Cloudflare's real limit does not
   * force that shape the way Etsy's per-application limit does.
   */
  getCloudflareAdapterForConnection: CloudflareAdapterFactory;
  /** Drop a cached Cloudflare adapter (after an `auth`-class provider failure). */
  invalidateCloudflareAdapter: (connectionId: string) => void;
  /** The Cloudflare interval floor implied by the DEFAULT/overridden budget. */
  cloudflareIntervalFloorSeconds: number;
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

  const woo = createWooAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.wooRateBudget !== undefined
      ? { rateBudget: options.wooRateBudget }
      : {}),
    resolveRateBudget: async () => (await monitorSettings.read()).wooRateBudget,
  });

  // SHARED PER APPLICATION — see etsy.ts's module doc. `resolveRateBudget`
  // is intentionally omitted (no registered setting for it yet, unlike
  // eBay/Woo); an explicit `etsyRateBudget` still wins over the compiled-in
  // defaults.
  const etsy = createEtsyAdapterFactory({
    db,
    secrets,
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.etsyRateBudget !== undefined
      ? { rateBudget: options.etsyRateBudget }
      : {}),
  });

  // PER-CONNECTION — see cloudflare.ts's module doc for why Cloudflare's real
  // limit does not force the shared-per-application shape Etsy needs.
  const cloudflare = createCloudflareAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.cloudflareRateBudget !== undefined
      ? { rateBudget: options.cloudflareRateBudget }
      : {}),
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
    getWooAdapterForConnection: woo.getAdapterForConnection,
    invalidateWooAdapter: woo.invalidate,
    wooIntervalFloorSeconds: woo.intervalFloorSeconds,
    getEtsyAdapterForConnection: etsy.getAdapterForConnection,
    invalidateEtsyAdapter: etsy.invalidate,
    etsyIntervalFloorSeconds: etsy.intervalFloorSeconds,
    getCloudflareAdapterForConnection: cloudflare.getAdapterForConnection,
    invalidateCloudflareAdapter: cloudflare.invalidate,
    cloudflareIntervalFloorSeconds: cloudflare.intervalFloorSeconds,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeDb(handle);
    },
  };
}
