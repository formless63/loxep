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
import {
  createBooksService,
  createExpenseReports,
  createExpensesService,
  createFiscalPeriodsService,
  createLedgerReports,
  createReceiptsService,
  type BooksService,
  type ExpenseReports,
  type ExpensesService,
  type FiscalPeriodsService,
  type LedgerReports,
  type ReceiptsService
} from '@loxep/accounting';
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
import type {
  AcquisitionsService,
  ItemsService,
  LocationsService,
  MovementsService,
  OpportunityLinksService
} from '@loxep/inventory';
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
  /** `/finance` (loxep-dgf.1): expenses lifecycle and the expense read models. Depends only on `db`, so it is built eagerly like the other domain services above. */
  expenses: ExpensesService;
  expenseReports: ExpenseReports;
  /**
   * `/finance/books` (loxep-cmo): accounting books, the effective-dated
   * entity-to-book link and its roll-up rule, fiscal-period generation/close/
   * reopen, and the trial-balance read model. All three depend only on `db`
   * (verified against `@loxep/accounting`'s own `package.json`, same
   * reasoning as `expenses` above), so they are built eagerly too.
   */
  books: BooksService;
  fiscalPeriods: FiscalPeriodsService;
  ledgerReports: LedgerReports;
  storageBackendsPromise?: Promise<StorageBackendsService>;
  mediaServicePromise?: Promise<MediaService>;
  /** Receipt attach/list/detach (loxep-dgf.1) — depends on `getMediaService()`, so it is built lazily like it. */
  receiptsServicePromise?: Promise<ReceiptsService>;
  notificationsModulePromise?: Promise<typeof import('@loxep/notifications')>;
  notificationsServicePromise?: Promise<NotificationService>;
  marketModulePromise?: Promise<typeof import('@loxep/market')>;
  monitorServicePromise?: Promise<MonitorService>;
  /**
   * `/inventory` (loxep-dgf.2). `@loxep/inventory/decimal.ts` imports from
   * bare `@loxep/commerce`, whose index re-exports `tasks.ts`/`retention.ts`
   * and so reaches `graphile-worker` (via `@loxep/jobs`) the same way
   * `@loxep/market`/`@loxep/notifications` do — same `@vite-ignore` dynamic
   * module treatment as {@link getMarketModule}, not the eager pattern
   * `expenses`/`books` above use (those depend only on `db`).
   */
  inventoryModulePromise?: Promise<typeof import('@loxep/inventory')>;
  itemsServicePromise?: Promise<ItemsService>;
  acquisitionsServicePromise?: Promise<AcquisitionsService>;
  locationsServicePromise?: Promise<LocationsService>;
  movementsServicePromise?: Promise<MovementsService>;
  opportunityLinksServicePromise?: Promise<OpportunityLinksService>;
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
    secrets: createSecretsService({ db: handle.db, keyring: config.keyring }),
    expenses: createExpensesService({ db: handle.db }),
    expenseReports: createExpenseReports({ db: handle.db }),
    books: createBooksService({ db: handle.db }),
    fiscalPeriods: createFiscalPeriodsService({ db: handle.db }),
    ledgerReports: createLedgerReports({ db: handle.db })
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

/** Expense lifecycle service (`/finance/expenses`), loxep-dgf.1. */
export function getExpensesService(): ExpensesService {
  return getAdminServices().expenses;
}

/** The four expense read models (`listExpenses`, `unallocatedExpenses`, …), loxep-dgf.1. */
export function getExpenseReports(): ExpenseReports {
  return getAdminServices().expenseReports;
}

/** Books, entity links, and posting-book routing (`/finance/books`), loxep-cmo. */
export function getBooksService(): BooksService {
  return getAdminServices().books;
}

/** Fiscal-period generation, close, and reopen (`/finance/books`), loxep-cmo. */
export function getFiscalPeriodsService(): FiscalPeriodsService {
  return getAdminServices().fiscalPeriods;
}

/** Trial balance and the other ledger read models (`/finance/books`), loxep-cmo. */
export function getLedgerReports(): LedgerReports {
  return getAdminServices().ledgerReports;
}

/**
 * Receipt attach/list/detach over `media_links` (loxep-dgf.1), cached on the
 * registry. Depends on {@link getMediaService}, so it is built lazily the
 * same way.
 */
export function getReceiptsService(): Promise<ReceiptsService> {
  const registry = getAdminServices();
  registry.receiptsServicePromise ??= (async () => {
    const media = await getMediaService();
    return createReceiptsService({ db: registry.handle.db, media });
  })();
  return registry.receiptsServicePromise;
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

/**
 * Dynamically-loaded `@loxep/inventory` module, cached on the registry.
 *
 * `@loxep/inventory/decimal.ts` imports from bare `@loxep/commerce` (to
 * reuse its money-rounding helpers rather than fork them — see that file's
 * own doc), and `@loxep/commerce`'s index re-exports `tasks.ts`, which
 * reaches `graphile-worker` via `@loxep/jobs`. Same SSR-bundling hazard as
 * `@loxep/market`/`@loxep/notifications` — see `getNotificationsModule`'s
 * doc above. The `@vite-ignore` variable specifier keeps it out of the
 * bundle so Node resolves it from real node_modules.
 */
export function getInventoryModule(): Promise<typeof import('@loxep/inventory')> {
  const registry = getAdminServices();
  registry.inventoryModulePromise ??= (async () => {
    const specifier = '@loxep/inventory';
    return (await import(/* @vite-ignore */ specifier)) as typeof import('@loxep/inventory');
  })();
  return registry.inventoryModulePromise;
}

/** Items service (`/inventory/stock`, intake) — code generation, condition/grading, transfers. */
export function getItemsService(): Promise<ItemsService> {
  const registry = getAdminServices();
  registry.itemsServicePromise ??= (async () => {
    const inventory = await getInventoryModule();
    return inventory.createItemsService({ db: registry.handle.db });
  })();
  return registry.itemsServicePromise;
}

/** Acquisitions service (`/inventory/acquisitions`) — lots, cost components, the allocation engine. */
export function getAcquisitionsService(): Promise<AcquisitionsService> {
  const registry = getAdminServices();
  registry.acquisitionsServicePromise ??= (async () => {
    const inventory = await getInventoryModule();
    return inventory.createAcquisitionsService({ db: registry.handle.db });
  })();
  return registry.acquisitionsServicePromise;
}

/** Locations service (`/inventory/locations`) — the location tree. */
export function getLocationsService(): Promise<LocationsService> {
  const registry = getAdminServices();
  registry.locationsServicePromise ??= (async () => {
    const inventory = await getInventoryModule();
    return inventory.createLocationsService({ db: registry.handle.db });
  })();
  return registry.locationsServicePromise;
}

/** Movements service (`/inventory/movements`) — the append-only ledger and its single writer. */
export function getMovementsService(): Promise<MovementsService> {
  const registry = getAdminServices();
  registry.movementsServicePromise ??= (async () => {
    const inventory = await getInventoryModule();
    return inventory.createMovementsService({ db: registry.handle.db });
  })();
  return registry.movementsServicePromise;
}

/** Opportunity-links service — the `/market` → `/inventory` "I bought this" handoff's write side. */
export function getOpportunityLinksService(): Promise<OpportunityLinksService> {
  const registry = getAdminServices();
  registry.opportunityLinksServicePromise ??= (async () => {
    const inventory = await getInventoryModule();
    return inventory.createOpportunityLinksService({ db: registry.handle.db });
  })();
  return registry.opportunityLinksServicePromise;
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
