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
import { gatusRateBudgetSetting } from "@loxep/domain";
import { createCloudflareAdapterFactory } from "./cloudflare.ts";
import type { CloudflareAdapterFactory } from "./cloudflare.ts";
import { createPurelymailAdapterFactory } from "./purelymail.ts";
import type { PurelymailAdapterFactory } from "./purelymail.ts";
import { createEbayAdapterFactory } from "./ebay.ts";
import type { EbayAdapterFactory } from "./ebay.ts";
import { createEtsyAdapterFactory } from "./etsy.ts";
import type { EtsyAdapterFactory } from "./etsy.ts";
import { createReverbAdapterFactory } from "./reverb.ts";
import type { ReverbAdapterFactory } from "./reverb.ts";
import { createMedusaAdapterFactory } from "./medusa.ts";
import type { MedusaAdapterFactory } from "./medusa.ts";
import { createMonitorSettingsReader } from "./settings.ts";
import type { MonitorSettingsReader } from "./settings.ts";
import { createWooAdapterFactory } from "./woo.ts";
import type { WooAdapterFactory } from "./woo.ts";
import {
  createBeszelAdapterFactory,
  createDockhandAdapterFactory,
  createGatusAdapterFactory,
  createTailscaleAdapterFactory,
  createTermixAdapterFactory,
} from "./fleet.ts";
import type {
  BeszelAdapterFactory,
  DockhandAdapterFactory,
  GatusAdapterFactory,
  TailscaleAdapterFactory,
  TermixAdapterFactory,
} from "./fleet.ts";

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
   * Override the per-connection Medusa token bucket (loxep-xxz). Production
   * uses `medusa.ts`'s documented defaults (matching the adapter's own
   * conservative default); there is no registered
   * `integration.medusa.rate_budget` setting yet, matching Cloudflare's/
   * Purelymail's/Reverb's own gap — an explicit value here WINS, which is how
   * tests get a wide-open budget without spending wall-clock time waiting on
   * refills.
   */
  medusaRateBudget?: { capacity: number; refillPerSecond: number };
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
   * Override the per-connection Purelymail token bucket (Phase 7 milestone 2
   * composition-root wiring, loxep-lmy.2). Production uses `purelymail.ts`'s
   * documented defaults; there is no registered setting for it yet, unlike
   * eBay/Woo.
   */
  purelymailRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Override the per-connection Reverb token bucket (loxep-g4t.3). There is
   * no registered `integration.reverb.rate_budget` setting yet (matching
   * Cloudflare's/Purelymail's own gap) — production always uses `reverb.ts`'s
   * documented conservative-guess defaults; an explicit value here WINS,
   * which is how tests get a wide-open budget without spending wall-clock
   * time waiting on refills.
   */
  reverbRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Override the per-connection Beszel token bucket (loxep-rf4/loxep-y64).
   * There is no registered `integration.beszel.rate_budget` setting yet
   * (matching Cloudflare's/Purelymail's/Reverb's own gap) — production always
   * uses `fleet.ts`'s documented defaults; an explicit value here WINS, which
   * is how tests get a wide-open budget without spending wall-clock time
   * waiting on refills.
   */
  beszelRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Override the per-connection Dockhand token bucket (loxep-rf4/loxep-hb7).
   * No registered `integration.dockhand.rate_budget` setting exists yet;
   * production uses `fleet.ts`'s documented defaults (which already reserve
   * most of the burst for the login exchange's `DOCKHAND_LOGIN_COST`); an
   * explicit value here WINS, the same override-beats-default shape every
   * other provider in this file uses.
   */
  dockhandRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Override the per-connection Gatus token bucket (loxep-rf4/loxep-1au).
   * UNLIKE Beszel/Dockhand/Tailscale/Termix, Gatus has a REGISTERED setting
   * (`gatusRateBudgetSetting`, `integration.gatus.rate_budget`) — production
   * reads it via `resolveRateBudget` below, falling back to `fleet.ts`'s
   * documented defaults on a read failure; an explicit value here WINS over
   * the setting, exactly like `ebayRateBudget`/`wooRateBudget` above.
   */
  gatusRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Override the per-connection Tailscale token bucket (loxep-rf4/loxep-50t).
   * No registered `integration.tailscale.rate_budget` setting exists yet;
   * production uses `fleet.ts`'s documented defaults; an explicit value here
   * WINS.
   */
  tailscaleRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Override the per-connection Termix token bucket (loxep-rf4/loxep-wvm).
   * No registered `integration.termix.rate_budget` setting exists yet;
   * production uses `fleet.ts`'s documented defaults (deliberately gentle —
   * Termix's login route is the one endpoint upstream documents a 429 on);
   * an explicit value here WINS.
   */
  termixRateBudget?: { capacity: number; refillPerSecond: number };
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
   * Connection-scoped Medusa adapter (backend URL + secret API key + budget,
   * loxep-xxz). Per-CONNECTION like eBay/Woo, not shared-per-installation
   * like Etsy — see `medusa.ts`'s module doc.
   */
  getMedusaAdapterForConnection: MedusaAdapterFactory;
  /** Drop a cached Medusa adapter (after an `auth`-class provider failure). */
  invalidateMedusaAdapter: (connectionId: string) => void;
  /** The Medusa interval floor implied by the DEFAULT/overridden budget. */
  medusaIntervalFloorSeconds: number;
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
  /**
   * Connection-scoped Purelymail adapter — Phase 7 milestone 2's
   * composition-root wiring (loxep-lmy.2). Per-CONNECTION like Cloudflare, and
   * with NO non-secret configuration at all: Purelymail exposes no account
   * identifier, so `connections.config` carries nothing for this provider. See
   * `purelymail.ts`'s module doc, including why its `sourceAccountKey` is not
   * unique across two tokens.
   */
  getPurelymailAdapterForConnection: PurelymailAdapterFactory;
  /** Drop a cached Purelymail adapter (after an `auth`-class provider failure). */
  invalidatePurelymailAdapter: (connectionId: string) => void;
  /** The Purelymail interval floor implied by the DEFAULT/overridden budget. */
  purelymailIntervalFloorSeconds: number;
  /**
   * Connection-scoped Reverb adapter (Personal Access Token + budget,
   * loxep-g4t.3). Per-CONNECTION like Cloudflare/Purelymail, not
   * shared-per-installation like Etsy: Reverb has no application-level
   * credential to pool a budget against — see `reverb.ts`'s module doc.
   */
  getReverbAdapterForConnection: ReverbAdapterFactory;
  /** Drop a cached Reverb adapter (after an `auth`-class provider failure). */
  invalidateReverbAdapter: (connectionId: string) => void;
  /** The Reverb interval floor implied by the DEFAULT/overridden budget. */
  reverbIntervalFloorSeconds: number;
  /**
   * Connection-scoped Beszel adapter (readonly-user login + base URL +
   * budget, loxep-rf4/loxep-y64). Per-CONNECTION, and — unlike
   * Cloudflare/Purelymail/Reverb — the underlying cache carries NO TTL: see
   * `fleet.ts`'s module doc for why an auth-token-caching fleet adapter must
   * not be rebuilt on a schedule.
   */
  getBeszelAdapterForConnection: BeszelAdapterFactory;
  /** Drop a cached Beszel adapter (after an `auth`-class provider failure, or an operator "test connection" action). */
  invalidateBeszelAdapter: (connectionId: string) => void;
  /** The Beszel interval floor implied by the DEFAULT/overridden budget. */
  beszelIntervalFloorSeconds: number;
  /**
   * Connection-scoped Dockhand READ adapter (session login + base URL +
   * budget, loxep-rf4/loxep-hb7). The same no-TTL caching discipline as
   * Beszel, for the same reason — see `fleet.ts`. This is the READ half only;
   * the host-intent reconciler (`infrastructure.reconcile-container-host`) is
   * a later slice and lives outside this package's fence.
   */
  getDockhandAdapterForConnection: DockhandAdapterFactory;
  /** Drop a cached Dockhand adapter (after an `auth`-class provider failure, or an operator "test connection" action). */
  invalidateDockhandAdapter: (connectionId: string) => void;
  /** The Dockhand interval floor implied by the DEFAULT/overridden budget. */
  dockhandIntervalFloorSeconds: number;
  /**
   * Connection-scoped Gatus adapter (base URL + an OPTIONAL Basic-auth
   * credential + budget, loxep-rf4/loxep-1au). Gatus is the one fleet
   * provider with a REGISTERED rate-budget setting — see
   * `gatusRateBudget`/`resolveRateBudget` below — and the one whose adapter
   * cache uses an ordinary TTL, because rebuilding it costs no auth
   * round-trip (`fleet.ts`'s module doc).
   */
  getGatusAdapterForConnection: GatusAdapterFactory;
  /** Drop a cached Gatus adapter (after an `auth`-class provider failure, or an operator "test connection" action). */
  invalidateGatusAdapter: (connectionId: string) => void;
  /** The Gatus interval floor implied by the DEFAULT/overridden budget. */
  gatusIntervalFloorSeconds: number;
  /**
   * Connection-scoped Tailscale adapter (an API access token OR an OAuth
   * client + an optional tailnet name + budget, loxep-rf4/loxep-50t). The
   * same no-TTL caching discipline as Beszel/Dockhand/Termix — an
   * `oauth_client`-mode adapter caches a one-hour access token in memory that
   * a scheduled rebuild would discard early.
   */
  getTailscaleAdapterForConnection: TailscaleAdapterFactory;
  /** Drop a cached Tailscale adapter (after an `auth`-class provider failure — including a stale API access token — or an operator "test connection" action). */
  invalidateTailscaleAdapter: (connectionId: string) => void;
  /** The Tailscale interval floor implied by the DEFAULT/overridden budget. */
  tailscaleIntervalFloorSeconds: number;
  /**
   * Connection-scoped Termix adapter (login + base URL + budget,
   * loxep-rf4/loxep-wvm). The strongest instance of the no-TTL caching
   * discipline in this file: Termix's login route is the one endpoint
   * upstream documents a 429 on, with no published threshold or duration —
   * see `fleet.ts`'s module doc.
   */
  getTermixAdapterForConnection: TermixAdapterFactory;
  /** Drop a cached Termix adapter (after an `auth`-class provider failure, or an operator "test connection" action). */
  invalidateTermixAdapter: (connectionId: string) => void;
  /** The Termix interval floor implied by the DEFAULT/overridden budget. */
  termixIntervalFloorSeconds: number;
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

  // PER-CONNECTION — see medusa.ts's module doc. `resolveRateBudget` is
  // intentionally omitted (no registered setting for it yet, matching
  // Cloudflare's/Purelymail's/Reverb's own gap); an explicit
  // `medusaRateBudget` still wins over the compiled-in defaults.
  const medusa = createMedusaAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.medusaRateBudget !== undefined
      ? { rateBudget: options.medusaRateBudget }
      : {}),
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

  // PER-CONNECTION, and deliberately gentler than Cloudflare's: Purelymail
  // publishes no API rate limit at all, and an undocumented limit is one
  // nobody can design against. See purelymail.ts's module doc.
  const purelymail = createPurelymailAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.purelymailRateBudget !== undefined
      ? { rateBudget: options.purelymailRateBudget }
      : {}),
  });

  // PER-CONNECTION — see reverb.ts's module doc for why Reverb, unlike Etsy,
  // has no application-level credential to force pooling a shared budget.
  const reverb = createReverbAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.reverbRateBudget !== undefined
      ? { rateBudget: options.reverbRateBudget }
      : {}),
  });

  // PER-CONNECTION, no-TTL cache (see fleet.ts's module doc — Beszel's
  // adapter caches a PocketBase token, so rebuilding on a schedule would
  // perform ~288 logins/day for nothing). No registered rate-budget setting
  // yet.
  const beszel = createBeszelAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.beszelRateBudget !== undefined
      ? { rateBudget: options.beszelRateBudget }
      : {}),
  });

  // PER-CONNECTION, no-TTL cache — Dockhand's session cookie is the same
  // correctness constraint as Beszel's token, sharpened by Dockhand's
  // documented five-failed-logins account lockout. No registered rate-budget
  // setting yet.
  const dockhand = createDockhandAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.dockhandRateBudget !== undefined
      ? { rateBudget: options.dockhandRateBudget }
      : {}),
  });

  // PER-CONNECTION, ordinary TTL cache (fleet.ts: Gatus has no login
  // exchange, so a rebuild costs no auth round-trip — caching here is for the
  // rate budget only). Gatus is the one fleet provider with a REGISTERED
  // setting, resolved the way eBay/Woo resolve their own.
  const gatus = createGatusAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.gatusRateBudget !== undefined
      ? { rateBudget: options.gatusRateBudget }
      : {}),
    resolveRateBudget: async () => (await monitorSettings.service.get(gatusRateBudgetSetting)),
  });

  // PER-CONNECTION, no-TTL cache — an `oauth_client`-mode adapter caches a
  // one-hour access token in memory that a scheduled rebuild would discard
  // early. No registered rate-budget setting yet.
  const tailscale = createTailscaleAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.tailscaleRateBudget !== undefined
      ? { rateBudget: options.tailscaleRateBudget }
      : {}),
  });

  // PER-CONNECTION, no-TTL cache — the strongest instance of this file's
  // caching-as-correctness argument: Termix's login route is the one
  // endpoint upstream documents a 429 on. No registered rate-budget setting
  // yet.
  const termix = createTermixAdapterFactory({
    connections,
    connectionCredentials,
    ...(logger !== undefined ? { logger } : {}),
    ...(options.termixRateBudget !== undefined
      ? { rateBudget: options.termixRateBudget }
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
    getMedusaAdapterForConnection: medusa.getAdapterForConnection,
    invalidateMedusaAdapter: medusa.invalidate,
    medusaIntervalFloorSeconds: medusa.intervalFloorSeconds,
    getEtsyAdapterForConnection: etsy.getAdapterForConnection,
    invalidateEtsyAdapter: etsy.invalidate,
    etsyIntervalFloorSeconds: etsy.intervalFloorSeconds,
    getCloudflareAdapterForConnection: cloudflare.getAdapterForConnection,
    invalidateCloudflareAdapter: cloudflare.invalidate,
    cloudflareIntervalFloorSeconds: cloudflare.intervalFloorSeconds,
    getPurelymailAdapterForConnection: purelymail.getAdapterForConnection,
    invalidatePurelymailAdapter: purelymail.invalidate,
    purelymailIntervalFloorSeconds: purelymail.intervalFloorSeconds,
    getReverbAdapterForConnection: reverb.getAdapterForConnection,
    invalidateReverbAdapter: reverb.invalidate,
    reverbIntervalFloorSeconds: reverb.intervalFloorSeconds,
    getBeszelAdapterForConnection: beszel.getAdapterForConnection,
    invalidateBeszelAdapter: beszel.invalidate,
    beszelIntervalFloorSeconds: beszel.intervalFloorSeconds,
    getDockhandAdapterForConnection: dockhand.getAdapterForConnection,
    invalidateDockhandAdapter: dockhand.invalidate,
    dockhandIntervalFloorSeconds: dockhand.intervalFloorSeconds,
    getGatusAdapterForConnection: gatus.getAdapterForConnection,
    invalidateGatusAdapter: gatus.invalidate,
    gatusIntervalFloorSeconds: gatus.intervalFloorSeconds,
    getTailscaleAdapterForConnection: tailscale.getAdapterForConnection,
    invalidateTailscaleAdapter: tailscale.invalidate,
    tailscaleIntervalFloorSeconds: tailscale.intervalFloorSeconds,
    getTermixAdapterForConnection: termix.getAdapterForConnection,
    invalidateTermixAdapter: termix.invalidate,
    termixIntervalFloorSeconds: termix.intervalFloorSeconds,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeDb(handle);
    },
  };
}
