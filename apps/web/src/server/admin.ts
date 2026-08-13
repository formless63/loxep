/**
 * Server-side singletons and role guards for the /settings workspace.
 *
 * Built lazily on first use from bootstrap configuration (ADR-0016) +
 * `createDb` + the domain/storage service factories. Stored in a
 * process-global registry keyed by `Symbol.for()` — the same pattern as
 * `@/server/auth` — because the vite dev server and the production Nitro
 * bundle can each carry their own copy of this module inside one Node
 * process; `globalThis` is the one namespace both copies share.
 *
 * Role model (ADR-0017): reads of ordinary product data are member-accessible
 * (`requireSession`); mutations and user listing are admin-only
 * (`requireAdmin`). Secret/credential material never leaves the services —
 * every surface built on this module returns metadata only.
 *
 * This module is server-only. Server-function handlers reach it via dynamic
 * import so nothing here leaks into the client bundle.
 */
import { loadBootstrapConfig, BootstrapConfigError, type BootstrapConfig } from '@loxep/config';
import { createDb, type DbHandle } from '@loxep/db';
import {
  createConnectionsService,
  createEconomicEntitiesService,
  createSecretsService,
  createSettingsService,
  type ConnectionsService,
  type EconomicEntitiesService,
  type SecretsService,
  type SettingsService
} from '@loxep/domain';
import {
  createMediaService,
  createStorageBackendsService,
  type MediaService,
  type StorageBackendsService
} from '@loxep/storage';
import type { NotificationService } from '@loxep/notifications';
import type { MonitorService } from '@loxep/market';
import { AuthorizationError, requireRole } from '@loxep/auth';
import { getRequestHeaders, setResponseStatus } from '@tanstack/react-start/server';
import { getAuth } from '@/server/auth';

interface AdminRegistry {
  config: BootstrapConfig;
  handle: DbHandle;
  entities: EconomicEntitiesService;
  connections: ConnectionsService;
  settings: SettingsService;
  /** ADR-0019 encrypted secrets, reused by any admin surface needing them. */
  secrets: SecretsService;
  storageBackendsPromise?: Promise<StorageBackendsService>;
  mediaServicePromise?: Promise<MediaService>;
  notificationsModulePromise?: Promise<typeof import('@loxep/notifications')>;
  notificationsServicePromise?: Promise<NotificationService>;
  marketModulePromise?: Promise<typeof import('@loxep/market')>;
  monitorServicePromise?: Promise<MonitorService>;
}

const REGISTRY_KEY = Symbol.for('loxep.web.admin');

type GlobalWithAdminRegistry = typeof globalThis & { [REGISTRY_KEY]?: AdminRegistry };

function buildRegistry(): AdminRegistry {
  let config: BootstrapConfig;
  try {
    config = loadBootstrapConfig(process.env);
  } catch (error) {
    if (error instanceof BootstrapConfigError) {
      throw new Error(
        'Loxep bootstrap configuration is missing or invalid — the settings surfaces cannot start. ' +
          'For local development copy the repo-root .env.example to a .env with real values ' +
          '(see apps/web/env.example.txt for the required LOXEP_* variables).\n' +
          error.message,
        { cause: error }
      );
    }
    throw error;
  }
  const handle = createDb(config.databaseUrl);
  return {
    config,
    handle,
    entities: createEconomicEntitiesService({ db: handle.db }),
    connections: createConnectionsService({ db: handle.db, keyring: config.keyring }),
    settings: createSettingsService({ db: handle.db }),
    secrets: createSecretsService({ db: handle.db, keyring: config.keyring })
  };
}

/** Lazy process-global domain services for the settings surfaces. */
export function getAdminServices(): AdminRegistry {
  const globalWithRegistry = globalThis as GlobalWithAdminRegistry;
  return (globalWithRegistry[REGISTRY_KEY] ??= buildRegistry());
}

/**
 * Storage-backends service, cached on the registry.
 *
 * `@loxep/storage`'s default entry (`.`) only reaches the driver/backends/
 * media surface now — the Graphile Worker-backed migration workflow (which
 * pulls `@loxep/jobs` and its cosmiconfig/TypeScript CJS chain) lives behind
 * the separate `@loxep/storage/migration` subpath, so a plain static import
 * here no longer risks the SSR-bundling hazard documented on
 * `getNotificationsModule` below.
 */
export function getStorageBackendsService(): Promise<StorageBackendsService> {
  const registry = getAdminServices();
  registry.storageBackendsPromise ??= Promise.resolve(
    createStorageBackendsService({
      db: registry.handle.db,
      keyring: registry.config.keyring
    })
  );
  return registry.storageBackendsPromise;
}

/**
 * Media service (uploads/serves avatars and other Loxep-stored objects
 * through the configured default storage backend), cached on the registry.
 * Same no-jobs-hazard reasoning as {@link getStorageBackendsService}.
 */
export function getMediaService(): Promise<MediaService> {
  const registry = getAdminServices();
  registry.mediaServicePromise ??= (async () => {
    const backends = await getStorageBackendsService();
    return createMediaService({ db: registry.handle.db, backends });
  })();
  return registry.mediaServicePromise;
}

/**
 * Dynamically-loaded `@loxep/notifications` module, cached on the registry.
 *
 * `@loxep/notifications`'s index re-exports the delivery pipeline, which
 * reaches `graphile-worker` (via `@loxep/jobs`) and its cosmiconfig/
 * TypeScript CJS chain — bundling that into the SSR server-function graph
 * breaks at runtime (`__filename` in ESM). The `@vite-ignore` variable
 * specifier keeps it out of the bundle so Node resolves it from real
 * node_modules, mirroring `@loxep/runtime`'s dynamic-import treatment of
 * `@loxep/jobs`.
 */
export function getNotificationsModule(): Promise<typeof import('@loxep/notifications')> {
  const registry = getAdminServices();
  registry.notificationsModulePromise ??= (async () => {
    const specifier = '@loxep/notifications';
    return (await import(/* @vite-ignore */ specifier)) as typeof import('@loxep/notifications');
  })();
  return registry.notificationsModulePromise;
}

/** Notification endpoints/rules service, loaded through the module above. */
export function getNotificationsService(): Promise<NotificationService> {
  const registry = getAdminServices();
  registry.notificationsServicePromise ??= (async () => {
    const notifications = await getNotificationsModule();
    return notifications.createNotificationService({
      db: registry.handle.db,
      secrets: registry.secrets
    });
  })();
  return registry.notificationsServicePromise;
}

/**
 * Dynamically-loaded `@loxep/market` module, cached on the registry.
 *
 * `@loxep/market`'s index re-exports `tasks.ts`, which reaches
 * `graphile-worker` (via `@loxep/jobs`) the same way `@loxep/notifications`
 * does — see `getNotificationsModule`'s doc above. The `@vite-ignore`
 * variable specifier keeps it out of the SSR bundle so Node resolves it
 * from real node_modules.
 */
export function getMarketModule(): Promise<typeof import('@loxep/market')> {
  const registry = getAdminServices();
  registry.marketModulePromise ??= (async () => {
    const specifier = '@loxep/market';
    return (await import(/* @vite-ignore */ specifier)) as typeof import('@loxep/market');
  })();
  return registry.marketModulePromise;
}

/** Monitor-target scheduling service (`/market/monitors`), loaded through the module above. */
export function getMonitorService(): Promise<MonitorService> {
  const registry = getAdminServices();
  registry.monitorServicePromise ??= (async () => {
    const market = await getMarketModule();
    return market.createMonitorService({ db: registry.handle.db });
  })();
  return registry.monitorServicePromise;
}

/** Current request's Better Auth session, or `null` when unauthenticated. */
export async function getSession() {
  return getAuth().api.getSession({ headers: getRequestHeaders() });
}

export type AdminSession = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/**
 * Member gate for reads of ordinary product data (ADR-0017): any
 * authenticated user. Responds 401 when unauthenticated.
 */
export async function requireSession(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) {
    setResponseStatus(401);
    throw new AuthorizationError('Authentication required', 401);
  }
  return session;
}

/**
 * Admin gate for mutations and user listing (ADR-0017). Responds 401 when
 * unauthenticated, 403 when authenticated without the `admin` role.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await getSession();
  try {
    return requireRole(session, 'admin');
  } catch (error) {
    if (error instanceof AuthorizationError) {
      setResponseStatus(error.statusCode);
    }
    throw error;
  }
}
