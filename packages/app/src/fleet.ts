/**
 * Composition-root wiring for the fleet-observability providers (Phase 8):
 * Beszel, Dockhand, Gatus, Tailscale, and Termix (loxep-9j6; the adapter
 * factories below are loxep-rf4's shared foundation, extended per-provider by
 * loxep-hb7/loxep-y64/loxep-1au/loxep-50t/loxep-wvm).
 *
 * Two shapes among the five, and the difference is the point:
 *
 * ```text
 * beszel, gatus,     READ ONLY. No port, because there is nothing to
 * tailscale, termix   reconcile — each is authoritative about its own
 *                     subject and Loxep records the latest observation.
 *                     Wiring the per-subject projection into
 *                     integration_health is a future slice; see the TODO
 *                     below.
 *
 * dockhand            READ + HOST INTENT. Gets a port
 *                     (containerHostPortFromDockhandAdapter, below), because
 *                     the owner's 2026-08-13 rule-13 carve-out makes host
 *                     registration desired state, and desired state in Loxep
 *                     goes through a reconciler.
 * ```
 *
 * ## What this module now provides, and what still lives elsewhere
 *
 * Each of the five providers below gets a **cached, per-connection adapter
 * factory**, following `cloudflare.ts`'s shape exactly: a `connections` row
 * plus a decrypted ADR-0019 credential bundle in, a ready-to-use adapter out,
 * a per-connection rate budget held OUTSIDE the adapter cache so it survives
 * an `invalidate()`, non-secret config read from `connections.config.<provider>`,
 * and `invalidate(connectionId)` reserved for an `auth`-class provider
 * failure or an explicit operator "test connection" action.
 *
 * **One deliberate divergence from `cloudflare.ts`, and it is per-provider:**
 * Beszel, Dockhand, and Termix each cache an authentication artifact IN THE
 * ADAPTER ITSELF — a PocketBase token, a session cookie, a bearer JWT — that
 * a TTL-driven rebuild would discard well before it needed replacing. Two of
 * those three (Dockhand, Termix) sit behind a documented login-attempt
 * limiter. So those three factories' caches carry **no TTL at all**: only
 * `invalidate()` forces a rebuild, which is what keeps health.sweep's
 * five-minute cadence from performing a fresh login almost every cycle — see
 * each factory's own doc for the specific number. Gatus and Tailscale do not
 * share that hazard to the same degree (Gatus has no login exchange at all;
 * an `api_access_token`-mode Tailscale credential has no in-memory state to
 * lose) and keep the ordinary TTL-based cache `cloudflare.ts`/`gatus.ts`-style
 * factories use elsewhere in this package — see their own docs for the
 * reasoning, including where it is weaker than it looks.
 *
 * **Still not here: the connection HEALTH PROBES and the composed sweep
 * registry.** `@loxep/domain` takes no integration-package dependency, so
 * `createDefaultHealthSubjectRegistry` cannot host a provider-specific probe
 * (see `HealthProbeOutcome.source`'s doc in
 * `packages/domain/src/health-probes.ts`). `runHealthSweep` accepts a
 * `registry` override for exactly this, and `packages/app/src/health-sweep.ts`
 * is the wrapper that owns composing one whose `connection` entry dispatches
 * fleet-provider rows to these five factories and everything else to the
 * domain package's derived `probeConnection`. That composition, the
 * provider-specific status mappings, and the catalog/form work on
 * `apps/web` are separate slices built on top of what this file provides.
 *
 * ## `integration_health`: half of the projection is already free, half is not
 *
 * Milestone 1 (loxep-ovj.1) has landed — migration `0014_integration_health`,
 * `@loxep/domain`'s `createHealthService`, and the `health.sweep` job. That
 * splits the projection question cleanly in two, and only one half needs code:
 *
 * - **connection-level health is already covered, with nothing added here.**
 *   The default registry's `connection` subject derives status from
 *   `connections.last_success_at` / `last_error_at` with no network call, so
 *   the moment a `beszel` or `dockhand` connection row exists it gets an
 *   `integration_health` row like every other provider's. That is the right
 *   answer for "can Loxep reach this tool", which is the question this phase's
 *   fleet-health summary actually asks first.
 * - **per-subject health — one row per Beszel system, one per Dockhand managed
 *   host — is still a seam**, and what blocks it is not the table. It is the
 *   LINK. The design is explicit that there is *"no provider-specific column
 *   anywhere… no `hosting_targets.beszel_system_id`"*; a per-host row keys on
 *   `subject_type = 'hosting_target'` and needs `external_resources` /
 *   `resource_links` to say which target a given provider subject is. Those
 *   tables have not shipped.
 *
 * When they do, the shape each provider projects is already decided:
 *
 * ```text
 * subject_type     status                      observed_at
 * ---------------  --------------------------  ----------------------------
 * hosting_target   Beszel's own status string  the system record's own
 *                                              `updated` time
 * hosting_target   derived from Dockhand's     LOXEP'S READ CLOCK — Dockhand
 *                  host record                 reports no per-host timestamp
 * ```
 *
 * The one rule that must survive that wiring is the design's: *"Every status
 * renders its provenance… A status with no visible age is a status an operator
 * will over-trust."* Both providers carry an observation time, and Dockhand's
 * is Loxep's read clock rather than the provider's — a difference that has to
 * stay visible in the projection, not be smoothed over into a single column
 * that means two things.
 */
import type {
  ContainerHostApplyResult,
  ContainerHostOperation,
  ContainerHostProviderCapabilities,
  ContainerHostProviderPort,
  ObservedContainerHost,
} from "@loxep/infrastructure";
import type { ConnectionCredentialsService, ConnectionsService } from "@loxep/domain";
import { SecretNotFoundError } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import { AppConfigurationError } from "./errors.ts";

import {
  createBeszelAdapter,
  createRateBudget as createBeszelRateBudget,
  beszelSourceAccountKey,
} from "@loxep/integration-beszel";
import type {
  BeszelAdapter,
  RateBudget as BeszelRateBudget,
} from "@loxep/integration-beszel";

import {
  createDockhandAdapter,
  createRateBudget as createDockhandRateBudget,
  dockhandSourceAccountKey,
} from "@loxep/integration-dockhand";
import type {
  DockhandAdapter,
  DockhandHostOperation,
  RateBudget as DockhandRateBudget,
} from "@loxep/integration-dockhand";

import {
  createGatusAdapter,
  createRateBudget as createGatusRateBudget,
  gatusSourceAccountKey,
} from "@loxep/integration-gatus";
import type {
  GatusAdapter,
  RateBudget as GatusRateBudget,
} from "@loxep/integration-gatus";

import {
  TAILSCALE_DEFAULT_BASE_URL,
  TAILSCALE_DEFAULT_TAILNET,
  createRateBudget as createTailscaleRateBudget,
  createTailscaleAdapter,
  tailscaleSourceAccountKey,
} from "@loxep/integration-tailscale";
import type {
  RateBudget as TailscaleRateBudget,
  TailscaleAdapter,
  TailscaleCredentials,
} from "@loxep/integration-tailscale";

import {
  createRateBudget as createTermixRateBudget,
  createTermixAdapter,
  termixSourceAccountKey,
} from "@loxep/integration-termix";
import type {
  RateBudget as TermixRateBudget,
  TermixAdapter,
} from "@loxep/integration-termix";

/**
 * The slice of the real {@link DockhandAdapter} the port wrapper consumes.
 *
 * Stated as a `Pick` over the imported adapter type — not a re-declared
 * structural interface — so this file carries the same guarantee as its
 * siblings (`mailProviderPortFromPurelymailAdapter` takes a `PurelymailAdapter`,
 * `providerPortFromCloudflareAdapter` takes a `CloudflareAdapter`): if the
 * Dockhand adapter's `readHosts`/`applyHost`/`capabilities` drift from what
 * `@loxep/infrastructure`'s port expects, the wrapper below stops compiling
 * and the assignability test in this package's suite fails.
 */
export type ContainerHostAdapterLike = Pick<
  DockhandAdapter,
  "readHosts" | "applyHost" | "capabilities"
>;

/**
 * `connections.provider` value the Beszel reader accepts.
 *
 * The fleet design's schema sketch names both providers in one line —
 * `connections.provider = 'gatus' | 'beszel'` — and this is that value.
 */
export const BESZEL_CONNECTION_PROVIDER = "beszel";

/**
 * Registered credential purpose holding the Beszel hub login (ADR-0019).
 *
 * **The connection form must label this a readonly USER, not an API token.**
 * The design warned against the opposite dishonesty — *"A form field labelled
 * 'API token' over a superuser password is the kind of small dishonesty that
 * later gets someone to reuse a password"* — and the correction found while
 * building the adapter does not retire that warning, it redirects it: Beszel
 * has no token at all, and what Loxep stores is an email and a password for a
 * purpose-made readonly account.
 */
export const BESZEL_CREDENTIAL_TYPE = "beszel_credentials";

/** `connections.provider` value the Dockhand adapter accepts. */
export const DOCKHAND_CONNECTION_PROVIDER = "dockhand";

/**
 * Registered credential purpose holding the Dockhand login (ADR-0019).
 *
 * Dockhand publishes no API key — its API reference documents HTTP-only session
 * cookies and nothing else — so this is a real username/password, and the
 * account behind it should hold `environments:view`, `environments:edit`,
 * `containers:view`, and `stacks:view` and nothing more.
 */
export const DOCKHAND_CREDENTIAL_TYPE = "dockhand_credentials";

/**
 * `connections.provider` value the Gatus reader accepts.
 *
 * Verified against `packages/domain/src/bundles.ts`'s `gatus_credentials`
 * entry and `apps/web/src/server/admin-functions.ts`'s `createStoreConnection`
 * (its Gatus branch: `provider: data.service` where `service: z.literal('gatus')`).
 */
export const GATUS_CONNECTION_PROVIDER = "gatus";

/**
 * Registered credential purpose holding Gatus's OPTIONAL Basic-auth pair
 * (ADR-0009, loxep-ovj.4).
 *
 * **Unlike every other credential purpose in this file, this bundle may be
 * absent for a perfectly healthy connection.** `packages/domain/src/bundles.ts`'s
 * `gatus_credentials` schema is `{ username?, password? }` with a `.refine`
 * enforcing the pair present-together-or-absent-together — a legitimate Gatus
 * instance may run fully open (no `security` block) or OIDC-secured (no
 * bearer credential a server-to-server reader could hold at all). The five
 * fleet adapter factories below all resolve their credential inside the
 * build call; this is the one where "no stored credential" is success, not
 * {@link GatusCredentialsMissingError} — see `createGatusAdapterFactory`.
 */
export const GATUS_CREDENTIAL_TYPE = "gatus_credentials";

/**
 * `connections.provider` value the Tailscale reader accepts.
 *
 * Verified against `packages/domain/src/bundles.ts`'s `tailscale_credentials`
 * entry and `admin-functions.ts`'s Tailscale branch (`service: z.literal('tailscale')`).
 */
export const TAILSCALE_CONNECTION_PROVIDER = "tailscale";

/**
 * Registered credential purpose holding Tailscale's TWO credential modes
 * (ADR-0009, loxep-4su): `{mode:'api_access_token', apiAccessToken}` (Basic
 * auth, token as username, expires in an operator-chosen 1–90 days with no
 * auto-renewal) or `{mode:'oauth_client', clientId, clientSecret}` (RFC 6749
 * §4.4 client-credentials; the adapter mints and re-exchanges a one-hour
 * access token automatically). `packages/domain/src/bundles.ts`'s
 * `tailscale_credentials` is a `z.discriminatedUnion("mode", […])` matching
 * `@loxep/integration-tailscale`'s own `TailscaleCredentials` union field for
 * field, so the payload this file resolves needs no translation before it
 * reaches `createTailscaleAdapter` — see `createTailscaleAdapterFactory`.
 */
export const TAILSCALE_CREDENTIAL_TYPE = "tailscale_credentials";

/**
 * `connections.provider` value the Termix reader accepts.
 *
 * Verified against `packages/domain/src/bundles.ts`'s `termix_credentials`
 * entry and `admin-functions.ts`'s Termix branch (`service: z.literal('termix')`).
 */
export const TERMIX_CONNECTION_PROVIDER = "termix";

/**
 * Registered credential purpose holding the Termix login (ADR-0009,
 * loxep-g3f).
 *
 * Termix publishes no scoped read-only role (unlike Beszel's `readonly`
 * user) — this is a real Termix user account, and Loxep's restraint against
 * Termix's much larger write surface is enforced entirely in
 * `@loxep/integration-termix`'s own exported surface, never by anything this
 * login grants or withholds.
 */
export const TERMIX_CREDENTIAL_TYPE = "termix_credentials";

/**
 * Adapt a {@link DockhandAdapter} to `@loxep/infrastructure`'s
 * `ContainerHostProviderPort`.
 *
 * The two shapes are structurally compatible by design
 * (`container-host-port.ts`'s module doc: "re-declared structurally rather than
 * imported"), so this is a thin forward rather than a translation — but it is
 * written as explicit method calls, never destructured, so an adapter method
 * that calls a sibling through `this` keeps its binding.
 * `providerPortFromCloudflareAdapter` and
 * `mailProviderPortFromPurelymailAdapter` both learned that the same way.
 *
 * ## `read` forwards to `readHosts`, and the naming is deliberate
 *
 * The adapter exposes `listHosts` and `readHosts` as the same function under
 * two names: one reads as a fleet query, the other as the reconciler's read
 * half. This wrapper uses `readHosts`, so that the reconciler's call site says
 * what it is doing.
 *
 * ## What this wrapper structurally cannot forward
 *
 * There is no lifecycle member to forward, on either side. The port has
 * `read`/`apply`/`capabilities`; the adapter has no start, stop, exec, or
 * redeploy method at all (asserted in the integration package's
 * `forbidden-verbs.test.ts`). So the rule-13 boundary is not maintained by this
 * file's restraint — there is nothing here that could be widened without first
 * widening two other packages and failing their tests.
 *
 * ## `apply` narrows before it forwards
 *
 * The port's payload is deliberately provider-agnostic — `connectionType` is a
 * plain string there — while the adapter accepts only the connection types
 * Dockhand documents. The wrapper checks intent against the adapter's own
 * advertised `capabilities().connectionTypes` and refuses anything outside it,
 * so an unsupported value becomes a loud apply failure the reconciler records
 * instead of an unchecked cast crossing the boundary.
 */
export function containerHostPortFromDockhandAdapter(
  adapter: ContainerHostAdapterLike,
): ContainerHostProviderPort {
  return {
    read: (): Promise<ObservedContainerHost[]> => adapter.readHosts(),
    apply: (
      operation: ContainerHostOperation,
    ): Promise<ContainerHostApplyResult> => {
      if (operation.kind === "create" || operation.kind === "update") {
        const connectionType = operation.host.connectionType;
        const allowed: readonly string[] =
          adapter.capabilities().connectionTypes;
        if (
          connectionType !== undefined &&
          connectionType !== null &&
          !allowed.includes(connectionType)
        ) {
          throw new Error(
            `dockhand: connection type ${JSON.stringify(connectionType)} is not supported by this provider (supported: ${allowed.join(", ")})`,
          );
        }
      }
      return adapter.applyHost(operation as DockhandHostOperation);
    },
    capabilities: (): ContainerHostProviderCapabilities =>
      adapter.capabilities(),
  };
}

// =============================================================================
// Beszel — cached per-connection adapter factory (loxep-y64 slice 1)
// =============================================================================

/** Non-secret block on `connections.config` holding the hub's base URL. */
export const BESZEL_CONNECTION_CONFIG_KEY = "beszel";

/** Per-connection token-bucket defaults, matching the adapter package's own suggested default. */
export const BESZEL_RATE_BUDGET_CAPACITY = 8;
export const BESZEL_RATE_BUDGET_REFILL_PER_SECOND = 2;
/**
 * health.sweep's own base interval (300s — `BASE_PROBE_INTERVAL_SECONDS` in
 * `@loxep/domain`'s health-probes.ts). Beszel has no poll executor of its
 * own; this is the floor a future consumer of `minIntervalSeconds` would see,
 * not a value anything currently reads.
 */
export const BESZEL_ABSOLUTE_MIN_INTERVAL_SECONDS = 300;

/** The Beszel connection's readonly credential is missing, or its connection is misconfigured. */
export class BeszelCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface BeszelRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle a future connection health probe works with. */
export interface BeszelConnectionAdapter {
  connectionId: string;
  /** `<baseUrl>|<email>` — see `beszelSourceAccountKey`. */
  sourceAccountKey: string;
  adapter: BeszelAdapter;
  minIntervalSeconds: number;
}

export interface BeszelAdapterFactory {
  (connectionId: string): Promise<BeszelConnectionAdapter>;
}

/** How a provider client is constructed from resolved config + credential + budget. */
export type BeszelAdapterConstructor = (input: {
  baseUrl: string;
  credentials: { email: string; password: string };
  rateBudget: BeszelRateBudget;
  logger: JobsLogger | undefined;
}) => BeszelAdapter;

const defaultBeszelAdapterConstructor: BeszelAdapterConstructor = ({
  baseUrl,
  credentials,
  rateBudget,
  logger,
}) =>
  createBeszelAdapter({
    config: { baseUrl },
    credentials,
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateBeszelAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /** Override the token-bucket defaults (tests, deliberately gentle deployments). */
  rateBudget?: BeszelRateBudgetConfig;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: BeszelAdapterConstructor;
}

/**
 * Read the hub's base URL from `connections.config.beszel.baseUrl` — Beszel
 * is self-hosted, so this is required for the adapter to build at all (see
 * `@loxep/integration-beszel/config.ts`'s module doc). Exported so a
 * connection-management surface and this factory agree on its shape in one
 * place, the same reason `readCloudflareAccountId` is exported.
 */
export function readBeszelBaseUrl(config: Record<string, unknown>): string | null {
  const block = config[BESZEL_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const baseUrl = (block as Record<string, unknown>)["baseUrl"];
  return typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : null;
}

/**
 * Build the connection-scoped Beszel adapter factory.
 *
 * ## Caching is a CORRECTNESS constraint here, not an optimisation
 *
 * `createBeszelAdapter` caches a PocketBase auth token IN MEMORY, per adapter
 * instance (see that function's own module doc). health.sweep runs every
 * five minutes; a composition root that rebuilt the adapter on every sweep
 * would perform roughly 288 logins per day against Beszel's one authenticated
 * exchange, for a connection that changed nothing. So — unlike
 * `cloudflare.ts`'s TTL-based cache, which exists only to let an operator's
 * token rotation take effect without a restart — this cache carries **no
 * TTL**. It is dropped only by `invalidate()`, which is reserved for an
 * `auth`-class provider failure or an explicit operator "test connection"
 * action, never called in a retry loop by a probe. The rate budget still
 * lives OUTSIDE the adapter cache (the shared rule every factory in this file
 * follows): an `invalidate()`-triggered rebuild must not hand Beszel a fresh
 * full bucket even though it must mint a fresh login token.
 */
export function createBeszelAdapterFactory(
  options: CreateBeszelAdapterFactoryOptions,
): {
  getAdapterForConnection: BeszelAdapterFactory;
  invalidate: (connectionId: string) => void;
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultBeszelAdapterConstructor;
  const budgetConfig = options.rateBudget ?? {
    capacity: BESZEL_RATE_BUDGET_CAPACITY,
    refillPerSecond: BESZEL_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds = BESZEL_ABSOLUTE_MIN_INTERVAL_SECONDS;

  // Outlives the adapter cache on purpose (see the module/function doc): a
  // rebuild after invalidate() must not hand Beszel a fresh full bucket.
  const budgets = new Map<string, BeszelRateBudget>();
  // No TTL — see the function doc. Only invalidate() drops an entry.
  const cache = new Map<string, BeszelConnectionAdapter>();
  // One in-flight build per connection: concurrent callers must not each run
  // the credential-decryption path (and, here, each attempt a login).
  const inFlight = new Map<string, Promise<BeszelConnectionAdapter>>();

  function budgetFor(connectionId: string): BeszelRateBudget {
    const existing = budgets.get(connectionId);
    if (existing !== undefined) return existing;
    const budget = createBeszelRateBudget({
      capacity: budgetConfig.capacity,
      refillPerSecond: budgetConfig.refillPerSecond,
      ...(logger !== undefined ? { logger } : {}),
    });
    budgets.set(connectionId, budget);
    return budget;
  }

  function invalidate(connectionId: string): void {
    cache.delete(connectionId);
  }

  async function build(connectionId: string): Promise<BeszelConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== BESZEL_CONNECTION_PROVIDER) {
      throw new BeszelCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the Beszel reader needs a "${BESZEL_CONNECTION_PROVIDER}" connection`,
      );
    }
    const baseUrl = readBeszelBaseUrl(connection.config);
    if (baseUrl === null) {
      throw new BeszelCredentialsMissingError(
        `connection ${connectionId} has no "${BESZEL_CONNECTION_CONFIG_KEY}.baseUrl" in its config; Beszel is self-hosted and needs an explicit hub URL`,
      );
    }

    // Resolved HERE, inside the build path, on every cache miss — never in a
    // job payload (Configuration & Secrets rule 5).
    let payload: { email: string; password: string };
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        BESZEL_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new BeszelCredentialsMissingError(
        `connection ${connectionId} has no stored "${BESZEL_CREDENTIAL_TYPE}" credential; add a Beszel readonly user before reading fleet status`,
        { cause: error },
      );
    }

    const adapter = constructAdapter({
      baseUrl,
      credentials: payload,
      rateBudget: budgetFor(connectionId),
      logger,
    });

    const resolved: BeszelConnectionAdapter = {
      connectionId,
      sourceAccountKey: beszelSourceAccountKey(baseUrl, payload.email),
      adapter,
      minIntervalSeconds: intervalFloorSeconds,
    };
    cache.set(connectionId, resolved);
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<BeszelConnectionAdapter> {
    const cached = cache.get(connectionId);
    if (cached !== undefined) return cached;
    let pending = inFlight.get(connectionId);
    if (pending === undefined) {
      pending = build(connectionId).finally(() => {
        inFlight.delete(connectionId);
      });
      inFlight.set(connectionId, pending);
    }
    return pending;
  }

  return { getAdapterForConnection, invalidate, intervalFloorSeconds };
}

// =============================================================================
// Dockhand — cached per-connection READ adapter factory (loxep-hb7 slice 1)
// =============================================================================

/** Non-secret block on `connections.config` holding the instance's base URL. */
export const DOCKHAND_CONNECTION_CONFIG_KEY = "dockhand";

/** Per-connection token-bucket defaults, matching the adapter package's own suggested default. */
export const DOCKHAND_RATE_BUDGET_CAPACITY = 8;
export const DOCKHAND_RATE_BUDGET_REFILL_PER_SECOND = 2;
/** health.sweep's own base interval — see `BESZEL_ABSOLUTE_MIN_INTERVAL_SECONDS`'s doc; the same reasoning applies. */
export const DOCKHAND_ABSOLUTE_MIN_INTERVAL_SECONDS = 300;

/** The Dockhand connection's login is missing, or its connection is misconfigured. */
export class DockhandCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface DockhandRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle a future connection health probe works with. */
export interface DockhandConnectionAdapter {
  connectionId: string;
  /** `<baseUrl>|<username>` — see `dockhandSourceAccountKey`. */
  sourceAccountKey: string;
  adapter: DockhandAdapter;
  minIntervalSeconds: number;
}

export interface DockhandAdapterFactory {
  (connectionId: string): Promise<DockhandConnectionAdapter>;
}

/** How a provider client is constructed from resolved config + credential + budget. */
export type DockhandAdapterConstructor = (input: {
  baseUrl: string;
  credentials: { username: string; password: string };
  rateBudget: DockhandRateBudget;
  logger: JobsLogger | undefined;
}) => DockhandAdapter;

const defaultDockhandAdapterConstructor: DockhandAdapterConstructor = ({
  baseUrl,
  credentials,
  rateBudget,
  logger,
}) =>
  createDockhandAdapter({
    config: { baseUrl },
    credentials,
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateDockhandAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /** Override the token-bucket defaults (tests, deliberately gentle deployments). */
  rateBudget?: DockhandRateBudgetConfig;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: DockhandAdapterConstructor;
}

/**
 * Read the instance's base URL from `connections.config.dockhand.baseUrl` —
 * Dockhand is self-hosted, so this is required (see
 * `@loxep/integration-dockhand/config.ts`'s module doc). Exported for the
 * same reason `readBeszelBaseUrl` is.
 */
export function readDockhandBaseUrl(config: Record<string, unknown>): string | null {
  const block = config[DOCKHAND_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const baseUrl = (block as Record<string, unknown>)["baseUrl"];
  return typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : null;
}

/**
 * Build the connection-scoped Dockhand READ adapter factory.
 *
 * This is the factory a future connection health probe (`probeSession` then
 * `listHosts`, per loxep-hb7 §1.1) builds on. It is separate from
 * {@link containerHostPortFromDockhandAdapter} above, which wraps the SAME
 * kind of `DockhandAdapter` into the reconciler's read/apply port for the
 * (not yet wired) host-intent leg — one adapter, two different consumers.
 *
 * ## Caching is a correctness constraint, for the same reason as Beszel's
 *
 * `createDockhandAdapter` caches its session cookie IN MEMORY per instance,
 * and Dockhand documents an account lockout after five failed logins per
 * IP/username, with an exponential 5–60s backoff. Rebuilding the adapter on
 * a TTL that lines up with health.sweep's five-minute cadence would force a
 * fresh login almost every cycle, spending toward that lockout for no
 * benefit. So — like Beszel, and unlike this file's Cloudflare/Gatus-style
 * factories — this cache carries **no TTL**; only `invalidate()` (an
 * `auth`-class failure or an explicit operator "test connection" action)
 * forces a rebuild. The adapter itself already bounds re-auth to exactly one
 * retry and charges its login exchange `DOCKHAND_LOGIN_COST` (4 of an
 * 8-token burst) — this factory adds no second retry or backoff mechanism on
 * top of either. The sweep's own 300s→3600s backoff (`nextHealthCheckDueAt`
 * in `@loxep/domain`) IS Dockhand's lockout protection; nothing here
 * duplicates it.
 */
export function createDockhandAdapterFactory(
  options: CreateDockhandAdapterFactoryOptions,
): {
  getAdapterForConnection: DockhandAdapterFactory;
  invalidate: (connectionId: string) => void;
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultDockhandAdapterConstructor;
  const budgetConfig = options.rateBudget ?? {
    capacity: DOCKHAND_RATE_BUDGET_CAPACITY,
    refillPerSecond: DOCKHAND_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds = DOCKHAND_ABSOLUTE_MIN_INTERVAL_SECONDS;

  const budgets = new Map<string, DockhandRateBudget>();
  const cache = new Map<string, DockhandConnectionAdapter>();
  const inFlight = new Map<string, Promise<DockhandConnectionAdapter>>();

  function budgetFor(connectionId: string): DockhandRateBudget {
    const existing = budgets.get(connectionId);
    if (existing !== undefined) return existing;
    const budget = createDockhandRateBudget({
      capacity: budgetConfig.capacity,
      refillPerSecond: budgetConfig.refillPerSecond,
      ...(logger !== undefined ? { logger } : {}),
    });
    budgets.set(connectionId, budget);
    return budget;
  }

  function invalidate(connectionId: string): void {
    cache.delete(connectionId);
  }

  async function build(connectionId: string): Promise<DockhandConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== DOCKHAND_CONNECTION_PROVIDER) {
      throw new DockhandCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the Dockhand reader needs a "${DOCKHAND_CONNECTION_PROVIDER}" connection`,
      );
    }
    const baseUrl = readDockhandBaseUrl(connection.config);
    if (baseUrl === null) {
      throw new DockhandCredentialsMissingError(
        `connection ${connectionId} has no "${DOCKHAND_CONNECTION_CONFIG_KEY}.baseUrl" in its config; Dockhand is self-hosted and needs an explicit instance URL`,
      );
    }

    let payload: { username: string; password: string };
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        DOCKHAND_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new DockhandCredentialsMissingError(
        `connection ${connectionId} has no stored "${DOCKHAND_CREDENTIAL_TYPE}" credential; add a Dockhand login before reading fleet status`,
        { cause: error },
      );
    }

    const adapter = constructAdapter({
      baseUrl,
      credentials: payload,
      rateBudget: budgetFor(connectionId),
      logger,
    });

    const resolved: DockhandConnectionAdapter = {
      connectionId,
      sourceAccountKey: dockhandSourceAccountKey(baseUrl, payload.username),
      adapter,
      minIntervalSeconds: intervalFloorSeconds,
    };
    cache.set(connectionId, resolved);
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<DockhandConnectionAdapter> {
    const cached = cache.get(connectionId);
    if (cached !== undefined) return cached;
    let pending = inFlight.get(connectionId);
    if (pending === undefined) {
      pending = build(connectionId).finally(() => {
        inFlight.delete(connectionId);
      });
      inFlight.set(connectionId, pending);
    }
    return pending;
  }

  return { getAdapterForConnection, invalidate, intervalFloorSeconds };
}

// =============================================================================
// Gatus — cached per-connection adapter factory (loxep-1au slice A)
// =============================================================================

/** Non-secret block on `connections.config` holding the instance's base URL. */
export const GATUS_CONNECTION_CONFIG_KEY = "gatus";

/** Per-connection token-bucket defaults, matching the adapter package's own suggested default. */
export const GATUS_RATE_BUDGET_CAPACITY = 10;
export const GATUS_RATE_BUDGET_REFILL_PER_SECOND = 2;
/** health.sweep's own base interval — see `BESZEL_ABSOLUTE_MIN_INTERVAL_SECONDS`'s doc; the same reasoning applies. */
export const GATUS_ABSOLUTE_MIN_INTERVAL_SECONDS = 300;
/** How long a built adapter is reused before it is rebuilt from storage — see the function doc for why Gatus can afford a TTL where Beszel/Dockhand/Termix cannot. */
export const GATUS_ADAPTER_CACHE_TTL_MS = 300_000;

/** The Gatus connection is misconfigured (wrong provider, or no base URL). */
export class GatusCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface GatusRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle a future connection health probe works with. */
export interface GatusConnectionAdapter {
  connectionId: string;
  /** The normalized base URL alone — see `gatusSourceAccountKey`'s doc for why. */
  sourceAccountKey: string;
  adapter: GatusAdapter;
  minIntervalSeconds: number;
}

export interface GatusAdapterFactory {
  (connectionId: string): Promise<GatusConnectionAdapter>;
}

/** How a provider client is constructed from resolved config + an OPTIONAL credential + budget. */
export type GatusAdapterConstructor = (input: {
  baseUrl: string;
  /** OMITTED entirely when no credential is stored — never an empty pair. */
  credentials: { username: string; password: string } | undefined;
  rateBudget: GatusRateBudget;
  logger: JobsLogger | undefined;
}) => GatusAdapter;

const defaultGatusAdapterConstructor: GatusAdapterConstructor = ({
  baseUrl,
  credentials,
  rateBudget,
  logger,
}) =>
  createGatusAdapter({
    config: { baseUrl },
    ...(credentials !== undefined ? { credentials } : {}),
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateGatusAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /**
   * Override the token-bucket defaults (tests, deliberately gentle
   * deployments). An explicit value WINS over {@link resolveRateBudget}.
   */
  rateBudget?: GatusRateBudgetConfig;
  /**
   * Read the budget from the registered `integration.gatus.rate_budget`
   * setting (`gatusRateBudgetSetting` in `@loxep/domain`) at adapter-build
   * time — Gatus is the one fleet provider with a REGISTERED setting to
   * read, unlike Beszel/Dockhand/Tailscale/Termix, which have no
   * `integration.<provider>.rate_budget` setting yet and follow the
   * Cloudflare/Purelymail/Reverb precedent of a documented default with only
   * an explicit override. Consulted only when `rateBudget` is absent; a
   * failure falls back to the documented defaults rather than taking the
   * sweep down.
   */
  resolveRateBudget?: () => Promise<GatusRateBudgetConfig>;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: GatusAdapterConstructor;
}

/**
 * Read the instance's base URL from `connections.config.gatus.baseUrl` —
 * Gatus is self-hosted, so this is required. Verified against
 * `apps/web/src/server/admin-functions.ts`'s `createStoreConnection` Gatus
 * branch (`config = { gatus: { baseUrl: data.baseUrl… } }`).
 */
export function readGatusBaseUrl(config: Record<string, unknown>): string | null {
  const block = config[GATUS_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const baseUrl = (block as Record<string, unknown>)["baseUrl"];
  return typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : null;
}

/**
 * Resolve the OPTIONAL `gatus_credentials` bundle. Returns `undefined` — not
 * a half-empty pair — both when no credential row exists at all (an open or
 * OIDC-secured Gatus, the normal case for those postures) and, defensively,
 * for a stored row whose zod-atomic pair is somehow absent on both sides.
 * `createGatusAdapter` throws `invalid_request` on `{username: '', password: ''}`
 * or any half-empty pair, so this function never constructs one.
 */
async function resolveGatusCredentials(
  connectionCredentials: ConnectionCredentialsService,
  connectionId: string,
): Promise<{ username: string; password: string } | undefined> {
  let payload: { username?: string; password?: string };
  try {
    const credential = await connectionCredentials.getCredentialPayload(
      connectionId,
      GATUS_CREDENTIAL_TYPE,
    );
    payload = credential.payload;
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error;
    return undefined;
  }
  if (payload.username === undefined || payload.password === undefined) {
    return undefined;
  }
  return { username: payload.username, password: payload.password };
}

interface GatusCacheEntry {
  adapter: GatusConnectionAdapter;
  expiresAtMs: number;
  budgetConfig: GatusRateBudgetConfig;
}

/**
 * Build the connection-scoped Gatus adapter factory.
 *
 * ## Caching here is for the RATE BUDGET only — say this so it is not confused with Beszel's
 *
 * Unlike Beszel/Dockhand/Termix, Gatus has NO login exchange
 * (`@loxep/integration-gatus`'s own errors.ts: "there is no login response to
 * guard against"), so a rebuilt adapter costs no auth round-trip whatsoever —
 * a later reader comparing this factory to `createBeszelAdapterFactory` must
 * not conclude Gatus caches a token; it does not. What a rebuild WOULD throw
 * away is the token bucket `createRateBudget` returns, so the adapter is
 * still cached per connection with the budget held outside the cache, on the
 * same TTL-based `cloudflare.ts` shape this file's Beszel/Dockhand/Termix
 * factories deliberately do NOT use — see this file's module doc for why the
 * split exists.
 */
export function createGatusAdapterFactory(
  options: CreateGatusAdapterFactoryOptions,
): {
  getAdapterForConnection: GatusAdapterFactory;
  invalidate: (connectionId: string) => void;
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultGatusAdapterConstructor;
  const staticBudgetConfig = options.rateBudget ?? {
    capacity: GATUS_RATE_BUDGET_CAPACITY,
    refillPerSecond: GATUS_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds = GATUS_ABSOLUTE_MIN_INTERVAL_SECONDS;

  const budgets = new Map<
    string,
    { budget: GatusRateBudget; config: GatusRateBudgetConfig }
  >();
  const cache = new Map<string, GatusCacheEntry>();
  const inFlight = new Map<string, Promise<GatusConnectionAdapter>>();

  async function resolveBudgetConfig(): Promise<GatusRateBudgetConfig> {
    if (
      options.rateBudget !== undefined ||
      options.resolveRateBudget === undefined
    ) {
      return staticBudgetConfig;
    }
    try {
      return await options.resolveRateBudget();
    } catch (error) {
      logger?.error(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to read the Gatus rate-budget setting; using the documented defaults",
      );
      return staticBudgetConfig;
    }
  }

  function budgetFor(
    connectionId: string,
    config: GatusRateBudgetConfig,
  ): GatusRateBudget {
    const existing = budgets.get(connectionId);
    if (
      existing !== undefined &&
      existing.config.capacity === config.capacity &&
      existing.config.refillPerSecond === config.refillPerSecond
    ) {
      return existing.budget;
    }
    if (existing !== undefined) {
      logger?.info(
        { connectionId, ...config },
        "Gatus rate budget reconfigured; replacing the connection's token bucket",
      );
    }
    const budget = createGatusRateBudget({
      capacity: config.capacity,
      refillPerSecond: config.refillPerSecond,
      ...(logger !== undefined ? { logger } : {}),
    });
    budgets.set(connectionId, { budget, config });
    return budget;
  }

  function invalidate(connectionId: string): void {
    cache.delete(connectionId);
  }

  async function build(
    connectionId: string,
    budgetConfig: GatusRateBudgetConfig,
  ): Promise<GatusConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== GATUS_CONNECTION_PROVIDER) {
      throw new GatusCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the Gatus reader needs a "${GATUS_CONNECTION_PROVIDER}" connection`,
      );
    }
    const baseUrl = readGatusBaseUrl(connection.config);
    if (baseUrl === null) {
      throw new GatusCredentialsMissingError(
        `connection ${connectionId} has no "${GATUS_CONNECTION_CONFIG_KEY}.baseUrl" in its config; Gatus is self-hosted and needs an explicit instance URL`,
      );
    }
    const credentials = await resolveGatusCredentials(
      connectionCredentials,
      connectionId,
    );

    const budget = budgetFor(connectionId, budgetConfig);
    const adapter = constructAdapter({ baseUrl, credentials, rateBudget: budget, logger });

    const resolved: GatusConnectionAdapter = {
      connectionId,
      sourceAccountKey: gatusSourceAccountKey(baseUrl),
      adapter,
      minIntervalSeconds: intervalFloorSeconds,
    };
    cache.set(connectionId, {
      adapter: resolved,
      expiresAtMs: Date.now() + GATUS_ADAPTER_CACHE_TTL_MS,
      budgetConfig,
    });
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<GatusConnectionAdapter> {
    const budgetConfig = await resolveBudgetConfig();
    const cached = cache.get(connectionId);
    if (
      cached !== undefined &&
      Date.now() < cached.expiresAtMs &&
      cached.budgetConfig.capacity === budgetConfig.capacity &&
      cached.budgetConfig.refillPerSecond === budgetConfig.refillPerSecond
    ) {
      return cached.adapter;
    }
    cache.delete(connectionId);
    let pending = inFlight.get(connectionId);
    if (pending === undefined) {
      pending = build(connectionId, budgetConfig).finally(() => {
        inFlight.delete(connectionId);
      });
      inFlight.set(connectionId, pending);
    }
    return pending;
  }

  return { getAdapterForConnection, invalidate, intervalFloorSeconds };
}

// =============================================================================
// Tailscale — cached per-connection adapter factory (loxep-50t slice A)
// =============================================================================

/** Non-secret block on `connections.config` holding the tailnet name (and, optionally, a control-plane base URL). */
export const TAILSCALE_CONNECTION_CONFIG_KEY = "tailscale";

/** Per-connection token-bucket defaults, matching the adapter package's own suggested default. */
export const TAILSCALE_RATE_BUDGET_CAPACITY = 8;
export const TAILSCALE_RATE_BUDGET_REFILL_PER_SECOND = 2;
/** health.sweep's own base interval — see `BESZEL_ABSOLUTE_MIN_INTERVAL_SECONDS`'s doc; the same reasoning applies. */
export const TAILSCALE_ABSOLUTE_MIN_INTERVAL_SECONDS = 300;

/** The Tailscale connection's credential is missing, or its connection is misconfigured. */
export class TailscaleCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface TailscaleRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle a future connection health probe works with. */
export interface TailscaleConnectionAdapter {
  connectionId: string;
  /** `<baseUrl>|<tailnet>` — see `tailscaleSourceAccountKey`. */
  sourceAccountKey: string;
  adapter: TailscaleAdapter;
  minIntervalSeconds: number;
}

export interface TailscaleAdapterFactory {
  (connectionId: string): Promise<TailscaleConnectionAdapter>;
}

/** How a provider client is constructed from resolved config + EITHER credential mode + budget. */
export type TailscaleAdapterConstructor = (input: {
  tailnet: string | undefined;
  baseUrl: string;
  credentials: TailscaleCredentials;
  rateBudget: TailscaleRateBudget;
  logger: JobsLogger | undefined;
}) => TailscaleAdapter;

const defaultTailscaleAdapterConstructor: TailscaleAdapterConstructor = ({
  tailnet,
  baseUrl,
  credentials,
  rateBudget,
  logger,
}) =>
  createTailscaleAdapter({
    config: { ...(tailnet !== undefined ? { tailnet } : {}), baseUrl },
    credentials,
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateTailscaleAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /** Override the token-bucket defaults (tests, deliberately gentle deployments). */
  rateBudget?: TailscaleRateBudgetConfig;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: TailscaleAdapterConstructor;
}

/**
 * Read the tailnet name from `connections.config.tailscale.tailnet`. Verified
 * against `apps/web/src/server/admin-functions.ts`'s `createStoreConnection`
 * Tailscale branch: `config = data.tailnet === undefined ? {} : { tailscale:
 * { tailnet: data.tailnet } }` — `tailnet` is OPTIONAL there (the form leaves
 * it blank to mean Tailscale's own "default tailnet of this token" shorthand,
 * `-`), so `null` here is a legitimate value, not a misconfiguration:
 * `createTailscaleAdapter`'s own config schema defaults an omitted `tailnet`
 * to `TAILSCALE_DEFAULT_TAILNET` (`"-"`).
 */
export function readTailscaleTailnet(config: Record<string, unknown>): string | null {
  const block = config[TAILSCALE_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const tailnet = (block as Record<string, unknown>)["tailnet"];
  return typeof tailnet === "string" && tailnet !== "" ? tailnet : null;
}

/**
 * Read an OPTIONAL control-plane base URL from
 * `connections.config.tailscale.baseUrl`. Nothing writes this key today
 * (`admin-functions.ts`'s Tailscale branch only ever sets `tailnet`) — every
 * connection therefore resolves to `TAILSCALE_DEFAULT_BASE_URL`
 * (`https://api.tailscale.com`) in practice. The reader exists so an
 * enterprise/self-hosted-control-plane deployment (which
 * `tailscaleAdapterConfigSchema` already supports) has somewhere to land
 * without a second factory change.
 */
export function readTailscaleBaseUrl(config: Record<string, unknown>): string | null {
  const block = config[TAILSCALE_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const baseUrl = (block as Record<string, unknown>)["baseUrl"];
  return typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : null;
}

/**
 * Build the connection-scoped Tailscale adapter factory.
 *
 * Supports BOTH credential modes the `tailscale_credentials` bundle already
 * carries (see {@link TAILSCALE_CREDENTIAL_TYPE}'s doc) — the payload is
 * passed straight through to `createTailscaleAdapter`, which branches on
 * `credentials.mode` itself.
 *
 * ## Caching, and why this sits with Beszel/Dockhand/Termix rather than Gatus
 *
 * An `oauth_client`-mode adapter mints and caches a one-hour access token IN
 * MEMORY, re-exchanging it automatically. A TTL-driven rebuild would throw
 * that token away before its natural expiry for no correctness benefit — the
 * same class of waste `createBeszelAdapterFactory`/`createDockhandAdapterFactory`
 * document, even though Tailscale publishes no login-attempt limiter to make
 * it a lockout risk. An `api_access_token`-mode adapter has no such state to
 * lose, but one factory serves both credential modes and must not treat them
 * differently. So this cache carries **no TTL**: only `invalidate()` (an
 * `auth`-class failure — including, per loxep-50t, a stale API access token —
 * or an explicit operator "test connection" action) forces a rebuild.
 */
export function createTailscaleAdapterFactory(
  options: CreateTailscaleAdapterFactoryOptions,
): {
  getAdapterForConnection: TailscaleAdapterFactory;
  invalidate: (connectionId: string) => void;
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultTailscaleAdapterConstructor;
  const budgetConfig = options.rateBudget ?? {
    capacity: TAILSCALE_RATE_BUDGET_CAPACITY,
    refillPerSecond: TAILSCALE_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds = TAILSCALE_ABSOLUTE_MIN_INTERVAL_SECONDS;

  const budgets = new Map<string, TailscaleRateBudget>();
  const cache = new Map<string, TailscaleConnectionAdapter>();
  const inFlight = new Map<string, Promise<TailscaleConnectionAdapter>>();

  function budgetFor(connectionId: string): TailscaleRateBudget {
    const existing = budgets.get(connectionId);
    if (existing !== undefined) return existing;
    const budget = createTailscaleRateBudget({
      capacity: budgetConfig.capacity,
      refillPerSecond: budgetConfig.refillPerSecond,
      ...(logger !== undefined ? { logger } : {}),
    });
    budgets.set(connectionId, budget);
    return budget;
  }

  function invalidate(connectionId: string): void {
    cache.delete(connectionId);
  }

  async function build(connectionId: string): Promise<TailscaleConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== TAILSCALE_CONNECTION_PROVIDER) {
      throw new TailscaleCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the Tailscale reader needs a "${TAILSCALE_CONNECTION_PROVIDER}" connection`,
      );
    }
    const tailnet = readTailscaleTailnet(connection.config);
    const baseUrl = readTailscaleBaseUrl(connection.config) ?? TAILSCALE_DEFAULT_BASE_URL;

    let payload: TailscaleCredentials;
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        TAILSCALE_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new TailscaleCredentialsMissingError(
        `connection ${connectionId} has no stored "${TAILSCALE_CREDENTIAL_TYPE}" credential; add a Tailscale API access token or OAuth client before reading tailnet devices`,
        { cause: error },
      );
    }

    const adapter = constructAdapter({
      tailnet: tailnet ?? undefined,
      baseUrl,
      credentials: payload,
      rateBudget: budgetFor(connectionId),
      logger,
    });

    const resolved: TailscaleConnectionAdapter = {
      connectionId,
      sourceAccountKey: tailscaleSourceAccountKey(
        baseUrl,
        tailnet ?? TAILSCALE_DEFAULT_TAILNET,
      ),
      adapter,
      minIntervalSeconds: intervalFloorSeconds,
    };
    cache.set(connectionId, resolved);
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<TailscaleConnectionAdapter> {
    const cached = cache.get(connectionId);
    if (cached !== undefined) return cached;
    let pending = inFlight.get(connectionId);
    if (pending === undefined) {
      pending = build(connectionId).finally(() => {
        inFlight.delete(connectionId);
      });
      inFlight.set(connectionId, pending);
    }
    return pending;
  }

  return { getAdapterForConnection, invalidate, intervalFloorSeconds };
}

// =============================================================================
// Termix — cached per-connection adapter factory (loxep-wvm slice A)
// =============================================================================

/** Non-secret block on `connections.config` holding the instance's base URL. */
export const TERMIX_CONNECTION_CONFIG_KEY = "termix";

/** Per-connection token-bucket defaults, matching the adapter package's own suggested default. */
export const TERMIX_RATE_BUDGET_CAPACITY = 8;
export const TERMIX_RATE_BUDGET_REFILL_PER_SECOND = 2;
/** health.sweep's own base interval — see `BESZEL_ABSOLUTE_MIN_INTERVAL_SECONDS`'s doc; the same reasoning applies. */
export const TERMIX_ABSOLUTE_MIN_INTERVAL_SECONDS = 300;

/** The Termix connection's login is missing, or its connection is misconfigured. */
export class TermixCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface TermixRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle a future connection health probe works with. */
export interface TermixConnectionAdapter {
  connectionId: string;
  /** `<baseUrl>|<username>` — see `termixSourceAccountKey`. */
  sourceAccountKey: string;
  adapter: TermixAdapter;
  minIntervalSeconds: number;
}

export interface TermixAdapterFactory {
  (connectionId: string): Promise<TermixConnectionAdapter>;
}

/** How a provider client is constructed from resolved config + credential + budget. */
export type TermixAdapterConstructor = (input: {
  baseUrl: string;
  credentials: { username: string; password: string };
  rateBudget: TermixRateBudget;
  logger: JobsLogger | undefined;
}) => TermixAdapter;

const defaultTermixAdapterConstructor: TermixAdapterConstructor = ({
  baseUrl,
  credentials,
  rateBudget,
  logger,
}) =>
  createTermixAdapter({
    config: { baseUrl },
    credentials,
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateTermixAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /** Override the token-bucket defaults (tests, deliberately gentle deployments). */
  rateBudget?: TermixRateBudgetConfig;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: TermixAdapterConstructor;
}

/**
 * Read the instance's base URL from `connections.config.termix.baseUrl` —
 * Termix is self-hosted, so this is required. Verified against
 * `apps/web/src/server/admin-functions.ts`'s `createStoreConnection` Termix
 * branch (`config = { termix: { baseUrl: data.baseUrl… } }`).
 */
export function readTermixBaseUrl(config: Record<string, unknown>): string | null {
  const block = config[TERMIX_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const baseUrl = (block as Record<string, unknown>)["baseUrl"];
  return typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : null;
}

/**
 * Build the connection-scoped Termix adapter factory.
 *
 * ## The strongest instance of the caching-as-correctness argument in this file
 *
 * `POST /users/login` is the ONE route Termix's own OpenAPI document
 * publishes a 429 on ("Too many login attempts."), with no numeric
 * threshold, no lockout duration, and no stated IP-vs-account scope — a
 * ceiling that is honestly unknown rather than merely undocumented (see
 * loxep-wvm §2.2(e)). `createTermixAdapter` caches its bearer JWT IN MEMORY
 * for the life of the adapter instance and bounds re-auth to exactly one
 * retry per call. Matching Beszel/Dockhand and for a sharper reason than
 * either, this cache carries **no TTL**: only `invalidate()` (an
 * `auth`-class failure or an explicit operator "test connection" action)
 * forces a rebuild, which is what keeps the probe's ceiling of "at most one
 * login per connection per sweep" — and typically far fewer, since a token
 * survives across many sweeps — actually true rather than aspirational.
 */
export function createTermixAdapterFactory(
  options: CreateTermixAdapterFactoryOptions,
): {
  getAdapterForConnection: TermixAdapterFactory;
  invalidate: (connectionId: string) => void;
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultTermixAdapterConstructor;
  const budgetConfig = options.rateBudget ?? {
    capacity: TERMIX_RATE_BUDGET_CAPACITY,
    refillPerSecond: TERMIX_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds = TERMIX_ABSOLUTE_MIN_INTERVAL_SECONDS;

  const budgets = new Map<string, TermixRateBudget>();
  const cache = new Map<string, TermixConnectionAdapter>();
  const inFlight = new Map<string, Promise<TermixConnectionAdapter>>();

  function budgetFor(connectionId: string): TermixRateBudget {
    const existing = budgets.get(connectionId);
    if (existing !== undefined) return existing;
    const budget = createTermixRateBudget({
      capacity: budgetConfig.capacity,
      refillPerSecond: budgetConfig.refillPerSecond,
      ...(logger !== undefined ? { logger } : {}),
    });
    budgets.set(connectionId, budget);
    return budget;
  }

  function invalidate(connectionId: string): void {
    cache.delete(connectionId);
  }

  async function build(connectionId: string): Promise<TermixConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== TERMIX_CONNECTION_PROVIDER) {
      throw new TermixCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the Termix reader needs a "${TERMIX_CONNECTION_PROVIDER}" connection`,
      );
    }
    const baseUrl = readTermixBaseUrl(connection.config);
    if (baseUrl === null) {
      throw new TermixCredentialsMissingError(
        `connection ${connectionId} has no "${TERMIX_CONNECTION_CONFIG_KEY}.baseUrl" in its config; Termix is self-hosted and needs an explicit instance URL`,
      );
    }

    let payload: { username: string; password: string };
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        TERMIX_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new TermixCredentialsMissingError(
        `connection ${connectionId} has no stored "${TERMIX_CREDENTIAL_TYPE}" credential; add a Termix login before reading fleet status`,
        { cause: error },
      );
    }

    const adapter = constructAdapter({
      baseUrl,
      credentials: payload,
      rateBudget: budgetFor(connectionId),
      logger,
    });

    const resolved: TermixConnectionAdapter = {
      connectionId,
      sourceAccountKey: termixSourceAccountKey(baseUrl, payload.username),
      adapter,
      minIntervalSeconds: intervalFloorSeconds,
    };
    cache.set(connectionId, resolved);
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<TermixConnectionAdapter> {
    const cached = cache.get(connectionId);
    if (cached !== undefined) return cached;
    let pending = inFlight.get(connectionId);
    if (pending === undefined) {
      pending = build(connectionId).finally(() => {
        inFlight.delete(connectionId);
      });
      inFlight.set(connectionId, pending);
    }
    return pending;
  }

  return { getAdapterForConnection, invalidate, intervalFloorSeconds };
}
