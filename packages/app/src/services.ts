/**
 * `buildAppServices` — the composition root's service graph.
 *
 * One database handle, one keyring, the ADR-0016/ADR-0019 domain services,
 * and the connection-scoped eBay adapter factory. Nothing here is a
 * singleton by module side effect: the caller owns the lifetime and closes
 * the handle when the process shuts down.
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
} from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import { createEbayAdapterFactory } from "./ebay.ts";
import type { EbayAdapterFactory } from "./ebay.ts";

export interface BuildAppServicesOptions {
  config: BootstrapConfig;
  /** Structural logger; provider/adapter diagnostics are logged through it. */
  logger?: JobsLogger;
  /**
   * Override the per-connection eBay token bucket. Production uses the
   * documented defaults in `ebay.ts`; tests use a wide-open budget so they do
   * not spend wall-clock time waiting on refills.
   */
  ebayRateBudget?: { capacity: number; refillPerSecond: number };
}

export interface AppServices {
  config: BootstrapConfig;
  handle: DbHandle;
  db: LoxepDb;
  secrets: SecretsService;
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  /** Connection-scoped eBay adapter (keyset + budget + refreshed user token). */
  getEbayAdapterForConnection: EbayAdapterFactory;
  /** Drop a cached adapter (after an `auth`-class provider failure). */
  invalidateEbayAdapter: (connectionId: string) => void;
  /** Per-connection rate-budget interval floor, in whole seconds. */
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

  const ebay = createEbayAdapterFactory({
    db,
    secrets,
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.ebayRateBudget !== undefined
      ? { rateBudget: options.ebayRateBudget }
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
