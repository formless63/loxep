/**
 * The fleet-aware `connection` health-subject registry (loxep-rf4 shared
 * slice, extended per-provider by loxep-hb7/loxep-y64/loxep-1au/loxep-50t/
 * loxep-wvm). This is the seam `fleet.ts`'s module doc promises: "Still not
 * here: the connection HEALTH PROBES and the composed sweep registry."
 *
 * `@loxep/domain` takes no integration-package dependency, so
 * `createDefaultHealthSubjectRegistry` cannot host a Beszel/Dockhand/Gatus/
 * Tailscale/Termix probe. {@link createFleetHealthSubjectRegistry} composes a
 * registry whose `connection` entry DISPATCHES PER ROW: the five fleet
 * providers get a provider-specific adapter read (`source: 'adapter'`);
 * every other provider falls through to `@loxep/domain`'s own derived
 * `probeConnection` (`source: 'probe'`, unchanged). `notification_endpoint`
 * and `storage_backend` are carried through verbatim from the default
 * registry. `createDefaultHealthSubjectRegistry()` itself is never modified —
 * this module only wraps its `connection` entry — so its own standalone tests
 * stay green untouched.
 *
 * `packages/app/src/health-sweep.ts` is the only caller: it builds this
 * registry once and passes it to `runHealthSweep({ registry })`.
 *
 * ## Rules shared across all five probes, and why they are law here
 *
 * **A connection probe proves the CREDENTIAL, not merely reachability.**
 * Every probe below distinguishes "Loxep could not reach this instance"
 * (`unknown`) from "this instance rejected Loxep" (`failing`). Unreachable is
 * NEVER `failing` — these hubs live on private networks and tunnels, and a
 * topology problem must not render as a fleet outage.
 *
 * **`detail` carries counts and short labels only.** `guardHealthDetail`
 * (called by `HealthService.upsertHealth`, not duplicated here) REJECTS —
 * does not redact — a detail carrying a key named body/headers/response/
 * payload/html; a violation is a test-time failure, not a runtime nicety.
 * Nothing below puts a host name, an IP, a username, a URL, an error body, or
 * a provider message string in a detail.
 *
 * **`connections.last_success_at`/`last_error_at`/`last_error_code` are
 * stamped by these probes, and this is the retirement of the permanent
 * `unknown (never_succeeded)` rf4's own audit found.** For a provider with NO
 * poll executor — all five of these — the health probe is the SOLE writer of
 * those three columns; for a provider WITH a poll executor (ebay/woo/etsy/
 * reverb/cloudflare), the probe must NEVER touch them, because sync
 * freshness is the real signal there and a probe would mask a three-day-stale
 * sync behind a green tick. That asymmetry is why this module writes them and
 * the non-fleet fallback branch (unchanged, `@loxep/domain`'s own
 * `probeConnection`) does not. {@link recordConnectionOutcome} is the single
 * place that write happens: `ok`/`degraded` record a SUCCESS (both mean "the
 * credential was accepted and the read worked" — `degraded` is a proactive
 * warning about a future or partial problem, e.g. an expiring Tailscale token
 * or Termix's own rate limiter, never a rejected credential or a failed
 * contact), `failing`/`unknown` record a FAILURE with `errorCode` derived
 * from `detail.kind`. This mirrors the existing binary success/exception
 * split every poll executor in this package already uses
 * (`poll-executor.ts`'s `recordConnectionSuccess`/`recordConnectionFailure`
 * calls) rather than inventing a third `connections.status` bucket the
 * schema does not have.
 *
 * **On an `auth`-class failure the probe RECORDS and STOPS.** It never
 * invalidates and rebuilds the cached adapter in a retry loop — the sweep's
 * own `checked_at` + `consecutive_failures` backoff (300s -> ... -> 3600s,
 * `nextHealthCheckDueAt` in `@loxep/domain`) IS the lockout protection every
 * one of these self-hosted tools needs (Dockhand locks an account out after
 * five failed logins; Termix publishes a login 429 with no documented
 * threshold). Nothing in this module calls `invalidate<Provider>Adapter` —
 * that stays reserved for an explicit operator "test connection" action,
 * wired outside this fence.
 *
 * **No fleet probe writes a `notification_deliveries` row.** Asserted by
 * test in `fleet-health.test.ts` — none of the five probe functions below
 * import or touch a notifications service at all, so the assertion is
 * structural as much as behavioral.
 */
import type { LoxepDb } from "@loxep/db";
import {
  ConnectionNotFoundError,
  createDefaultHealthSubjectRegistry,
  gatusPushSetting,
} from "@loxep/domain";
import type {
  Connection,
  ConnectionsService,
  HealthProbeOutcome,
  HealthSubjectRegistry,
  HealthSubjectRegistryEntry,
  SettingsService,
} from "@loxep/domain";
import { BeszelAdapterError } from "@loxep/integration-beszel";
import { DockhandAdapterError } from "@loxep/integration-dockhand";
import { GatusAdapterError, normalizeGatusBaseUrl } from "@loxep/integration-gatus";
import type { GatusAdapter, GatusEndpointStatusFact } from "@loxep/integration-gatus";
import { TermixAdapterError } from "@loxep/integration-termix";
import { AppConfigurationError } from "./errors.ts";
import {
  BESZEL_CONNECTION_PROVIDER,
  DOCKHAND_CONNECTION_PROVIDER,
  GATUS_CONNECTION_PROVIDER,
  TAILSCALE_CONNECTION_PROVIDER,
  TERMIX_CONNECTION_PROVIDER,
  readGatusBaseUrl,
} from "./fleet.ts";
import type {
  BeszelAdapterFactory,
  DockhandAdapterFactory,
  GatusAdapterFactory,
  TailscaleAdapterFactory,
  TermixAdapterFactory,
} from "./fleet.ts";

/**
 * The slice of {@link AppServices} (`services.ts`) this module actually
 * needs. Kept as its OWN interface — structurally satisfied by the real
 * `AppServices` without importing it — for two reasons: it keeps this file
 * decoupled from every non-fleet adapter factory `AppServices` also carries
 * (eBay/Woo/Etsy/Cloudflare/Purelymail/Reverb/Medusa), and it lets tests
 * build a minimal fake instead of the whole composition root's service graph.
 */
export interface FleetHealthServices {
  connections: ConnectionsService;
  settings: SettingsService;
  getBeszelAdapterForConnection: BeszelAdapterFactory;
  getDockhandAdapterForConnection: DockhandAdapterFactory;
  getGatusAdapterForConnection: GatusAdapterFactory;
  getTailscaleAdapterForConnection: TailscaleAdapterFactory;
  getTermixAdapterForConnection: TermixAdapterFactory;
}

const FLEET_PROVIDERS = new Set<string>([
  BESZEL_CONNECTION_PROVIDER,
  DOCKHAND_CONNECTION_PROVIDER,
  GATUS_CONNECTION_PROVIDER,
  TAILSCALE_CONNECTION_PROVIDER,
  TERMIX_CONNECTION_PROVIDER,
]);

/**
 * A connection row exists but the adapter factory could not build a client
 * for it (no stored base URL, no stored credential — `fleet.ts`'s
 * `*CredentialsMissingError` classes, which all extend
 * `AppConfigurationError`). This is a Loxep-side configuration gap, not a
 * network question and not a rejected credential: no request ever left the
 * process, so `unknown` (Loxep could not determine this subject's health) is
 * the honest status, matching the shared "unreachable from Loxep" rule
 * `@loxep/domain`'s `health-probes.ts` module doc states for its own three
 * subjects.
 */
function misconfiguredOutcome(error: unknown): HealthProbeOutcome {
  if (error instanceof AppConfigurationError) {
    return {
      status: "unknown",
      detail: { kind: "misconfigured" },
      source: "adapter",
    };
  }
  throw error;
}

// =============================================================================
// Beszel — loxep-y64 §1, Layer A
// =============================================================================

/**
 * Two calls, and the second is the point: `health()` alone would report `ok`
 * over a garbage password, since `/api/health` never sees the credential.
 *
 * ```text
 * health() fails at all                  -> unknown  { kind: 'unreachable' }
 * health() ok, listSystems() auth error   -> failing  { kind: 'auth' }
 * health() ok, listSystems() other error  -> failing  { kind: <BeszelErrorKind> }
 * both ok                                 -> ok       { systems, up, notUp, hubReachable: true }
 * ```
 *
 * Deliberately calls `listSystems()` with NO `filter` — `status = "up"` is
 * the REST guide's own example and is exactly inverted for this purpose: it
 * would hide every system that is not up, which is the one fact this read
 * exists to surface.
 */
async function probeBeszelConnection(
  services: FleetHealthServices,
  connectionId: string,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getBeszelAdapterForConnection(connectionId);
  } catch (error) {
    return misconfiguredOutcome(error);
  }
  const { adapter } = handle;

  try {
    await adapter.health();
  } catch {
    return { status: "unknown", detail: { kind: "unreachable" }, source: "adapter" };
  }

  let systems;
  try {
    systems = await adapter.listSystems();
  } catch (error) {
    const kind = error instanceof BeszelAdapterError ? error.kind : "provider_unavailable";
    return { status: "failing", detail: { kind }, source: "adapter" };
  }

  const up = systems.filter((system) => system.status === "up").length;
  return {
    status: "ok",
    detail: {
      systems: systems.length,
      up,
      notUp: systems.length - up,
      hubReachable: true,
    },
    source: "adapter",
  };
}

// =============================================================================
// Dockhand — loxep-hb7 §1.1-1.2
// =============================================================================

/**
 * Two calls, and step 2 is not optional: `probeSession()` succeeds against an
 * instance with a wrong password stored, because it answers before a login
 * is attempted — a probe that stopped there would render `ok` for a broken
 * credential.
 *
 * ```text
 * network error / timeout / DNS               -> unknown  { kind: 'unreachable' }
 * HTTP responded, kind 'auth'                  -> failing  { kind: 'auth' }
 * HTTP responded, any other kind               -> failing  { kind: <DockhandErrorKind> }
 * session ok, authenticationEnabled === false  -> ok       { authMode: 'disabled' }
 * listHosts() ok                               -> ok       { authMode: 'session', hostCount }
 * ```
 *
 * The unreachable-vs-failing discriminator is `typeof error.detail.httpStatus
 * === 'number'`: `dockhandErrorFromResponse` always sets it (the instance
 * answered and misbehaved or refused); `normalizeDockhandError` never does
 * (nothing answered at all). Applied uniformly to a thrown error from EITHER
 * call — the mapping above is a property of what was thrown, not of which
 * step threw it.
 *
 * `authenticationEnabled === false` is a SECURITY note the UI renders as a
 * warning line, never a health degradation: Loxep can reach and read this
 * instance, which is exactly what an `ok` connection row means.
 */
function dockhandFailureOutcome(error: unknown): HealthProbeOutcome {
  if (error instanceof DockhandAdapterError) {
    const httpStatus = error.detail["httpStatus"];
    if (typeof httpStatus !== "number") {
      return { status: "unknown", detail: { kind: "unreachable" }, source: "adapter" };
    }
    if (error.kind === "auth") {
      return { status: "failing", detail: { kind: "auth" }, source: "adapter" };
    }
    return { status: "failing", detail: { kind: error.kind }, source: "adapter" };
  }
  return { status: "unknown", detail: { kind: "unreachable" }, source: "adapter" };
}

async function probeDockhandConnection(
  services: FleetHealthServices,
  connectionId: string,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getDockhandAdapterForConnection(connectionId);
  } catch (error) {
    return misconfiguredOutcome(error);
  }
  const { adapter } = handle;

  let session;
  try {
    session = await adapter.probeSession();
  } catch (error) {
    return dockhandFailureOutcome(error);
  }

  if (session.authenticationEnabled === false) {
    return { status: "ok", detail: { authMode: "disabled" }, source: "adapter" };
  }

  let hosts;
  try {
    hosts = await adapter.listHosts();
  } catch (error) {
    return dockhandFailureOutcome(error);
  }

  return {
    status: "ok",
    detail: { authMode: "session", hostCount: hosts.length },
    source: "adapter",
  };
}

// =============================================================================
// Gatus — loxep-1au §2 (the connection probe) and §3 (the heartbeat mirror)
// =============================================================================

/**
 * `gatusPushSetting.endpointKey`'s heartbeat, mirrored INTO the same
 * connection's `detail`, never as a health subject of its own — see
 * `gatusPushHeartbeatDetail`'s doc for BINDING RULE 1.
 */
interface GatusHeartbeatInput {
  services: FleetHealthServices;
  /** The normalized base URL this Gatus connection speaks to (`gatusSourceAccountKey`). */
  connectionSourceAccountKey: string;
  adapter: GatusAdapter;
  /**
   * The bulk statuses page the connection probe already fetched (`direct`
   * posture), or `undefined` when the probe never called
   * `listEndpointStatuses()` at all (`oidc` posture) — see the module doc's
   * "one read, four outputs" note.
   */
  statuses: readonly GatusEndpointStatusFact[] | undefined;
}

/**
 * The self-monitoring mirror (loxep-1au §3): "Gatus's opinion of Loxep's own
 * heartbeat", folded into the SAME probe as one extra unauthenticated GET at
 * most.
 *
 * ## Why this read earns its place
 *
 * `GET /api/v1/endpoints/:key/uptimes/:duration` sits on Gatus's UNPROTECTED
 * router in every security posture, and its one prerequisite — knowing the
 * key in advance — is already satisfied: the operator typed
 * `gatusPushSetting.endpointKey` into `/settings/application` themselves,
 * which IS the operator confirmation this design otherwise requires a picker
 * for. `endpointUptime(key, '24h')` returning `not_found` is a definitive,
 * one-GET detection of a MISMATCHED key, which is a SILENT no-op today
 * (`pushGatusHealth` returns `ok` on a successful POST regardless of whether
 * Gatus recognized the key) — that alone justifies the read.
 *
 * ## Matching rule
 *
 * Zero Gatus connections whose normalized base URL matches the push
 * setting's -> no heartbeat block. MORE than one match -> match NONE:
 * guessing between two instances is worse than admitting the ambiguity.
 *
 * ## BINDING RULE 1 — the latch rule
 *
 * `gatus-push.ts` publishes `worst(integration_health.status)` OUTWARD. Any
 * health row DERIVED FROM Gatus's opinion of the heartbeat endpoint would
 * close a self-latching loop that can never recover (Gatus says down ->
 * Loxep writes failing -> the next push publishes success=false -> the
 * endpoint stays down). So: the endpoint named by
 * `gatusPushSetting.endpointKey` is never an `integration_health` subject, is
 * never linked through `resource_links`, and its observed status NEVER
 * influences this connection's own `status` — only this function's return
 * value, folded into `detail.heartbeat`, which the caller adds to whatever
 * status the CONNECTION PROBE independently computed. Asserted by test:
 * `fleet-health.test.ts`'s "Binding Rule 1" suite runs a full sweep with a
 * matching push connection configured and asserts no `integration_health`
 * row of any subject type is ever written for the endpoint — there is
 * structurally nowhere for one to come from, since this module never
 * registers an `external_resource` (that is Slice B, out of this fence's
 * scope), but the test pins the invariant explicitly rather than leaving it
 * an accident of what has not been built yet.
 *
 * ## BINDING RULE 2 — the direction rule
 *
 * The Gatus connection's own health `status` means exactly one thing: can
 * Loxep read this Gatus, and was its credential accepted. This function never
 * returns a `status` — only a `detail` fragment — so it structurally cannot
 * violate that rule; a future edit that makes it influence `status` is the
 * one to reject in review.
 */
async function gatusPushHeartbeatDetail(
  input: GatusHeartbeatInput,
): Promise<Record<string, unknown> | undefined> {
  const { services, connectionSourceAccountKey, adapter, statuses } = input;

  const pushConfig = await services.settings.get(gatusPushSetting);
  if (!pushConfig.enabled || pushConfig.baseUrl === null || pushConfig.endpointKey === null) {
    return undefined;
  }

  let normalizedPushBaseUrl: string;
  try {
    normalizedPushBaseUrl = normalizeGatusBaseUrl(pushConfig.baseUrl);
  } catch {
    return undefined;
  }
  if (normalizedPushBaseUrl !== connectionSourceAccountKey) return undefined;

  // Ambiguity guard: this connection's base URL matches the push setting's,
  // but so might another Gatus connection's. Match none rather than guess.
  const gatusConnections = await services.connections.listConnections({
    provider: GATUS_CONNECTION_PROVIDER,
  });
  let matches = 0;
  for (const candidate of gatusConnections) {
    const raw = readGatusBaseUrl(candidate.config);
    if (raw === null) continue;
    try {
      if (normalizeGatusBaseUrl(raw) === normalizedPushBaseUrl) matches += 1;
    } catch {
      // An unparseable stored base URL cannot match anything; skip it.
    }
  }
  if (matches !== 1) return undefined;

  const configuredKey = pushConfig.endpointKey;

  if (statuses !== undefined) {
    const found = statuses.find((status) => status.key === configuredKey);
    if (found !== undefined) {
      return {
        configuredKey,
        keyFound: true,
        uptime24h: null,
        gatusObservedAt: found.observedAt,
        gatusSuccess: found.success,
        source: "statuses",
      };
    }
  }

  // Either the oidc posture (no bulk statuses read at all) or the key was
  // absent from the page — one unauthenticated GET distinguishes "Gatus does
  // not know this key" from "known but not on this page / oidc-degraded".
  try {
    const uptime = await adapter.endpointUptime(configuredKey, "24h");
    return {
      configuredKey,
      keyFound: true,
      uptime24h: uptime.uptime,
      gatusObservedAt: null,
      gatusSuccess: null,
      source: "uptime_only",
    };
  } catch (error) {
    if (error instanceof GatusAdapterError && error.kind === "not_found") {
      return {
        configuredKey,
        keyFound: false,
        uptime24h: null,
        gatusObservedAt: null,
        gatusSuccess: null,
        source: "uptime_only",
      };
    }
    // Any other failure on this best-effort mirror: omit the block rather
    // than guess at what it means.
    return undefined;
  }
}

/**
 * Two calls, always, in all three auth postures — never three.
 * `probeConfig()` first (unauthenticated, above any security middleware, so
 * its failure alone means Loxep could not determine anything); then
 * `listEndpointStatuses()` in `direct` posture (the credential-proving read,
 * also the discovery read and the counts) or `health()` in `oidc` posture
 * (the only second call that can say anything, since `listEndpointStatuses`
 * refuses to even attempt an unwinnable request there).
 *
 * ```text
 * probeConfig() throws                     -> unknown   { kind: 'unreachable' }
 * open,  statuses ok                       -> ok        { posture: 'open',  endpointCount, failingCount }
 * basic, statuses ok                       -> ok        { posture: 'basic', credentialAccepted: true, endpointCount, failingCount }
 * basic, statuses 401/403                  -> failing   { kind: 'auth', posture: 'basic' }
 * basic (or open), statuses other error    -> failing   { kind, posture, httpStatus? }
 * oidc,  health() reachable UP             -> degraded  { kind: 'oidc_no_server_credential', posture: 'oidc' }
 * oidc,  health() reachable DOWN           -> failing   { kind: 'hub_down', hubStatus: 'DOWN', posture: 'oidc' }
 * oidc,  health() throws                   -> unknown   { kind: 'unreachable' }
 * ```
 *
 * The THREE-way posture (`open`/`basic`/`oidc`) is recovered from
 * `{oidc, authenticated}`, which the adapter's own binary `mode` discards —
 * `{oidc:false,authenticated:true}` -> `open` (no security block at all),
 * `{oidc:false,authenticated:false}` -> `basic`, `{oidc:true,
 * authenticated:false}` -> `oidc`. This is an INFERENCE from reading
 * upstream source (see `@loxep/integration-gatus`'s adapter doc), so it
 * drives COPY ONLY, never a security decision — the branch that actually
 * decides which call to make is `probe.mode === 'oidc_degraded'`, computed
 * BEFORE any call, never by classifying a thrown error afterwards.
 *
 * **OIDC is `degraded`, never `failing`.** The `auth` error
 * `listEndpointStatuses` would throw in OIDC mode is Loxep's own refusal to
 * attempt an unwinnable call, not Gatus rejecting a credential — so this
 * function never calls it in that posture at all.
 *
 * `detail` says `credentialAccepted`, NEVER `verified`/`valid`/
 * `authenticated`: fiber's `basicauth` `Authorizer` returns `true`
 * unconditionally when the operator omitted `password-bcrypt-base64` from
 * their YAML, so a successful statuses read proves the credential was
 * ACCEPTED, never that it was CORRECT. `providerMessage` is never copied into
 * `detail` — only `httpStatus` and `kind`.
 */
async function probeGatusConnection(
  services: FleetHealthServices,
  connectionId: string,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getGatusAdapterForConnection(connectionId);
  } catch (error) {
    return misconfiguredOutcome(error);
  }
  const { adapter, sourceAccountKey } = handle;

  let probeFact;
  try {
    probeFact = await adapter.probeConfig();
  } catch {
    return { status: "unknown", detail: { kind: "unreachable" }, source: "adapter" };
  }

  const posture: "open" | "basic" | "oidc" = probeFact.oidc
    ? "oidc"
    : probeFact.authenticated
      ? "open"
      : "basic";

  if (probeFact.mode === "oidc_degraded") {
    let health;
    try {
      health = await adapter.health();
    } catch {
      return { status: "unknown", detail: { kind: "unreachable" }, source: "adapter" };
    }
    const heartbeat = await gatusPushHeartbeatDetail({
      services,
      connectionSourceAccountKey: sourceAccountKey,
      adapter,
      statuses: undefined,
    });
    if (health.status === "DOWN") {
      return {
        status: "failing",
        detail: {
          kind: "hub_down",
          hubStatus: "DOWN",
          posture,
          ...(heartbeat !== undefined ? { heartbeat } : {}),
        },
        source: "adapter",
      };
    }
    return {
      status: "degraded",
      detail: {
        kind: "oidc_no_server_credential",
        posture,
        ...(heartbeat !== undefined ? { heartbeat } : {}),
      },
      source: "adapter",
    };
  }

  let statuses;
  try {
    statuses = await adapter.listEndpointStatuses();
  } catch (error) {
    const kind = error instanceof GatusAdapterError ? error.kind : "provider_unavailable";
    const httpStatus =
      error instanceof GatusAdapterError && typeof error.detail["httpStatus"] === "number"
        ? (error.detail["httpStatus"] as number)
        : undefined;
    if (kind === "auth") {
      return { status: "failing", detail: { kind: "auth", posture }, source: "adapter" };
    }
    return {
      status: "failing",
      detail: { kind, posture, ...(httpStatus !== undefined ? { httpStatus } : {}) },
      source: "adapter",
    };
  }

  const failingCount = statuses.filter((status) => status.success === false).length;
  const heartbeat = await gatusPushHeartbeatDetail({
    services,
    connectionSourceAccountKey: sourceAccountKey,
    adapter,
    statuses,
  });
  const baseDetail: Record<string, unknown> =
    posture === "open"
      ? { posture: "open", endpointCount: statuses.length, failingCount }
      : {
          posture: "basic",
          credentialAccepted: true,
          endpointCount: statuses.length,
          failingCount,
        };

  return {
    status: "ok",
    detail: { ...baseDetail, ...(heartbeat !== undefined ? { heartbeat } : {}) },
    source: "adapter",
  };
}

// =============================================================================
// Tailscale — loxep-50t §2.2(c), Slice A
// =============================================================================

/**
 * `connections.config.credentialExpiresAt` — the operator-recorded expiry a
 * concurrent form-wiring change (loxep-50t §2.2(b)) adds. Read defensively:
 * absent or unparseable is "not recorded", never "fine" and never treated as
 * an error either — the connection just gets no expiry-aware degrade.
 */
function readTailscaleCredentialExpiresAt(config: Record<string, unknown>): Date | null {
  const raw = config["credentialExpiresAt"];
  if (typeof raw !== "string" || raw === "") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The 14-day warning threshold is a CONSTANT, never a per-connection setting. */
const TAILSCALE_EXPIRY_WARNING_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `probe()` already returns `{reachable:true, authenticated:false}` on a 401
 * rather than throwing, which is precisely the shape a health probe wants —
 * so only a genuine network-level failure reaches this function's `catch`.
 *
 * ```text
 * throws (network-level)                         -> unknown   { kind: 'unreachable' }
 * authenticated === false                        -> failing   { kind: 'auth', credentialMode }
 * ok, recorded expiry already past                -> degraded  { kind: 'credential_expiry_passed' }
 * ok, recorded expiry <= 14 days away              -> degraded  { kind: 'credential_expiring', daysRemaining, credentialMode }
 * ok, oauth_client mode                            -> ok        { authMode: 'oauth_client' }
 * ok, otherwise                                    -> ok        { deviceCount }
 * ```
 *
 * "Expiry already past" while the read still WORKS is deliberately
 * `degraded`, not `failing` and not a fabricated "expired" status the
 * adapter cannot prove: the read succeeding means either the recorded date
 * was wrong or the token was rotated without updating it — the copy should
 * say so, never silently trust either side. A 401 always stays
 * `failing`/`auth`, regardless of any recorded expiry.
 */
async function probeTailscaleConnection(
  services: FleetHealthServices,
  connection: Connection,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getTailscaleAdapterForConnection(connection.id);
  } catch (error) {
    return misconfiguredOutcome(error);
  }
  const { adapter } = handle;

  let probeFact;
  try {
    probeFact = await adapter.probe();
  } catch {
    return { status: "unknown", detail: { kind: "unreachable" }, source: "adapter" };
  }

  const credentialMode = adapter.capabilities().authMode;

  if (!probeFact.authenticated) {
    return {
      status: "failing",
      detail: { kind: "auth", credentialMode },
      source: "adapter",
    };
  }

  const expiresAt = readTailscaleCredentialExpiresAt(connection.config);
  if (expiresAt !== null) {
    const remainingMs = expiresAt.getTime() - Date.now();
    if (remainingMs <= 0) {
      return {
        status: "degraded",
        detail: { kind: "credential_expiry_passed" },
        source: "adapter",
      };
    }
    const daysRemaining = Math.ceil(remainingMs / MS_PER_DAY);
    if (daysRemaining <= TAILSCALE_EXPIRY_WARNING_DAYS) {
      return {
        status: "degraded",
        detail: { kind: "credential_expiring", daysRemaining, credentialMode },
        source: "adapter",
      };
    }
  }

  if (credentialMode === "oauth_client") {
    return { status: "ok", detail: { authMode: "oauth_client" }, source: "adapter" };
  }

  return {
    status: "ok",
    detail: { deviceCount: probeFact.deviceCount },
    source: "adapter",
  };
}

// =============================================================================
// Termix — loxep-wvm §1
// =============================================================================

/**
 * The two calls (`POST /users/login` then `GET /users/me`) are INTERNAL to
 * `probe()` — Termix has NO unauthenticated surface at all (`openapi.json`'s
 * global `bearerAuth` is never overridden), so a second sweep call here would
 * spend a request against the one route upstream documents a 429 on, for no
 * benefit. Do not "fix" this into the Dockhand/Beszel two-call shape.
 *
 * ```text
 * thrown, no detail.httpStatus                   -> unknown   { kind: 'unreachable' }
 * thrown, kind 'rate_limited'                     -> degraded  { kind: 'rate_limited' }
 * thrown, any other kind (has an httpStatus)       -> failing   { kind, httpStatus }
 * authenticated === false                          -> failing   { kind: 'auth' }
 * authenticated === true                            -> ok        { hostCount?, hostsReadable }
 * ```
 *
 * The unreachable-vs-failing discriminator is `typeof error.detail.httpStatus
 * === 'number'`. `termixErrorFromResponse` ALWAYS sets it (the instance
 * answered); `normalizeTermixError` NEVER does (nothing answered). This is
 * not obvious from the error `kind` alone (`provider_unavailable` covers both
 * "network failure" and "HTTP 5xx" in this package's taxonomy) and it is
 * load-bearing — get it backwards and a topology problem renders as a
 * credential failure.
 *
 * The host-count enrichment is DEMOTED: `listHosts()` is best-effort, in its
 * OWN try/catch, and may enrich `detail` but must NEVER change the `status`.
 * `listHosts()` throws `invalid_request` on a response body that is "neither
 * an array nor a recognized wrapped array" against a route (`GET
 * /host/db/host`) with NO documented response schema anywhere in Termix's
 * spec — a wrapper-key guess must never redden an otherwise healthy,
 * credential-proven connection.
 */
function termixFailureOutcome(error: unknown): HealthProbeOutcome {
  if (error instanceof TermixAdapterError) {
    const httpStatus = error.detail["httpStatus"];
    if (typeof httpStatus !== "number") {
      return { status: "unknown", detail: { kind: "unreachable" }, source: "adapter" };
    }
    if (error.kind === "rate_limited") {
      return { status: "degraded", detail: { kind: "rate_limited" }, source: "adapter" };
    }
    return { status: "failing", detail: { kind: error.kind, httpStatus }, source: "adapter" };
  }
  return { status: "unknown", detail: { kind: "unreachable" }, source: "adapter" };
}

async function probeTermixConnection(
  services: FleetHealthServices,
  connectionId: string,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getTermixAdapterForConnection(connectionId);
  } catch (error) {
    return misconfiguredOutcome(error);
  }
  const { adapter } = handle;

  let probeFact;
  try {
    probeFact = await adapter.probe();
  } catch (error) {
    return termixFailureOutcome(error);
  }

  if (!probeFact.authenticated) {
    return { status: "failing", detail: { kind: "auth" }, source: "adapter" };
  }

  let detail: Record<string, unknown>;
  try {
    const hosts = await adapter.listHosts();
    detail = { hostCount: hosts.length, hostsReadable: true };
  } catch {
    // Best-effort only — see the function doc. Never downgrades `status`.
    detail = { hostsReadable: false };
  }

  return { status: "ok", detail, source: "adapter" };
}

// =============================================================================
// Composition
// =============================================================================

/**
 * `ok`/`degraded` -> `recordConnectionSuccess` (the read reached the tool and
 * its credential was accepted — `degraded` is a proactive warning, never a
 * rejected credential or a failed contact). `failing`/`unknown` ->
 * `recordConnectionFailure` with `errorCode` derived from `detail.kind`. This
 * is the ONLY place any of the five fleet providers write
 * `connections.last_success_at`/`last_error_at`/`last_error_code` — see the
 * module doc's "sole writer" rule. Failures writing this bookkeeping column
 * are swallowed (never allowed to turn a successful probe into a `failed`
 * sweep entry over an unrelated database hiccup), matching
 * `poll-executor.ts`'s own `.catch(() => undefined)` on
 * `recordConnectionFailure`.
 */
async function recordConnectionOutcome(
  services: FleetHealthServices,
  connectionId: string,
  outcome: HealthProbeOutcome,
): Promise<void> {
  if (outcome.status === "ok" || outcome.status === "degraded") {
    await services.connections.recordConnectionSuccess(connectionId).catch(() => undefined);
    return;
  }
  const kind = outcome.detail?.["kind"];
  const errorCode = `fleet_${typeof kind === "string" ? kind : outcome.status}`;
  await services.connections
    .recordConnectionFailure(connectionId, { errorCode })
    .catch(() => undefined);
}

async function probeFleetConnection(
  services: FleetHealthServices,
  connection: Connection,
): Promise<HealthProbeOutcome> {
  switch (connection.provider) {
    case BESZEL_CONNECTION_PROVIDER:
      return probeBeszelConnection(services, connection.id);
    case DOCKHAND_CONNECTION_PROVIDER:
      return probeDockhandConnection(services, connection.id);
    case GATUS_CONNECTION_PROVIDER:
      return probeGatusConnection(services, connection.id);
    case TAILSCALE_CONNECTION_PROVIDER:
      return probeTailscaleConnection(services, connection);
    case TERMIX_CONNECTION_PROVIDER:
      return probeTermixConnection(services, connection.id);
    default:
      // FLEET_PROVIDERS gates every call site below; reaching here would be
      // this module's own bug, not a provider's.
      throw new Error(
        `fleet-health: connection ${connection.id} has provider "${connection.provider}", which is not a registered fleet provider`,
      );
  }
}

async function probeConnectionDispatch(
  services: FleetHealthServices,
  fallbackProbe: HealthSubjectRegistryEntry["probe"],
  db: LoxepDb,
  subjectId: string,
): Promise<HealthProbeOutcome | null> {
  let connection: Connection;
  try {
    connection = await services.connections.getConnection(subjectId);
  } catch (error) {
    // Listed as a candidate, then deleted before this probe ran — the same
    // "clear rather than write a stale row" handling `runHealthSweep` gives
    // every other subject type on a `null` outcome.
    if (error instanceof ConnectionNotFoundError) return null;
    throw error;
  }

  if (!FLEET_PROVIDERS.has(connection.provider)) {
    return fallbackProbe(db, subjectId);
  }

  const outcome = await probeFleetConnection(services, connection);
  await recordConnectionOutcome(services, connection.id, outcome);
  return outcome;
}

/**
 * Compose the fleet-aware `connection` registry entry on top of
 * `@loxep/domain`'s `createDefaultHealthSubjectRegistry()`. `notification_
 * endpoint`/`storage_backend` pass through unchanged; `connection` dispatches
 * per row as described in this module's doc.
 */
export function createFleetHealthSubjectRegistry(
  services: FleetHealthServices,
): HealthSubjectRegistry {
  const base = createDefaultHealthSubjectRegistry();
  const connectionEntry = base.connection;
  if (connectionEntry === undefined) {
    // Defensive: only trips if @loxep/domain ever stops registering its own
    // 'connection' entry, which this module's fallback path depends on.
    throw new Error(
      "@loxep/domain's default health subject registry has no 'connection' " +
        "entry to fall back to for non-fleet providers",
    );
  }

  return {
    ...base,
    connection: {
      source: connectionEntry.source,
      listCandidates: connectionEntry.listCandidates,
      probe: (db, subjectId) =>
        probeConnectionDispatch(services, connectionEntry.probe, db, subjectId),
    },
  };
}
