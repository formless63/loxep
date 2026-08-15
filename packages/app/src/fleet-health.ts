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
 *
 * **Beszel's connection probe also DISCOVERS (loxep-y64 slice 3).** On a
 * successful `listSystems()` read, `probeBeszelConnection` calls
 * {@link projectBeszelSystems} as a side effect over the SAME page: it
 * upserts one `external_resources` row per system (`provider='beszel'`,
 * `externalType='system'`, keyed on the PocketBase record id via
 * `upsertExternalResource`, loxep-uhs) and writes that resource's own
 * `integration_health` row (`subject_type='external_resource'`,
 * `source='adapter'`, status derived from the system's verbatim
 * up/down/paused string). This is why `fleet-tool-registry.ts` now nulls
 * Beszel's `healthPath` — see that module's doc for the "two writers of one
 * subject" race this closes.
 *
 * **Tailscale (loxep-50t slice B) and Gatus (loxep-1au slice B) now follow
 * the same shape**, each over the SAME bulk read its connection probe
 * already makes (`adapter.listDevices()` / the `direct`-posture
 * `adapter.listEndpointStatuses()`), never a second network call:
 * {@link projectTailscaleDevices} and {@link projectGatusEndpoints}.
 * `fleet-tool-registry.ts` nulls both providers' `healthPath` for the same
 * "two writers of one subject" reason as Beszel's. Both differ from
 * Beszel's shape in one deliberate way — see each function's own doc —
 * `external_resources` rows are upserted for EVERY observed device/endpoint
 * (so the attach picker has a full candidate list), but an
 * `integration_health` row is written ONLY for devices/endpoints already
 * LINKED to a hosting target: an unattached tailnet holds laptops and
 * phones, and an unattached Gatus connection holds tens of unrelated
 * endpoints, and neither belongs in the attention surface uninvited (loxep-
 * 50t §1.3, loxep-1au §4.1 Binding Rule 3). Gatus additionally EXCLUDES the
 * endpoint named by `gatusPushSetting.endpointKey` from registration
 * entirely — see `gatusPushHeartbeatDetail`'s BINDING RULE 1 doc, which this
 * function shares.
 *
 * **Dockhand (loxep-hb7 Milestone B) and Termix (loxep-wvm Slice B) also
 * follow the shape**, each over the SAME bulk read its connection probe
 * already makes (`adapter.listHosts()` for both): {@link
 * projectDockhandResources} and {@link projectTermixResources}. Dockhand is
 * the one provider whose discovery ALSO auto-attaches — see that function's
 * doc for why hb7 §3.1's exact-name bootstrap join is sanctioned here and
 * nowhere else. Termix's per-resource `integration_health` row is written
 * for LINKED hosts only (wvm Slice B item 10, narrower even than Tailscale's
 * "linked only" rule — Beszel/Tailscale/Gatus still upsert `external_
 * resources` for every observed object regardless of link state; Termix does
 * too, but ALSO gates the health write on the same link check, because an
 * unconfirmed Termix host carries no uniqueness promise at all — see that
 * function's doc).
 */
import type { LoxepDb } from "@loxep/db";
import {
  ConnectionNotFoundError,
  createDefaultHealthSubjectRegistry,
  createHealthService,
  createResourceLinksService,
  gatusPushSetting,
} from "@loxep/domain";
import type {
  Connection,
  ConnectionsService,
  HealthProbeOutcome,
  HealthStatus,
  HealthSubjectRegistry,
  HealthSubjectRegistryEntry,
  SettingsService,
} from "@loxep/domain";
import { BeszelAdapterError, normalizeBeszelBaseUrl } from "@loxep/integration-beszel";
import type { BeszelSystemFact } from "@loxep/integration-beszel";
import { DockhandAdapterError, normalizeDockhandBaseUrl } from "@loxep/integration-dockhand";
import type { DockhandHostFact } from "@loxep/integration-dockhand";
import { GatusAdapterError, normalizeGatusBaseUrl } from "@loxep/integration-gatus";
import type { GatusAdapter, GatusEndpointStatusFact } from "@loxep/integration-gatus";
import { TailscaleAdapterError } from "@loxep/integration-tailscale";
import type { TailscaleDeviceFact } from "@loxep/integration-tailscale";
import { TermixAdapterError, normalizeTermixBaseUrl } from "@loxep/integration-termix";
import type { TermixAdapter, TermixHostFact } from "@loxep/integration-termix";
import { createContainerHostsService } from "@loxep/infrastructure";
import type {
  ContainerHostProviderPort,
  ContainerHostsService,
} from "@loxep/infrastructure";
import { AppConfigurationError } from "./errors.ts";
import {
  BESZEL_CONNECTION_PROVIDER,
  DOCKHAND_CONNECTION_PROVIDER,
  GATUS_CONNECTION_PROVIDER,
  TAILSCALE_CONNECTION_PROVIDER,
  TERMIX_CONNECTION_PROVIDER,
  readBeszelBaseUrl,
  readDockhandBaseUrl,
  readGatusBaseUrl,
  readTermixBaseUrl,
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
 * Beszel's per-system status, verbatim, mapped onto Loxep's own
 * ok/degraded/failing/unknown vocabulary for `integration_health.status`
 * (the CHECK constraint that ties `status='ok'` to
 * `consecutive_failures=0` needs one of the four; the verbatim string
 * itself is never lost — it travels separately in `detail.status`, which is
 * what the fleet-detail panel actually renders per loxep-y64 §3's "verbatim
 * status chip" rule).
 *
 * Upstream publishes no enumeration (see `@loxep/integration-beszel`'s
 * adapter doc), so this mapping is deliberately conservative — it is a
 * genuine judgment call, not something y64 pins down to the letter, and is
 * documented here rather than silently baked in:
 *
 * ```text
 * "up"      -> ok        the one documented value
 * "down"    -> failing   a definite negative signal — matches the design's
 *                         own "destructive" tone hint for it (§3)
 * "paused"  -> unknown   an OPERATOR deliberately turned monitoring off for
 *                         this system in Beszel itself — that is "Loxep
 *                         genuinely does not know," never a red alert over
 *                         someone else's own pause button. Matches the
 *                         design's "muted … unconfirmed hint" framing.
 * anything else          -> unknown, rather than guessing a future release's
 *                         new status means trouble — "a mapping table that
 *                         guesses would invent a fact" (design §3, about
 *                         tone; applied here to the coarser bucket too).
 * ```
 */
function beszelSystemHealthStatus(status: string): HealthStatus {
  if (status === "up") return "ok";
  if (status === "down") return "failing";
  return "unknown";
}

/**
 * loxep-y64 slice 3: discovery + the per-system `external_resource` health
 * projection, as a side effect of the SAME `listSystems()` read that already
 * proved the connection's credential — "one read, three outputs" per the
 * design's §1 recommendation, rather than a second registry entry that would
 * refetch the whole collection once per system.
 *
 * `upsertExternalResource` (loxep-uhs) is the idempotency-safe verb: two
 * sweeps of the same system collapse to one `external_resources` row,
 * refreshed in place — never a fresh row (and a fresh `integration_health`
 * subject) every five minutes. Discovered-but-unlinked systems are KEPT
 * (never deleted here) — they are the operator-confirmed attach picker's
 * candidate list (`apps/web`'s `fetchDiscoveredFleetResources`), not noise.
 *
 * Best-effort and fully isolated from the CONNECTION's own probe outcome:
 * `probeBeszelConnection` already decided `status: 'ok'` from `health()` +
 * `listSystems()` succeeding, before this function is ever called, and
 * nothing here is allowed to change that — a malformed one system, or a
 * missing/unparseable stored base URL, must never turn a working Beszel
 * connection's status into `failing`. Every failure is swallowed, per
 * system, and the loop continues.
 */
async function projectBeszelSystems(
  db: LoxepDb,
  connection: Connection,
  systems: readonly BeszelSystemFact[],
): Promise<void> {
  const rawBaseUrl = readBeszelBaseUrl(connection.config);
  if (rawBaseUrl === null) return; // Same posture as a missing stored base URL anywhere else in this file: nothing to do, not an error.
  let origin: string;
  try {
    origin = normalizeBeszelBaseUrl(rawBaseUrl);
  } catch {
    return;
  }

  const resourceLinks = createResourceLinksService({ db });
  const health = createHealthService({ db });
  // Loxep's OWN read clock for this whole batch — every system discovered by
  // this one listSystems() page shares one `checkedAt`, per the design's
  // "every surface stamps its own clock" rule. Distinct from
  // `system.observedAt` (Beszel's own clock), which travels in `detail`.
  const checkedAt = new Date();

  for (const system of systems) {
    try {
      const resource = await resourceLinks.upsertExternalResource({
        provider: BESZEL_CONNECTION_PROVIDER,
        externalType: "system",
        externalId: system.externalSystemId,
        connectionId: connection.id,
        url: `${origin}/system/${encodeURIComponent(system.externalSystemId)}`,
        title: system.name ?? system.externalSystemId,
        // Sync metadata only, per resource-links.ts's rule — never a copy of
        // Beszel's own record beyond what the design's §2 vocabulary lists.
        metadata: {
          status: system.status,
          observedAt: system.observedAt,
          host: system.host,
          port: system.port,
          sharedWithCount: system.sharedWithCount,
        },
      });
      await health.upsertHealth({
        subjectType: "external_resource",
        subjectId: resource.id,
        status: beszelSystemHealthStatus(system.status),
        source: "adapter",
        checkedAt,
        // Never subject_type='hosting_target' — see fleet-tool-registry.ts's
        // module doc and loxep-y64 §1: a per-resource row here, keyed to
        // THIS system's own external_resources id, is what keeps Gatus/
        // Dockhand from racing Beszel on one shared row later.
        detail: { status: system.status, observedAt: system.observedAt },
      });
    } catch {
      // One malformed record must not take discovery down for the rest of
      // the fleet, and must never reach the caller — see the function doc.
    }
  }
}

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
 *
 * On success, this is also the discovery read (loxep-y64 slice 3):
 * {@link projectBeszelSystems} runs as a side effect over the SAME `systems`
 * array, never a second `listSystems()` call.
 */
async function probeBeszelConnection(
  services: FleetHealthServices,
  connection: Connection,
  db: LoxepDb,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getBeszelAdapterForConnection(connection.id);
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
  await projectBeszelSystems(db, connection, systems);
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

/**
 * Dockhand's per-environment status — a judgment call this module has to
 * make on its own, because `listHosts()` (`GET /api/environments`) is
 * Dockhand's INVENTORY of registered hosts, not a live per-host connectivity
 * check. A row in that list proves Dockhand HAS this environment
 * registered; it does not prove Dockhand can reach that host's daemon right
 * now — that would need a live per-host call, which this sweep deliberately
 * never makes (see `probeDockhandConnection`'s `§3.3` cross-reference on why
 * the containers panel is a page-view-triggered live read instead).
 *
 * The one genuine liveness signal an environment record carries is
 * `hawserLastSeen` — set only for `hawser-standard`/`hawser-edge` connection
 * types, where a remote Hawser agent actually checks in with Dockhand.
 * `socket`/`direct` environments (Dockhand talking straight to a local or
 * adjacent daemon) carry no equivalent signal at all in this read.
 *
 * ```text
 * hawser-*, hawserLastSeen present  -> ok        the agent has actually
 *                                                  reported in
 * hawser-*, hawserLastSeen absent   -> unknown    configured, never reported
 * socket / direct                   -> unknown    ALWAYS — inventory proves
 *                                                  registration, never live
 *                                                  reachability
 * ```
 *
 * NEVER `failing`: an absent liveness signal is Loxep not knowing, not a
 * negative fact about the host — the same "don't assert a fact you can't
 * back" posture `beszelSystemHealthStatus` applies to Beszel's own weak
 * signals.
 */
function dockhandEnvironmentHealthStatus(host: DockhandHostFact): HealthStatus {
  const isHawser = host.connectionType === "hawser-standard" || host.connectionType === "hawser-edge";
  if (isHawser && host.hawserLastSeen !== null) return "ok";
  return "unknown";
}

/**
 * loxep-hb7 Milestone B: discovery + the per-environment `external_resource`
 * health projection, as a side effect of the SAME `listHosts()` read that
 * already proved the connection's credential — "one read, three outputs",
 * the shape `projectBeszelSystems` established.
 *
 * ## The self-retiring name-join bootstrap (hb7 §3.1), brought forward to
 * discovery time
 *
 * hb7 §3.1 sanctions an EXACT name-join auto-attach for Dockhand alone,
 * among all five fleet providers, because `hosting_targets.name` and
 * Dockhand's own environment display name are BOTH independently guaranteed
 * unique — the one property the design requires before allowing it ("Do NOT
 * build fuzzy name matching. Exact name, then link-mediated id."). That rule
 * was written for `planContainerHostOperations` (Milestone C's reconciler),
 * which is not built yet; this function applies the SAME rule at discovery
 * time so the identity story does not wait on the reconciler. For every
 * environment whose `external_resources` row carries NO `resource_links`
 * attachment yet, this looks up a hosting target with the SAME name and, if
 * that target has no OTHER Dockhand environment link already, attaches this
 * one automatically with purpose `container_console` — the fleet design's
 * own vocabulary row for `dockhand:environment:hosting_target`. Once
 * attached (by this bootstrap OR by the operator-confirmed picker for
 * anything that doesn't match), every subsequent sweep's `upsertExternalResource`
 * call resolves the SAME row by `externalId` alone — the "prefer id
 * thereafter" half of hb7's rule falls out of the upsert's own conflict
 * target, with no separate tracking needed. A rename on either side simply
 * fails to auto-match and surfaces as an unmatched candidate in the attach
 * picker instead, per hb7 §2.6 — never a second automatic link.
 *
 * Every other fleet provider's discovery is operator-confirmed only (see
 * `projectBeszelSystems`/`projectTailscaleDevices`); Dockhand is the one
 * exception, and it is a deliberate, narrow one — not a precedent for a
 * future provider to copy without its own two-sided uniqueness guarantee.
 *
 * Unlike Beszel (which writes a health row for every discovered system
 * regardless of link state), and matching Tailscale's own "linked only"
 * rule, Dockhand still upserts `external_resources` for EVERY observed
 * environment (the attach picker's candidate list needs the full inventory)
 * but this function does not gate the HEALTH write on link state — a
 * Dockhand environment's identity is strong enough (hb7 §3.1) that its
 * status is worth recording whether or not a hosting target has been
 * matched to it yet, unlike Tailscale's tailnet (which holds unrelated
 * devices) or Termix's host list (weak, unschematized identity — see
 * `projectTermixResources`).
 *
 * No confirmed per-environment UI route exists for Dockhand (unlike
 * Beszel's documented `/system/:name`) — `url` is the INSTANCE ORIGIN, the
 * same honest-limitation posture wvm §4.3 states for Termix, rather than a
 * guessed path.
 */
async function projectDockhandResources(
  db: LoxepDb,
  connection: Connection,
  hosts: readonly DockhandHostFact[],
): Promise<void> {
  const rawBaseUrl = readDockhandBaseUrl(connection.config);
  if (rawBaseUrl === null) return;
  let origin: string;
  try {
    origin = normalizeDockhandBaseUrl(rawBaseUrl);
  } catch {
    return;
  }

  const resourceLinks = createResourceLinksService({ db });
  const health = createHealthService({ db });
  const checkedAt = new Date();

  for (const host of hosts) {
    try {
      const resource = await resourceLinks.upsertExternalResource({
        provider: DOCKHAND_CONNECTION_PROVIDER,
        externalType: "environment",
        externalId: host.externalHostId,
        connectionId: connection.id,
        url: origin,
        title: host.name,
        // Sync metadata only, per resource-links.ts's rule — never a copy of
        // Dockhand's own record beyond what the fleet design's vocabulary
        // table lists.
        metadata: {
          connectionType: host.connectionType,
          host: host.host,
          port: host.port,
          labels: host.labels,
          publicIp: host.publicIp,
          hawserConfigured: host.hawserConfigured,
          hawserLastSeen: host.hawserLastSeen,
          updatedAt: host.updatedAt,
        },
      });

      const alreadyLinked = await db.query.resourceLinks.findFirst({
        where: (table, { eq }) => eq(table.externalResourceId, resource.id),
      });
      if (alreadyLinked === undefined) {
        const target = await db.query.hostingTargets.findFirst({
          where: (table, { and, eq, isNull }) =>
            and(eq(table.name, host.name), isNull(table.decommissionedAt)),
        });
        if (target !== undefined) {
          const existingLinks = await resourceLinks.listLinksFor("hosting_target", target.id);
          const hasDockhandEnvironmentLink = existingLinks.some(
            (link) =>
              link.provider === DOCKHAND_CONNECTION_PROVIDER && link.externalType === "environment",
          );
          if (!hasDockhandEnvironmentLink) {
            await resourceLinks.attachLink({
              externalResourceId: resource.id,
              resourceType: "hosting_target",
              resourceId: target.id,
              purpose: "container_console",
            });
          }
        }
      }

      await health.upsertHealth({
        subjectType: "external_resource",
        subjectId: resource.id,
        status: dockhandEnvironmentHealthStatus(host),
        source: "adapter",
        checkedAt,
        detail: {
          connectionType: host.connectionType,
          hawserConfigured: host.hawserConfigured,
          hawserLastSeen: host.hawserLastSeen,
        },
      });
    } catch {
      // One malformed/unreadable environment must not take discovery down
      // for the rest of the fleet — see `projectBeszelSystems`'s doc for the
      // same posture.
    }
  }
}

/**
 * A `ContainerHostsService` scoped to THIS module's one use: Milestone D's
 * drift cadence, which only ever calls `.listDeclaredTargets()` and
 * `.reconcile(..., { mode: 'check' })`. `writeSecret`/`readSecret`/`enqueue`
 * are unreachable from that call shape — `container-hosts.ts`'s own
 * `reconcile()` fetches a secret ONLY in `mode === 'apply'`, and this
 * function never passes that — so each is a throwing stub rather than a
 * real `SecretsService`/`TransactionalEnqueue` wiring. This keeps
 * {@link FleetHealthServices} from having to widen into the full
 * `AppServices` (`secrets`, `config.keyring`) just for a code path that
 * never touches either.
 */
function containerHostsServiceForDriftCadence(db: LoxepDb): ContainerHostsService {
  return createContainerHostsService({
    db,
    writeSecret: () => {
      throw new Error("unreachable: the drift cadence never declares intent");
    },
    readSecret: () => {
      throw new Error("unreachable: the drift cadence never applies");
    },
    enqueue: () => {
      throw new Error("unreachable: the drift cadence never enqueues a job");
    },
  });
}

/**
 * loxep-hb7 Milestone D: the drift cadence for every hosting target with a
 * DECLARED (operator-confirmed, `desiredAt`-carrying) container-host intent
 * on THIS connection — piggybacked on the SAME `listHosts()` read
 * `projectDockhandResources` above already made, per the design's "never a
 * new cron per host" rule and this module's own "one read, N outputs"
 * discipline (Beszel/Gatus/Tailscale/Termix all follow it). No second
 * provider call: the pre-fetched `hosts` becomes the `ContainerHostProviderPort`'s
 * `read()` answer directly — `DockhandHostFact` and `ObservedContainerHost`
 * are the SAME shape by construction (`container-host-port.ts`'s module doc).
 *
 * ALWAYS `mode: 'check'` — an unattended sweep across every registered
 * target is a materially different risk posture than an operator's explicit
 * Reconcile click, exactly the reasoning
 * `INFRASTRUCTURE_RECONCILE_POLL_MODE` states for DNS's own recurring sweep.
 * `apply` on this stub port throws if ever reached, which would be a bug —
 * belt and braces, not a real path.
 *
 * One target's failure (a decommissioned target mid-sweep, a transient DB
 * hiccup) must not take the whole connection probe down — the same posture
 * `projectDockhandResources` applies per host, one level up.
 */
async function reconcileDeclaredContainerHosts(
  db: LoxepDb,
  connection: Connection,
  hosts: readonly DockhandHostFact[],
): Promise<{ driftingTargetCount: number; unmatchedObservedCount: number }> {
  const containerHosts = containerHostsServiceForDriftCadence(db);
  const declared = await containerHosts.listDeclaredTargets();
  const forThisConnection = declared.filter((target) => target.connectionId === connection.id);
  if (forThisConnection.length === 0) {
    return { driftingTargetCount: 0, unmatchedObservedCount: 0 };
  }

  const provider: ContainerHostProviderPort = {
    read: async () => [...hosts],
    apply: () => {
      throw new Error("unreachable: the drift cadence never applies");
    },
    capabilities: () => ({
      provider: "dockhand",
      hostRegistration: true,
      containerLifecycle: false,
      metricHistory: false,
      bearerTokenAuth: false,
      connectionTypes: [],
    }),
  };

  let driftingTargetCount = 0;
  // Each target's OWN `unmatchedObserved` counts every OTHER declared
  // target's host as "unmatched" too (the planner compares one desired host
  // against the WHOLE connection's inventory) — taking the max rather than
  // summing avoids multiplying that overlap into a number that grows with
  // the number of registered targets rather than with genuine drift. Not
  // exact set arithmetic; a rough "how much is unaccounted for" signal is
  // what `integration_health.detail` needs here, per hb7 §2.6.
  let unmatchedObservedCount = 0;
  for (const target of forThisConnection) {
    try {
      const result = await containerHosts.reconcile(target.hostingTargetId, {
        mode: "check",
        trigger: "poll",
        provider,
      });
      if (result.operationCount > 0) driftingTargetCount += 1;
      unmatchedObservedCount = Math.max(unmatchedObservedCount, result.unmatchedObservedCount);
    } catch {
      // See the function doc — swallowed on purpose.
    }
  }
  return { driftingTargetCount, unmatchedObservedCount };
}

async function probeDockhandConnection(
  services: FleetHealthServices,
  connection: Connection,
  db: LoxepDb,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getDockhandAdapterForConnection(connection.id);
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

  await projectDockhandResources(db, connection, hosts);
  const driftSummary = await reconcileDeclaredContainerHosts(db, connection, hosts);

  return {
    status: "ok",
    detail: { authMode: "session", hostCount: hosts.length, ...driftSummary },
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
 * Gatus's per-endpoint status mapping (loxep-1au §4.3) — a documented
 * judgment call over `GatusEndpointStatusFact.success`:
 *
 * ```text
 * success === true                 -> ok        {}
 * success === false                -> failing   { kind:'check_failing', errorCount, httpStatus? }
 * success === null (no result yet) -> unknown    { kind:'no_result_recorded' }
 * key absent from the read         -> unknown    { kind:'endpoint_missing' }  (handled by the
 *                                                  caller's missing-key diff, not this function —
 *                                                  the endpoint is not IN the read at all)
 * ```
 *
 * `errorCount` is a count, never error TEXT — `redact.ts` already reduces
 * Gatus's own `errors` array to a count for exactly this reason, and nothing
 * here may widen it back out.
 */
function gatusEndpointHealthStatus(
  status: GatusEndpointStatusFact,
): { status: HealthStatus; detail: Record<string, unknown> } {
  if (status.success === true) return { status: "ok", detail: {} };
  if (status.success === false) {
    return {
      status: "failing",
      detail: {
        kind: "check_failing",
        errorCount: status.errorCount,
        ...(status.httpStatus !== null ? { httpStatus: status.httpStatus } : {}),
      },
    };
  }
  return { status: "unknown", detail: { kind: "no_result_recorded" } };
}

/**
 * loxep-1au slice B: discovery + the per-endpoint `external_resource` health
 * projection, as a side effect of the SAME `direct`-posture
 * `listEndpointStatuses()` read the connection probe already made — "one
 * read, four outputs" (connection health, per-endpoint health, discovery,
 * the heartbeat mirror) per §4.3's own count. OIDC posture never calls this:
 * the bulk statuses read is unwinnable there (§2.1), and §4.3 explicitly
 * forbids iterating the unlinked inventory one `endpointUptime` GET at a
 * time as "a discovery loop over a route designed for one lookup".
 *
 * **BINDING RULE 1, restated for discovery.** The endpoint named by
 * `gatusPushSetting.endpointKey` is EXCLUDED from `external_resources`
 * registration entirely — never upserted, never linkable, never a health
 * subject — matching {@link gatusPushHeartbeatDetail}'s own rule for the
 * exact same key. This function reads the same setting independently
 * (rather than threading the heartbeat's already-resolved key through) so a
 * connection excludes its push key even when the heartbeat mirror itself is
 * absent (disabled, or ambiguous across connections) — the quarantine must
 * not depend on the mirror being active.
 *
 * **Only LINKED endpoints get a health row** — loxep-1au Binding Rule 3: "no
 * unlinked count, badge, or progress meter may exist anywhere in the
 * attention surface," and a health row IS such an attention-surface entry.
 * `external_resources` rows are still upserted for every OTHER observed
 * endpoint (unlinked included) — that inventory is what the attach picker
 * browses.
 *
 * **A vanished key is `unknown { endpoint_missing }`, never a silent
 * unlink** — Binding Rule 4: a Gatus key survives restarts but not renames,
 * so a previously-linked endpoint absent from this sweep's page is a fact
 * worth showing, not a row to quietly drop.
 */
async function projectGatusEndpoints(
  db: LoxepDb,
  services: FleetHealthServices,
  connection: Connection,
  statuses: readonly GatusEndpointStatusFact[],
): Promise<void> {
  const rawBaseUrl = readGatusBaseUrl(connection.config);
  if (rawBaseUrl === null) return; // Same posture as a missing stored base URL anywhere else in this file: nothing to do, not an error.
  let origin: string;
  try {
    origin = normalizeGatusBaseUrl(rawBaseUrl);
  } catch {
    return;
  }

  let excludedKey: string | null;
  try {
    excludedKey = (await services.settings.get(gatusPushSetting)).endpointKey;
  } catch {
    excludedKey = null; // Fail closed on the READ side too: never let a settings hiccup skip the exclusion by defaulting it away — see below, `null` never matches a real key.
  }

  const resourceLinks = createResourceLinksService({ db });
  const health = createHealthService({ db });
  // One shared read clock for this whole batch — distinct from each
  // endpoint's own `observedAt` (Gatus's own clock), which travels in
  // `detail`/`metadata` separately. The same discipline `projectBeszelSystems`
  // and `projectTailscaleDevices` follow.
  const checkedAt = new Date();

  const currentKeys = new Set<string>();
  const resourceByKey = new Map<string, { id: string }>();

  for (const status of statuses) {
    if (excludedKey !== null && status.key === excludedKey) continue; // BINDING RULE 1 — never registered.
    try {
      const resource = await resourceLinks.upsertExternalResource({
        provider: GATUS_CONNECTION_PROVIDER,
        externalType: "endpoint",
        externalId: status.key,
        connectionId: connection.id,
        url: `${origin}/endpoints/${encodeURIComponent(status.key)}`,
        title: status.name ?? status.key,
        // Sync metadata only, per resource-links.ts's rule — the exact §4.2
        // payload, overwritten wholesale on every refresh. `readAt` is
        // Loxep's own clock; `observedAt` is Gatus's, kept distinct.
        metadata: {
          group: status.group,
          observedAt: status.observedAt,
          success: status.success,
          httpStatus: status.httpStatus,
          errorCount: status.errorCount,
          readAt: checkedAt.toISOString(),
        },
      });
      currentKeys.add(status.key);
      resourceByKey.set(status.key, resource);
    } catch {
      // One malformed endpoint must not take discovery down for the rest of
      // the connection — see `projectBeszelSystems`'s doc for the same rule.
    }
  }

  try {
    const allEndpointResources = await db.query.externalResources.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.provider, GATUS_CONNECTION_PROVIDER),
          eq(table.externalType, "endpoint"),
          eq(table.connectionId, connection.id),
        ),
    });
    const resourceIds = allEndpointResources.map((row) => row.id);
    const links =
      resourceIds.length === 0
        ? []
        : await db.query.resourceLinks.findMany({
            where: (table, { inArray }) => inArray(table.externalResourceId, resourceIds),
          });
    const linkedResourceIds = new Set(links.map((link) => link.externalResourceId));

    for (const status of statuses) {
      if (excludedKey !== null && status.key === excludedKey) continue;
      const resource = resourceByKey.get(status.key);
      if (resource === undefined || !linkedResourceIds.has(resource.id)) continue;
      const { status: healthStatus, detail } = gatusEndpointHealthStatus(status);
      await health.upsertHealth({
        subjectType: "external_resource",
        subjectId: resource.id,
        status: healthStatus,
        source: "adapter",
        checkedAt,
        detail,
      });
    }

    for (const resource of allEndpointResources) {
      if (!linkedResourceIds.has(resource.id)) continue;
      if (resource.externalId !== null && currentKeys.has(resource.externalId)) continue;
      // BINDING RULE 1, restated for the missing-endpoint diff: a resource
      // whose externalId equals the quarantined push key must never receive
      // a health row here either — it was deliberately excluded from
      // `currentKeys` above (never registered fresh), but an already-
      // existing row (registered before an operator later reused its key as
      // the push key) must stay untouched too, not get "helpfully" marked
      // endpoint_missing.
      if (excludedKey !== null && resource.externalId === excludedKey) continue;
      await health.upsertHealth({
        subjectType: "external_resource",
        subjectId: resource.id,
        status: "unknown",
        source: "adapter",
        checkedAt,
        detail: { kind: "endpoint_missing" },
      });
    }
  } catch {
    // The missing-endpoint diff is a best-effort enrichment over discovery
    // that already succeeded above — never allowed to reach the caller and
    // turn a working connection's own status into anything but what the
    // credential-proving read already decided.
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
  connection: Connection,
  db: LoxepDb,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getGatusAdapterForConnection(connection.id);
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
  // loxep-1au slice B: discovery + per-endpoint health, over the SAME
  // `direct`-posture statuses page just fetched above — never a second
  // `listEndpointStatuses()` call. Best-effort: never allowed to turn this
  // already-decided `status: 'ok'` outcome into anything else.
  await projectGatusEndpoints(db, services, connection, statuses);
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
// Tailscale — loxep-50t §2.2(c) Slice A, §1.3/§4 Slice B
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
 * The admin console's own device deep link. Verified against Tailscale's own
 * admin console (`https://login.tailscale.com/admin/machines/<nodeId>`) —
 * this is the console's fixed SaaS host, independent of whichever control
 * API `baseUrl` a connection is configured with (loxep-50t names no
 * enterprise/self-hosted admin-console equivalent, so this module does not
 * invent one).
 */
function tailscaleAdminConsoleDeviceUrl(nodeId: string): string {
  return `https://login.tailscale.com/admin/machines/${encodeURIComponent(nodeId)}`;
}

/**
 * Tailscale's per-device status mapping (loxep-50t §1.3) — a documented
 * judgment call, the same "one provider, one named vocabulary decision"
 * discipline `beszelSystemHealthStatus` above set:
 *
 * ```text
 * online                       -> ok        {}
 * offline                      -> degraded  { kind:'device_offline', lastSeen }
 * device absent from the read  -> unknown   { kind:'device_missing' }  (kept
 *                                             for future reference below,
 *                                             not this function — the device
 *                                             is not IN the read at all)
 * ```
 *
 * `offline` reads `degraded`, never `failing`: a device the operator's own
 * laptop simply put to sleep is not a fleet outage, and Loxep has no way to
 * distinguish "sleeping" from "network-partitioned" from `listDevices()`
 * alone — `degraded` is the honest "worth a second look, not yet a red
 * alert" word, matching the design's own tone discipline for a status
 * upstream does not itself enumerate as a failure.
 */
function tailscaleDeviceHealthStatus(
  device: Pick<TailscaleDeviceFact, "online" | "lastSeen">,
): { status: HealthStatus; detail: Record<string, unknown> } {
  if (device.online) return { status: "ok", detail: {} };
  return {
    status: "degraded",
    detail: { kind: "device_offline", lastSeen: device.lastSeen },
  };
}

/**
 * loxep-50t slice B: discovery + the per-device `external_resource` health
 * projection, as a side effect of the SAME `listDevices()` read that already
 * proves the connection's credential — "one read, three outputs", the same
 * shape `projectBeszelSystems` established.
 *
 * **Unlike Beszel, health is written ONLY for LINKED devices.** A tailnet
 * holds laptops and a contractor's phone; writing a health row per device
 * would fill the attention surface with a partner's iPad (loxep-50t §1.3:
 * "Only LINKED devices get a health row"). `external_resources` rows are
 * still upserted for EVERY observed device — linked or not — because the
 * attach picker's candidate list needs the full inventory; only the
 * `integration_health` write is gated on an existing `resource_links` row.
 *
 * **"Device absent from the read"** is the third status-mapping case §1.3
 * names, and it applies only to a device that WAS linked before but no
 * longer appears in this sweep's `listDevices()` page (removed from the
 * tailnet, or the token's device visibility narrowed) — the link itself is
 * never deleted here; a device vanishing is a fact worth showing, not a row
 * to silently drop.
 */
async function projectTailscaleDevices(
  db: LoxepDb,
  connection: Connection,
  devices: readonly TailscaleDeviceFact[],
): Promise<void> {
  const resourceLinks = createResourceLinksService({ db });
  const health = createHealthService({ db });
  // One shared read clock for this whole batch, distinct from each device's
  // own `lastSeen` (which travels in `detail`) — the same discipline
  // `projectBeszelSystems` follows.
  const checkedAt = new Date();

  const currentDeviceIds = new Set<string>();
  const resourceByDeviceId = new Map<string, { id: string }>();

  for (const device of devices) {
    try {
      const resource = await resourceLinks.upsertExternalResource({
        provider: TAILSCALE_CONNECTION_PROVIDER,
        externalType: "device",
        externalId: device.externalDeviceId,
        connectionId: connection.id,
        url: tailscaleAdminConsoleDeviceUrl(device.externalDeviceId),
        title: device.name ?? device.hostname ?? device.externalDeviceId,
        // Sync metadata only, per resource-links.ts's rule — the exact §1.3
        // payload, overwritten wholesale on every refresh.
        metadata: {
          observedAt: checkedAt.toISOString(),
          online: device.online,
          lastSeen: device.lastSeen,
          addresses: device.addresses,
          magicDnsName: device.name,
          os: device.os,
          authorized: device.authorized,
        },
      });
      currentDeviceIds.add(device.externalDeviceId);
      resourceByDeviceId.set(device.externalDeviceId, resource);
    } catch {
      // One malformed device must not take discovery down for the rest of
      // the tailnet — see `projectBeszelSystems`'s doc for the same rule.
    }
  }

  try {
    // Every tailscale device `external_resources` row this connection has
    // ever discovered — needed to find (a) which of THIS sweep's devices are
    // linked, and (b) any previously-linked device absent from this sweep.
    const allDeviceResources = await db.query.externalResources.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.provider, TAILSCALE_CONNECTION_PROVIDER),
          eq(table.externalType, "device"),
          eq(table.connectionId, connection.id),
        ),
    });
    const resourceIds = allDeviceResources.map((row) => row.id);
    const links =
      resourceIds.length === 0
        ? []
        : await db.query.resourceLinks.findMany({
            where: (table, { inArray }) => inArray(table.externalResourceId, resourceIds),
          });
    const linkedResourceIds = new Set(links.map((link) => link.externalResourceId));

    for (const device of devices) {
      const resource = resourceByDeviceId.get(device.externalDeviceId);
      if (resource === undefined || !linkedResourceIds.has(resource.id)) continue;
      const { status, detail } = tailscaleDeviceHealthStatus(device);
      await health.upsertHealth({
        subjectType: "external_resource",
        subjectId: resource.id,
        status,
        source: "adapter",
        checkedAt,
        detail,
      });
    }

    for (const resource of allDeviceResources) {
      if (!linkedResourceIds.has(resource.id)) continue;
      if (resource.externalId !== null && currentDeviceIds.has(resource.externalId)) continue;
      await health.upsertHealth({
        subjectType: "external_resource",
        subjectId: resource.id,
        status: "unknown",
        source: "adapter",
        checkedAt,
        detail: { kind: "device_missing" },
      });
    }
  } catch {
    // The missing-device sweep is a best-effort enrichment over discovery
    // that already succeeded above — never allowed to reach the caller and
    // turn a working connection's own status into anything but what the
    // credential-proving read already decided.
  }
}

/**
 * `listDevices()` IS the connection probe's one call — the same bulk read
 * `probe()` used to make internally and discard into a bare count now also
 * proves the credential (loxep-50t's own "no whoami endpoint … `probe()`
 * substitutes the devices read" applies just as well to `listDevices()`) and
 * feeds {@link projectTailscaleDevices} as a side effect, per this module's
 * "never a second call" rule. `probe()` itself is no longer called from this
 * composition root — see the function-level note on why that is safe.
 *
 * ```text
 * throws, kind 'auth'                              -> failing   { kind: 'auth', credentialMode }
 * throws, any other kind (network-level)            -> unknown   { kind: 'unreachable' }
 * ok, recorded expiry already past                -> degraded  { kind: 'credential_expiry_passed' }
 * ok, recorded expiry <= 14 days away              -> degraded  { kind: 'credential_expiring', daysRemaining, credentialMode }
 * ok, oauth_client mode                            -> ok        { authMode: 'oauth_client' }
 * ok, otherwise                                    -> ok        { deviceCount }
 * ```
 *
 * This reproduces `TailscaleAdapter.probe()`'s own internal behavior exactly:
 * that method's only special case is catching an `auth`-kind
 * `TailscaleAdapterError` and returning `{authenticated:false}` instead of
 * throwing; every other error (network-level, `rate_limited`, `not_found`,
 * `invalid_request`, `provider_unavailable`) it rethrows unchanged, which is
 * why this function's `unreachable` branch is safe as a catch-all for
 * "anything that is not `auth`".
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
  db: LoxepDb,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getTailscaleAdapterForConnection(connection.id);
  } catch (error) {
    return misconfiguredOutcome(error);
  }
  const { adapter } = handle;
  const credentialMode = adapter.capabilities().authMode;

  let devices: TailscaleDeviceFact[];
  try {
    devices = await adapter.listDevices();
  } catch (error) {
    if (error instanceof TailscaleAdapterError && error.kind === "auth") {
      return {
        status: "failing",
        detail: { kind: "auth", credentialMode },
        source: "adapter",
      };
    }
    return { status: "unknown", detail: { kind: "unreachable" }, source: "adapter" };
  }

  await projectTailscaleDevices(db, connection, devices);

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
    detail: { deviceCount: devices.length },
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
 * authenticated === false, authRejectedStatus 403  -> failing   { kind: 'auth', authRejectedStatus: 403 }
 * authenticated === false, authRejectedStatus 401  -> failing   { kind: 'auth', authRejectedStatus: 401 }
 * authenticated === false, authRejectedStatus null -> failing   { kind: 'auth' }
 * authenticated === true                            -> ok        { hostCount?, hostsReadable }
 * ```
 *
 * `authRejectedStatus` (loxep-tit, landing loxep-wvm §1.4's RECOMMENDED fix)
 * carries the distinction `probe()` used to swallow: 401 means the stored
 * password is wrong or was changed; 403 ("Password authentication is
 * currently disabled.") means this Termix instance is OIDC/SSO-only and no
 * password change will ever fix it. It is copied into `detail` ONLY when it
 * is 401 or 403 — a number, never a body, a header, or `providerMessage` (see
 * the module doc's "counts and short labels only" rule) — so a surface can
 * render the right operator sentence instead of a uniform "check your
 * password". When the status is unknown, `detail` stays exactly
 * `{ kind: 'auth' }`, the pre-existing fallback: the copy layer must then
 * carry both possibilities and assert neither.
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

/**
 * loxep-wvm §1.3/§4.2's per-host status mapping — the discovery counterpart
 * to `dockhandEnvironmentHealthStatus` above. `online` comes from `/status`,
 * which §4.2 calls "a fourth-hand signal with the weakest provenance in the
 * fleet" — live verification already found it `null` on a real instance (see
 * this module's own live-verification notes). NEVER `failing`: a `false`/
 * `null` reading is indistinguishable from "Termix reported nothing usable"
 * rather than a confirmed negative fact, so both collapse to `unknown` — the
 * same "don't assert a fact you can't back" posture every other status
 * mapping in this file applies to its own weak signal.
 */
function termixHostHealthStatus(host: TermixHostFact): HealthStatus {
  return host.online === true ? "ok" : "unknown";
}

/**
 * loxep-wvm §1.5/§3.2/§4.1: discovery + the per-host `external_resource`
 * health projection, as a side effect of the SAME `listHosts()` read the
 * connection probe already made best-effort — "one read, three outputs",
 * the same shape `projectBeszelSystems` established.
 *
 * Two rules make this narrower than every sibling `projectX` function in
 * this file:
 *
 * 1. **Never a name join.** `TermixHostFact.name` carries no uniqueness
 *    promise anywhere in a 274-path spec that never schematizes this
 *    response at all (§4.1) — unlike Dockhand's environment name, which hb7
 *    §3.1 sanctions specifically because BOTH sides guarantee uniqueness.
 *    Every Termix host is upserted keyed on `externalHostId` (`String(id)`,
 *    the one field the adapter treats as required) and left for the
 *    operator-confirmed picker to attach — never auto-linked. `ip` travels
 *    in `metadata.host` as a HINT only: the attach picker does not rank
 *    candidates at all (§4.1 — "the dialog does not support ranking… skip
 *    ranking entirely" rather than half-build it), and `ip` is NEVER written
 *    to `hosting_targets.address_v4/v6` — the same DNS-materializer rule
 *    loxep-50t states for Tailscale's device address applies here for the
 *    same reason (those columns are published A/AAAA records; a Termix
 *    host's `ip` is very often a LAN or tailnet address).
 * 2. **Per-host `integration_health` rows are written for LINKED hosts
 *    only** (wvm Slice B item 10) — narrower even than Tailscale's own
 *    "linked only" health-write rule, which still upserts `external_
 *    resources` unconditionally (matched here) but never gates on link
 *    state the way this function does. An operator has not confirmed an
 *    unlinked Termix host is even the machine Loxep thinks it is — writing
 *    a status for it would assert more than discovery actually knows.
 *
 * The active-session count (§3.2) is its OWN best-effort read —
 * `listSessions()`, genuinely separate from the `listHosts()` bulk read this
 * function otherwise reuses, called ONCE per batch (never per host) and
 * split by `hostId`. A failure here is swallowed exactly like a failure
 * reading one host: the chip is simply absent from `detail`, nothing else
 * changes. Session rows themselves are never read or stored — only the
 * count, per wvm §3's ceiling.
 */
async function projectTermixResources(
  db: LoxepDb,
  connection: Connection,
  adapter: TermixAdapter,
  hosts: readonly TermixHostFact[],
): Promise<void> {
  const rawBaseUrl = readTermixBaseUrl(connection.config);
  if (rawBaseUrl === null) return;
  let origin: string;
  try {
    origin = normalizeTermixBaseUrl(rawBaseUrl);
  } catch {
    return;
  }

  const resourceLinks = createResourceLinksService({ db });
  const health = createHealthService({ db });
  const checkedAt = new Date();

  // Best-effort, ONE extra call per batch, never allowed to affect
  // discovery, a host's status, or the connection's own outcome.
  let sessionCountByHostId: Map<string, number> | null = null;
  try {
    const sessions = await adapter.listSessions();
    const counts = new Map<string, number>();
    for (const session of sessions) {
      counts.set(session.hostId, (counts.get(session.hostId) ?? 0) + 1);
    }
    sessionCountByHostId = counts;
  } catch {
    sessionCountByHostId = null;
  }

  for (const host of hosts) {
    try {
      const resource = await resourceLinks.upsertExternalResource({
        provider: TERMIX_CONNECTION_PROVIDER,
        externalType: "host",
        externalId: host.externalHostId,
        connectionId: connection.id,
        // wvm §4.3's honest limitation: Loxep can construct the INSTANCE
        // ORIGIN only. No per-host UI route is documented or verified.
        url: origin,
        title: host.name ?? host.externalHostId,
        metadata: {
          host: host.ip,
          status: host.online === true ? "online" : host.online === false ? "offline" : null,
          observedAt: host.lastSeenAt,
        },
      });

      const link = await db.query.resourceLinks.findFirst({
        where: (table, { eq }) => eq(table.externalResourceId, resource.id),
      });
      if (link === undefined) continue; // Unlinked — see rule 2 above.

      const sessionCount = sessionCountByHostId?.get(host.externalHostId);
      await health.upsertHealth({
        subjectType: "external_resource",
        subjectId: resource.id,
        status: termixHostHealthStatus(host),
        source: "adapter",
        checkedAt,
        detail: {
          online: host.online,
          ...(sessionCount !== undefined ? { sessionCount } : {}),
        },
      });
    } catch {
      // One malformed/unreadable host must not take discovery down for the
      // rest of the fleet — see `projectBeszelSystems`'s doc for the same
      // posture.
    }
  }
}

async function probeTermixConnection(
  services: FleetHealthServices,
  connection: Connection,
  db: LoxepDb,
): Promise<HealthProbeOutcome> {
  let handle;
  try {
    handle = await services.getTermixAdapterForConnection(connection.id);
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
    const authRejectedStatus = probeFact.authRejectedStatus;
    return {
      status: "failing",
      detail: {
        kind: "auth",
        ...(authRejectedStatus === 401 || authRejectedStatus === 403
          ? { authRejectedStatus }
          : {}),
      },
      source: "adapter",
    };
  }

  let detail: Record<string, unknown>;
  let hosts: TermixHostFact[] | null = null;
  try {
    hosts = await adapter.listHosts();
    detail = { hostCount: hosts.length, hostsReadable: true };
  } catch {
    // Best-effort only — see the function doc. Never downgrades `status`.
    detail = { hostsReadable: false };
  }

  // Discovery runs OUTSIDE the try/catch above and is itself fully
  // best-effort internally (see the function doc) — never allowed to turn a
  // successful `listHosts()` read's `hostCount`/`hostsReadable` detail into
  // the `catch` branch's honest-failure shape.
  if (hosts !== null) {
    await projectTermixResources(db, connection, adapter, hosts);
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
  db: LoxepDb,
): Promise<HealthProbeOutcome> {
  switch (connection.provider) {
    case BESZEL_CONNECTION_PROVIDER:
      return probeBeszelConnection(services, connection, db);
    case DOCKHAND_CONNECTION_PROVIDER:
      return probeDockhandConnection(services, connection, db);
    case GATUS_CONNECTION_PROVIDER:
      return probeGatusConnection(services, connection, db);
    case TAILSCALE_CONNECTION_PROVIDER:
      return probeTailscaleConnection(services, connection, db);
    case TERMIX_CONNECTION_PROVIDER:
      return probeTermixConnection(services, connection, db);
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

  const outcome = await probeFleetConnection(services, connection, db);
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
