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
  createExpenseConfirmService,
  createExpenseLinesService,
  createExpenseReports,
  createExpensesService,
  createFiscalPeriodsService,
  createLedgerReports,
  createReceiptsService,
  type BooksService,
  type ExpenseConfirmService,
  type ExpenseLinesService,
  type ExpenseReports,
  type ExpensesService,
  type FiscalPeriodsService,
  type LedgerReports,
  type ReceiptsService
} from '@loxep/accounting';
import { loadBootstrapConfig, BootstrapConfigError, type BootstrapConfig } from '@loxep/config';
import { createDb, type DbHandle } from '@loxep/db';
import {
  createConnectionCredentialsService,
  createConnectionsService,
  createEconomicEntitiesService,
  createHealthService,
  createResourceLinksService,
  createSecretsService,
  createSettingsService,
  type ConnectionCredentialsService,
  type ConnectionsService,
  type EconomicEntitiesService,
  type HealthService,
  type ResourceLinksService,
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
import {
  ProviderCallError,
  createContainerHostsService,
  createDnsProviderTokensService,
  createDriftService,
  createHostingTargetsService,
  createMailDomainsService,
  createManagedDomainsService,
  createProvisioningTemplatesService,
  createProxyResourcesService,
  createTransactionalEnqueue,
  type ContainerHostsService,
  type DnsProviderTokensService,
  type DnsTokenProviderPort,
  type DriftService,
  type HostingTargetsService,
  type MailDomainsService,
  type ManagedDomainsService,
  type ProvisioningTemplatesService,
  type ProxyResourcesService,
  type TransactionalEnqueue
} from '@loxep/infrastructure';
import type {
  AcquisitionConfirmService,
  AcquisitionsService,
  AllocationsService,
  InventoryMediaService,
  ItemsService,
  LocationsService,
  MovementsService,
  OpportunityLinksService,
  SpecificsService
} from '@loxep/inventory';
import { AuthorizationError, requireRole } from '@loxep/auth';
import { getRequestHeaders, setResponseStatus } from '@tanstack/react-start/server';
import { getAuth } from '@/server/auth';

interface AdminRegistry {
  config: BootstrapConfig;
  handle: DbHandle;
  entities: EconomicEntitiesService;
  connections: ConnectionsService;
  /** Phase 8 milestone 1 (loxep-ovj.1): the integration_health rollup, read by the dashboard Operations band and /settings/overview. */
  health: HealthService;
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
  /** `expense_lines` CRUD (loxep-cd3.3, M3) — depends only on `db`, built eagerly like `expenses` above. */
  expenseLines: ExpenseLinesService;
  storageBackendsPromise?: Promise<StorageBackendsService>;
  mediaServicePromise?: Promise<MediaService>;
  /** Receipt attach/list/detach (loxep-dgf.1) — depends on `getMediaService()`, so it is built lazily like it. */
  receiptsServicePromise?: Promise<ReceiptsService>;
  /** `confirmCandidatesAsExpense` (loxep-cd3.3, M3) — depends on `getMediaService()` (needs a `ReceiptsService` internally), so it is built lazily the same way. */
  expenseConfirmServicePromise?: Promise<ExpenseConfirmService>;
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
  /** `confirmCandidatesAsAcquisition` (loxep-cd3.6, M6) — depends only on `db`, so it is built lazily behind {@link getInventoryModule} the same way `acquisitionsServicePromise` above is; no `MediaService` needed (it writes `media_links` directly, mirroring `getInventoryMediaService`'s own reasoning). */
  acquisitionConfirmServicePromise?: Promise<AcquisitionConfirmService>;
  locationsServicePromise?: Promise<LocationsService>;
  movementsServicePromise?: Promise<MovementsService>;
  /** Reservations + depletion-on-fulfillment (`/commerce` manual sale recording, loxep-dgf.6). */
  allocationsServicePromise?: Promise<AllocationsService>;
  opportunityLinksServicePromise?: Promise<OpportunityLinksService>;
  /** Typed key/value item specifics (`/inventory/stock/$id`, loxep-dgf.3). */
  specificsServicePromise?: Promise<SpecificsService>;
  /** Item image gallery links over `media_links` (loxep-dgf.3). */
  inventoryMediaServicePromise?: Promise<InventoryMediaService>;
  /**
   * `/infrastructure` (Phase 7 milestone 3, loxep-lmy.3). `@loxep/infrastructure`
   * depends only on `@loxep/db` + `@loxep/domain` (verified against its own
   * `package.json` — no `graphile-worker`), so these are built eagerly like
   * `entities`/`connections`/`health` above, not through the `@vite-ignore`
   * dynamic-module pattern `@loxep/market`/`@loxep/notifications`/
   * `@loxep/inventory` need.
   */
  managedDomains: ManagedDomainsService;
  hostingTargets: HostingTargetsService;
  infraMail: MailDomainsService;
  drift: DriftService;
  /**
   * Token mint/roll/scope. `provider` is a STUB until a live DNS adapter
   * exposes token-minting endpoints — see {@link buildDnsTokenProviderPort}.
   * `setZones`/`listForTarget`/`get` work fully today; `mint`/`roll`/
   * `syncPolicy` surface a clear `provider_unavailable` error until that
   * adapter work lands.
   */
  dnsProviderTokens: DnsProviderTokensService;
  /** Transactional `graphile_worker.add_job`, for ad hoc "sync now" actions. */
  infrastructureEnqueue: TransactionalEnqueue;
  /**
   * Dockhand host-registration intent + its reconciler (loxep-hb7 Milestone C):
   * `declareIntent` (the create dialog / fleet-detail registration panel's
   * write) and `reconcile`/`listDeclaredTargets`/`listRuns`. Depends only on
   * `db` + `secrets` + `infrastructureEnqueue` (all already eager above), so
   * this is built eagerly too — `@loxep/infrastructure` takes no
   * `@loxep/integration-dockhand` dependency, so building the SERVICE here
   * costs nothing; only RECONCILING needs a live adapter, which
   * `requestContainerHostReconcile` reaches by enqueuing the worker task
   * rather than calling `.reconcile()` from a request (see
   * `infrastructure-functions.ts`'s module doc on never awaiting a provider
   * call synchronously).
   */
  containerHosts: ContainerHostsService;
  /**
   * The generic external-resource companion-link service (loxep-v5r.3):
   * register/attach/list/detach `external_resources`/`resource_links` rows
   * for any registered `resourceType`. Depends only on `db`, so it is built
   * eagerly like `entities`/`connections`/`health` above. SINGLE owner —
   * Phase 8 milestone 3 (loxep-ovj.3) and the knowledge/tasks companion
   * designs (loxep-p1j, loxep-juk) consume this same instance rather than
   * building their own.
   */
  resourceLinks: ResourceLinksService;
  /** Encrypted provider-credential bundles (`connection_credentials`) — needed only by the fleet adapter factory below, so built eagerly alongside `connections`/`secrets` (same `db`+`keyring` dependency, same low cost). */
  connectionCredentials: ConnectionCredentialsService;
  /**
   * Proxy-resource intent + its CHECK-MODE-ONLY reconciler (Pangolin chain
   * design milestone 2, loxep-acj.2): `listResourcesForDomain`/`listRuns` for
   * the domain/fleet detail chain render. `reconcile`/`reconcileDomain` are
   * NOT called from a request here — they need a live `ProxyProviderPort`,
   * which only `@loxep/app`'s worker-side wiring can build (the same
   * "reconciling needs a live adapter; a request only reads what the last
   * run left behind" split `containerHosts` above documents). Depends only
   * on `db`, so it is built eagerly.
   */
  proxyResources: ProxyResourcesService;
  /**
   * The provisioning-template engine (Pangolin chain design milestone 6,
   * loxep-acj.6): template CRUD, the mandatory-preview compile, `startRun`
   * (writes intent + enqueues `infrastructure.run-provisioning-template` in
   * one transaction), and `abandonRun`. Depends only on `db` +
   * `TransactionalEnqueue`, so it is built eagerly like `managedDomains`
   * above. DRIVING a run (`advance()`) needs the real per-connection
   * adapters only `@loxep/app`'s composition root can build — this registry
   * never drives one directly, matching `proxyResources`' own "a request
   * only reads or enqueues; reconciling needs a live adapter" split.
   */
  provisioningTemplates: ProvisioningTemplatesService;
  /**
   * Dynamically-loaded `@loxep/app` module, cached on the registry. `@loxep/app`
   * depends on `@loxep/jobs`/`@loxep/market`/`@loxep/notifications` (its whole
   * multi-provider adapter-factory composition), reaching `graphile-worker`
   * the same way those packages do on their own — see `getNotificationsModule`'s
   * doc below for the SSR-bundling hazard this avoids. Loaded ONLY for
   * `createDockhandAdapterFactory` (loxep-hb7 Milestone B's live containers
   * panel needs a Dockhand adapter reachable from a server function); no other
   * `@loxep/app` export is used from `apps/web`.
   */
  fleetModulePromise?: Promise<typeof import('@loxep/app')>;
  /** The Dockhand READ adapter factory (loxep-hb7 Milestone B), loaded through the module above. Cached so a page view does not rebuild the per-connection session cache on every request. */
  dockhandAdapterFactoryPromise?: Promise<{
    getAdapterForConnection: import('@loxep/app').DockhandAdapterFactory;
    invalidate: (connectionId: string) => void;
  }>;
  /**
   * The Termix READ adapter factory (loxep-4ah, owner-approved per-session
   * rows), loaded through the module above. Mirrors
   * `dockhandAdapterFactoryPromise` exactly: cached on the registry so the
   * fleet-detail sessions panel's live `listSessions()` read reuses the same
   * cached bearer token across requests rather than logging in on every page
   * view — see `@loxep/app`'s `fleet.ts` for why a Termix adapter's cache
   * carries no TTL (the login-attempt 429 loxep-wvm §1.6/§2.2(f) names).
   */
  termixAdapterFactoryPromise?: Promise<{
    getAdapterForConnection: import('@loxep/app').TermixAdapterFactory;
    invalidate: (connectionId: string) => void;
  }>;
}

const REGISTRY_KEY = Symbol.for('loxep.web.admin');

type GlobalWithAdminRegistry = typeof globalThis & { [REGISTRY_KEY]?: AdminRegistry };

/**
 * A minted per-host DNS token is created by calling the DNS provider's OWN
 * token-issuance endpoint (Cloudflare's, today) — `@loxep/integration-cloudflare`
 * has no such client yet (only zone/record/read endpoints are implemented;
 * see the design's implementation-status header). Rather than block the
 * whole `/infrastructure` workspace on that adapter work, `mint`/`roll`/
 * `syncPolicy` are wired to this STUB, which fails honestly with the same
 * `provider_unavailable` taxonomy kind a real outage would produce —
 * `tokens.ts` already treats that as a `ProviderCallError`, so the mint
 * dialog's error toast reads exactly like "the provider is unreachable"
 * rather than a crash. `setZones`/`listForTarget`/`get`/`listZones` do NOT
 * go through this port and work fully against real data today.
 *
 * Replacing this with a real adapter is follow-up work, not a design gap:
 * once `@loxep/integration-cloudflare` (or another DNS provider adapter)
 * exposes token create/roll/policy endpoints, this function is the one
 * place that needs to change.
 */
function dnsTokenProviderUnavailable(operation: string): never {
  throw new ProviderCallError(
    'provider_unavailable',
    `DNS token ${operation} has no live provider adapter wired up yet`
  );
}

function buildDnsTokenProviderPort(): DnsTokenProviderPort {
  return {
    // `async` is load-bearing here, not stylistic: `() =>
    // Promise.reject(fn())` evaluates `fn()` EAGERLY, so a `fn` that THROWS
    // (rather than returns a value to reject with) throws synchronously at
    // the call site instead of producing a rejected Promise. Every caller
    // today happens to sit inside a `try`/`await`, so the bug was silent,
    // but it broke the declared Promise-returning contract. `async` turns
    // the synchronous throw into a proper rejection.
    mintToken: async () => dnsTokenProviderUnavailable('minting'),
    rollToken: async () => dnsTokenProviderUnavailable('rolling'),
    updatePolicy: async () => dnsTokenProviderUnavailable('policy sync'),
    findTokenById: () => Promise.resolve({ exists: false })
  };
}

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
    health: createHealthService({ db: handle.db }),
    settings: createSettingsService({ db: handle.db }),
    secrets: createSecretsService({ db: handle.db, keyring: config.keyring }),
    expenses: createExpensesService({ db: handle.db }),
    expenseReports: createExpenseReports({ db: handle.db }),
    expenseLines: createExpenseLinesService({ db: handle.db }),
    books: createBooksService({ db: handle.db }),
    fiscalPeriods: createFiscalPeriodsService({ db: handle.db }),
    ledgerReports: createLedgerReports({ db: handle.db }),
    managedDomains: createManagedDomainsService({
      db: handle.db,
      enqueue: createTransactionalEnqueue()
    }),
    hostingTargets: createHostingTargetsService({ db: handle.db }),
    infraMail: createMailDomainsService({
      db: handle.db,
      enqueue: createTransactionalEnqueue()
    }),
    drift: createDriftService({ db: handle.db }),
    dnsProviderTokens: createDnsProviderTokensService({
      db: handle.db,
      provider: buildDnsTokenProviderPort(),
      // Nested savepoint inside tokens.ts's own transaction — see
      // TransactionalDnsTokenSecretWriter's doc in `@loxep/infrastructure`.
      secrets: (tx, input) =>
        createSecretsService({ db: tx, keyring: config.keyring }).setSecret(input),
      enqueue: createTransactionalEnqueue(),
      providerName: 'cloudflare'
    }),
    infrastructureEnqueue: createTransactionalEnqueue(),
    containerHosts: createContainerHostsService({
      db: handle.db,
      readSecret: async (secretKey) => {
        const secret = await createSecretsService({
          db: handle.db,
          keyring: config.keyring
        }).getSecretPayload(secretKey, 'container_host_secret');
        return secret.payload;
      },
      // Nested savepoint inside `declareIntent`'s own transaction — the SAME
      // shape `dnsProviderTokens.secrets` above uses.
      writeSecret: (tx, input) =>
        createSecretsService({ db: tx, keyring: config.keyring }).setSecret(input),
      enqueue: createTransactionalEnqueue()
    }),
    resourceLinks: createResourceLinksService({ db: handle.db }),
    connectionCredentials: createConnectionCredentialsService({
      db: handle.db,
      keyring: config.keyring
    }),
    proxyResources: createProxyResourcesService({
      db: handle.db,
      settings: createSettingsService({ db: handle.db })
    }),
    provisioningTemplates: createProvisioningTemplatesService({
      db: handle.db,
      enqueue: createTransactionalEnqueue()
    })
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

/** `expense_lines` CRUD (`/finance/expenses/$id`, `/finance/expenses/new`), loxep-cd3.3. */
export function getExpenseLinesService(): ExpenseLinesService {
  return getAdminServices().expenseLines;
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

/** Managed domains, desired DNS records, and the transactional-enqueue intent path (`/infrastructure/domains`). */
export function getManagedDomainsService(): ManagedDomainsService {
  return getAdminServices().managedDomains;
}

/** Hosting targets and the fronting-chain guard (`/infrastructure/fleet`). */
export function getHostingTargetsService(): HostingTargetsService {
  return getAdminServices().hostingTargets;
}

/** Mail registration/verification/mailbox intent (`/infrastructure/domains/$name`'s mail panel). */
export function getInfrastructureMailService(): MailDomainsService {
  return getAdminServices().infraMail;
}

/** Persisted DNS drift findings — the desired-vs-observed diff panel. */
export function getDriftService(): DriftService {
  return getAdminServices().drift;
}

/** Minted per-host DNS tokens: mint (reveal-once), roll, and zone-scope intent. */
export function getDnsProviderTokensService(): DnsProviderTokensService {
  return getAdminServices().dnsProviderTokens;
}

/** Transactional `graphile_worker.add_job`, for a manual "sync now" action. */
export function getInfrastructureEnqueue(): TransactionalEnqueue {
  return getAdminServices().infrastructureEnqueue;
}

/** Dockhand host-registration intent + reconciler (loxep-hb7 Milestone C). */
export function getContainerHostsService(): ContainerHostsService {
  return getAdminServices().containerHosts;
}

/** The generic external-resource companion-link service (loxep-v5r.3). */
export function getResourceLinksService(): ResourceLinksService {
  return getAdminServices().resourceLinks;
}

/** Proxy-resource intent + read-only run history (Pangolin chain design M2, loxep-acj.2). */
export function getProxyResourcesService(): ProxyResourcesService {
  return getAdminServices().proxyResources;
}

/** The provisioning-template engine's CRUD + `startRun`/`abandonRun` (Pangolin chain design M6, loxep-acj.6). */
export function getProvisioningTemplatesService(): ProvisioningTemplatesService {
  return getAdminServices().provisioningTemplates;
}

/**
 * Dynamically-loaded `@loxep/app` module, cached on the registry — see the
 * `fleetModulePromise` field's doc for why this must not be a top-level
 * import. The `@vite-ignore` variable specifier keeps it out of the SSR
 * bundle so Node resolves it from real node_modules, matching
 * `getNotificationsModule`/`getMarketModule`/`getInventoryModule` below.
 */
export function getFleetModule(): Promise<typeof import('@loxep/app')> {
  const registry = getAdminServices();
  registry.fleetModulePromise ??= (async () => {
    const specifier = '@loxep/app';
    return (await import(/* @vite-ignore */ specifier)) as typeof import('@loxep/app');
  })();
  return registry.fleetModulePromise;
}

/**
 * The Dockhand READ adapter factory (loxep-hb7 Milestone B), loaded through
 * the module above. `createDockhandAdapterFactory` caches its own per-
 * connection session cookie with no TTL (see `@loxep/app`'s `fleet.ts` for
 * why — Dockhand's login-lockout backoff makes rebuild-on-TTL wasteful), so
 * this factory itself is cached on the registry for the same reason: a fleet
 * page view should reuse the same session across requests, not force a fresh
 * login every time.
 */
function getDockhandAdapterFactory(): Promise<{
  getAdapterForConnection: import('@loxep/app').DockhandAdapterFactory;
  invalidate: (connectionId: string) => void;
}> {
  const registry = getAdminServices();
  registry.dockhandAdapterFactoryPromise ??= (async () => {
    const fleet = await getFleetModule();
    return fleet.createDockhandAdapterFactory({
      connections: registry.connections,
      connectionCredentials: registry.connectionCredentials
    });
  })();
  return registry.dockhandAdapterFactoryPromise;
}

/**
 * A live Dockhand adapter for one connection — the ONLY fleet-adapter access
 * `apps/web` needs (loxep-hb7 Milestone B's containers/stacks panel; every
 * other fleet provider's data reaches `apps/web` already-written by
 * `health.sweep`, never through a live adapter call from a server function).
 */
export async function getDockhandAdapterForConnection(
  connectionId: string
): Promise<import('@loxep/app').DockhandConnectionAdapter['adapter']> {
  const factory = await getDockhandAdapterFactory();
  const { adapter } = await factory.getAdapterForConnection(connectionId);
  return adapter;
}

/**
 * The Termix READ adapter factory (loxep-4ah), loaded through
 * {@link getFleetModule}. Mirrors {@link getDockhandAdapterFactory} exactly —
 * same caching rationale, same registry shape.
 */
function getTermixAdapterFactory(): Promise<{
  getAdapterForConnection: import('@loxep/app').TermixAdapterFactory;
  invalidate: (connectionId: string) => void;
}> {
  const registry = getAdminServices();
  registry.termixAdapterFactoryPromise ??= (async () => {
    const fleet = await getFleetModule();
    return fleet.createTermixAdapterFactory({
      connections: registry.connections,
      connectionCredentials: registry.connectionCredentials
    });
  })();
  return registry.termixAdapterFactoryPromise;
}

/**
 * A live Termix adapter for one connection (loxep-4ah's fleet-detail
 * sessions panel) — mirrors {@link getDockhandAdapterForConnection}: the
 * ONLY fleet-adapter access `apps/web` needs for Termix, since every other
 * read reaches `apps/web` already-written by `health.sweep`.
 */
export async function getTermixAdapterForConnection(
  connectionId: string
): Promise<import('@loxep/app').TermixConnectionAdapter['adapter']> {
  const factory = await getTermixAdapterFactory();
  const { adapter } = await factory.getAdapterForConnection(connectionId);
  return adapter;
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
 * `confirmCandidatesAsExpense` (loxep-cd3.3, M3) — the ONE confirm function
 * both `/finance/import`'s document review AND `/finance/expenses/new`'s
 * dragged-candidate stamping call. Depends on {@link getMediaService}
 * (needs a `ReceiptsService` internally to attach a confirmed document's
 * receipt image), so it is built lazily the same way
 * {@link getReceiptsService} is.
 */
export function getExpenseConfirmService(): Promise<ExpenseConfirmService> {
  const registry = getAdminServices();
  registry.expenseConfirmServicePromise ??= (async () => {
    const media = await getMediaService();
    return createExpenseConfirmService({ db: registry.handle.db, media });
  })();
  return registry.expenseConfirmServicePromise;
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

/**
 * `confirmCandidatesAsAcquisition` (loxep-cd3.6, M6) — the acquisition-side
 * counterpart to {@link getExpenseConfirmService}: candidates dispositioned
 * `acquisition_cost`/`inventory_intake` become an acquisition (new or
 * existing) plus `acquisition_costs`, never an `expenses` row (the
 * acquisition seam, `flipping-lifecycle-design.md`).
 */
export function getAcquisitionConfirmService(): Promise<AcquisitionConfirmService> {
  const registry = getAdminServices();
  registry.acquisitionConfirmServicePromise ??= (async () => {
    const inventory = await getInventoryModule();
    return inventory.createAcquisitionConfirmService({ db: registry.handle.db });
  })();
  return registry.acquisitionConfirmServicePromise;
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

/** Allocations service — reservations + depletion-on-fulfillment (`/commerce` manual sale recording, loxep-dgf.6). */
export function getAllocationsService(): Promise<AllocationsService> {
  const registry = getAdminServices();
  registry.allocationsServicePromise ??= (async () => {
    const inventory = await getInventoryModule();
    return inventory.createAllocationsService({ db: registry.handle.db });
  })();
  return registry.allocationsServicePromise;
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

/** Typed key/value item specifics (loxep-dgf.3, M3) — `inventory_item_specifics`. */
export function getSpecificsService(): Promise<SpecificsService> {
  const registry = getAdminServices();
  registry.specificsServicePromise ??= (async () => {
    const inventory = await getInventoryModule();
    return inventory.createSpecificsService({ db: registry.handle.db });
  })();
  return registry.specificsServicePromise;
}

/**
 * Item image gallery links over `media_links` (loxep-dgf.3, M3). Domain-side
 * link bookkeeping only — upload/serve of the underlying bytes goes through
 * {@link getMediaService}, exactly as `@/server/inventory-media.ts` composes
 * the two, mirroring `@/server/receipt-media.ts` composing
 * {@link getMediaService} with {@link getReceiptsService}.
 */
export function getInventoryMediaService(): Promise<InventoryMediaService> {
  const registry = getAdminServices();
  registry.inventoryMediaServicePromise ??= (async () => {
    const inventory = await getInventoryModule();
    return inventory.createInventoryMediaService({ db: registry.handle.db });
  })();
  return registry.inventoryMediaServicePromise;
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
