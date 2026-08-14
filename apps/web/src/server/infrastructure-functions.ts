/**
 * Server functions for the `/infrastructure` workspace (Phase 7 milestone 3,
 * loxep-lmy.3).
 *
 * Handlers use dynamic imports so `@/server/admin` (and the server packages
 * behind it) stay out of the client bundle; only type-only imports from
 * server packages are allowed at the top level here — mirrors
 * `@/server/market-functions.ts` and `@/server/admin-functions.ts`.
 *
 * Role gates (ADR-0017): reads of ordinary product data call `requireSession`
 * (any authenticated member); mutations call `requireAdmin`.
 *
 * ## Two behaviors that are design constraints, restated here because a
 * server function is where they could be silently violated
 *
 * 1. **The new-domain form writes intent and enqueues, then returns — it
 *    never awaits a provider call.** {@link createManagedDomain} calls
 *    `managedDomains.create`, which enqueues `infrastructure.materialize-
 *    records` in the SAME database transaction and returns immediately. There
 *    is no code path here that talks to a DNS provider synchronously.
 * 2. **Minting a token is a request-scoped admin action, never a job.**
 *    {@link mintDnsProviderToken} calls `tokens.mint` directly, in this
 *    handler, and returns the plaintext value in ITS OWN response — the one
 *    channel ADR-0022 permits. No function here enqueues a mint.
 *
 * Secret values are never rendered by any OTHER surface: {@link
 * mintDnsProviderToken} and {@link rollDnsProviderToken} are the only two
 * functions in this module whose return type carries a `value` field.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { JsonValue } from '@/server/admin-functions';
import type { TailnetAddressKind } from '@loxep/infrastructure';
import type {
  HealthSource,
  HealthStatus,
  HostDiagnosisInput,
  HostDiagnosisResult
} from '@loxep/domain';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Shared option lists
// ---------------------------------------------------------------------------

export interface ConnectionOptionDto {
  id: string;
  name: string;
  status: string;
}

/** DNS-provider connections (`connections.kind = 'dns'`) for the new-domain wizard. */
export const fetchDnsConnectionOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().connections.listConnections({ kind: 'dns' });
    return rows.map((row) => ({ id: row.id, name: row.name, status: row.status }));
  }
);

/** Mail-provider connections (`connections.kind = 'mail'`) for "enable mail". */
export const fetchMailConnectionOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().connections.listConnections({ kind: 'mail' });
    return rows.map((row) => ({ id: row.id, name: row.name, status: row.status }));
  }
);

export interface HostingTargetOptionDto {
  id: string;
  name: string;
  controlSurface: string;
}

/** Every non-decommissioned hosting target, for the apex-target and mint-scope pickers. */
export const fetchHostingTargetOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<HostingTargetOptionDto[]> => {
    const { requireSession, getHostingTargetsService } = await import('@/server/admin');
    await requireSession();
    const rows = await getHostingTargetsService().list();
    return rows
      .filter((row) => row.decommissionedAt === null)
      .map((row) => ({ id: row.id, name: row.name, controlSurface: row.controlSurface }));
  }
);

// ---------------------------------------------------------------------------
// Fleet signals (loxep-cum) — the honest rollup over the five fleet
// providers' CONNECTION-level `integration_health` rows.
//
// This is a VISIBILITY layer on top of rf4's already-shipped connection
// probes (`packages/app/src/fleet-health.ts`, extended per-provider by
// loxep-hb7/loxep-y64/loxep-50t/loxep-wvm/loxep-1au) — it reads what those
// probes already write, aggregates it, and adds nothing new to the sweep.
//
// `computeFleetSignals` is a PURE function of two arrays this route's own
// handler already needs (`connections`, plus `integration_health` rows for
// `subjectType: 'connection'`) so it has no import-time dependency on any
// server package: a caller passes in plain objects it already fetched. This
// is exported specifically so loxep-9m2's main-dashboard Operations band —
// which already fetches both of those same two arrays in
// `dashboard-functions.ts`'s `fetchDashboardOperations` — can fold this
// rollup into its own response by calling this function with its own
// already-fetched `connections`/`connectionHealth`, rather than by growing a
// sixth hand-maintained provider-literal list next to `ORDER_SYNC_TARGET_TYPES`
// and friends.
//
// ## Anti-soup / witness-not-verdict, applied at THIS granularity
//
// Every count here is an aggregate of ONE provider's OWN connections — never
// a cross-tool merge. There is no page-level "fleet health" verdict anywhere
// in this module; each `FleetProviderSignalDto` stands alone, and the caller
// must render (or omit) each independently. A provider with zero connections
// gets `connectionCount: 0` and no `summary` — the RENDERER's job is to skip
// it entirely ("absent renders absent, never green"), never to show a grey
// "0" tile that could be mistaken for "checked and fine".
//
// ## Why every number here is defensively read, never assumed
//
// `detail` is `Record<string, unknown>` from the DB, not a typed fact —
// `guardHealthDetail` only constrains its SHAPE (no secrets, no raw bodies),
// never its keys. `numberField`/`stringField`/`boolField` below read a named
// key only when it is actually that type; anything else is treated as
// "this connection did not report that field" (silently excluded from the
// sum), never coerced or defaulted to zero. A provider whose every connection
// is `failing`/`unknown`/never-checked legitimately produces `summary: null`
// — the caller renders that as "not reporting", never as "0".
// ---------------------------------------------------------------------------

export const FLEET_PROVIDERS = ['tailscale', 'beszel', 'dockhand', 'gatus', 'termix'] as const;
export type FleetProvider = (typeof FLEET_PROVIDERS)[number];

export interface FleetProviderSignalDto {
  provider: FleetProvider;
  /** Connections of this provider Loxep knows about, whether or not the sweep has reached them yet. */
  connectionCount: number;
  okCount: number;
  degradedCount: number;
  failingCount: number;
  /** Health row exists (Loxep reached the sweep) but the probe could not determine a status. */
  unknownCount: number;
  /** No `integration_health` row at all yet — the sweep has never reached this connection. */
  uncheckedCount: number;
  /** Most recent `checkedAt` across this provider's connections that have ever been checked. */
  lastCheckedAt: string | null;
  /** A short, counts-only sentence built ONLY from fields this provider's `ok`/`degraded` connections actually reported. `null` when nothing reported one. */
  summary: string | null;
  /** A secondary, honest caveat about connections this provider's `summary` could not fold in (e.g. an OAuth-mode Tailscale connection that reports no device count). `null` when there is nothing to caveat. */
  note: string | null;
}

/**
 * The Gatus heartbeat mirror (loxep-1au §3) — Gatus's own opinion of Loxep's
 * heartbeat endpoint, already computed by the connection probe and folded
 * into `detail.heartbeat`. Rendered here as its OWN block, never as a health
 * subject and never influencing any status — see fleet-health.ts's "BINDING
 * RULE 1" doc. This DTO's `checkedAt` is Loxep's read clock; `gatusObservedAt`
 * is Gatus's own evaluation instant — two distinct clocks, never collapsed.
 */
export interface FleetHeartbeatMirrorDto {
  connectionId: string;
  connectionName: string;
  configuredKey: string;
  keyFound: boolean;
  uptime24h: number | null;
  gatusObservedAt: string | null;
  gatusSuccess: boolean | null;
  source: string;
  checkedAt: string;
}

export interface FleetSignalsDto {
  /** Always five entries, one per {@link FLEET_PROVIDERS} member, in that fixed order — network reachability, agent, daemon, service, access. */
  providers: FleetProviderSignalDto[];
  /** `null` when no Gatus connection's base URL matches the configured push target, more than one does (ambiguous), or the push is unconfigured/disabled — see fleet-health.ts's matching rule. */
  heartbeat: FleetHeartbeatMirrorDto | null;
}

/** The minimal connection shape this module needs — structurally satisfied by `@loxep/domain`'s `Connection` without importing it. */
export interface FleetSignalConnectionInput {
  id: string;
  name: string;
  provider: string;
}

/** The minimal `integration_health` row shape this module needs — structurally satisfied by `@loxep/domain`'s `HealthRow` without importing it. */
export interface FleetSignalHealthInput {
  subjectId: string;
  status: string;
  detail: Record<string, unknown>;
  checkedAt: Date;
}

function numberField(detail: Record<string, unknown>, key: string): number | null {
  const value = detail[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  return typeof value === 'string' ? value : null;
}

function boolField(detail: Record<string, unknown>, key: string): boolean | null {
  const value = detail[key];
  return typeof value === 'boolean' ? value : null;
}

function plural(count: number, singular: string, plural_: string = `${singular}s`): string {
  return count === 1 ? singular : plural_;
}

interface FleetSignalProviderRow {
  status: string;
  detail: Record<string, unknown>;
}

/** loxep-y64 §1 `detail`: `{ systems, up, notUp, hubReachable }` on `status: 'ok'` rows only. */
function beszelSummary(rows: FleetSignalProviderRow[]): {
  summary: string | null;
  note: string | null;
} {
  let systems = 0;
  let up = 0;
  let counted = 0;
  for (const row of rows) {
    if (row.status !== 'ok') continue;
    const s = numberField(row.detail, 'systems');
    const u = numberField(row.detail, 'up');
    if (s === null || u === null) continue;
    systems += s;
    up += u;
    counted += 1;
  }
  if (counted === 0) return { summary: null, note: null };
  return { summary: `${up} of ${systems} Beszel ${plural(systems, 'host')} up`, note: null };
}

/**
 * loxep-hb7 §1.2 `detail`: `{ authMode: 'session', hostCount }` on the
 * common path, or `{ authMode: 'disabled' }` (no `hostCount` at all — the
 * probe stops before calling `listHosts()`) when the Dockhand instance has
 * its own auth turned off. A Dockhand "environment" IS a registered host —
 * there is no further nesting — so `hostCount` summed across connections is
 * the honest "environments registered" figure. Container/stack counts are
 * NOT available at this granularity (they need a live per-host read, which
 * is `/infrastructure/fleet/$name`'s scope, not this fleet-wide rollup's —
 * see this bead's report for why that panel was not built this pass).
 */
function dockhandSummary(rows: FleetSignalProviderRow[]): {
  summary: string | null;
  note: string | null;
} {
  let hosts = 0;
  let counted = 0;
  let authDisabledCount = 0;
  for (const row of rows) {
    if (row.status !== 'ok') continue;
    if (stringField(row.detail, 'authMode') === 'disabled') {
      authDisabledCount += 1;
      continue;
    }
    const hostCount = numberField(row.detail, 'hostCount');
    if (hostCount === null) continue;
    hosts += hostCount;
    counted += 1;
  }
  const summary =
    counted === 0 ? null : `${hosts} Dockhand ${plural(hosts, 'environment')} registered`;
  const note =
    authDisabledCount === 0
      ? null
      : `${authDisabledCount} Dockhand ${plural(authDisabledCount, 'connection')} ${plural(authDisabledCount, 'has', 'have')} authentication turned off on the instance itself`;
  return { summary, note };
}

/**
 * loxep-1au §2.3 `detail`: `{ posture, endpointCount, failingCount }` on
 * `open`/`basic` posture `ok` rows only — OIDC-posture rows carry neither
 * (the bulk statuses route is unwinnable there, per the design).
 */
function gatusSummary(rows: FleetSignalProviderRow[]): {
  summary: string | null;
  note: string | null;
} {
  let endpoints = 0;
  let failing = 0;
  let counted = 0;
  let oidcCount = 0;
  for (const row of rows) {
    if (row.status === 'ok' || row.status === 'degraded') {
      const endpointCount = numberField(row.detail, 'endpointCount');
      const failingCount = numberField(row.detail, 'failingCount');
      if (endpointCount !== null && failingCount !== null) {
        endpoints += endpointCount;
        failing += failingCount;
        counted += 1;
        continue;
      }
    }
    if (stringField(row.detail, 'posture') === 'oidc') oidcCount += 1;
  }
  const summary =
    counted === 0
      ? null
      : `${endpoints - failing} of ${endpoints} Gatus ${plural(endpoints, 'endpoint')} up`;
  const note =
    oidcCount === 0
      ? null
      : `${oidcCount} OIDC-secured Gatus ${plural(oidcCount, 'connection')} — Loxep cannot bulk-read endpoint counts there`;
  return { summary, note };
}

/**
 * loxep-50t §2.2(c) `detail`: `{ deviceCount }` on `ok` rows using an API
 * access token, or `{ authMode: 'oauth_client' }` with NO `deviceCount` at
 * all (per the design's own mapping table) when the connection uses the
 * recommended OAuth-client mode. This is not a gap in this rollup — it is
 * what the shipped probe reports — so an all-OAuth fleet legitimately
 * produces `summary: null` with an honest `note` instead of a fabricated 0.
 */
function tailscaleSummary(rows: FleetSignalProviderRow[]): {
  summary: string | null;
  note: string | null;
} {
  let devices = 0;
  let counted = 0;
  let oauthCount = 0;
  for (const row of rows) {
    if (row.status !== 'ok') continue;
    if (stringField(row.detail, 'authMode') === 'oauth_client') {
      oauthCount += 1;
      continue;
    }
    const deviceCount = numberField(row.detail, 'deviceCount');
    if (deviceCount === null) continue;
    devices += deviceCount;
    counted += 1;
  }
  const summary = counted === 0 ? null : `${devices} tailnet ${plural(devices, 'device')}`;
  const note =
    oauthCount === 0
      ? null
      : `${oauthCount} OAuth-authenticated Tailscale ${plural(oauthCount, 'connection')} — Loxep does not read a device count there`;
  return { summary, note };
}

/**
 * loxep-wvm §1.5 `detail`: `{ hostCount, hostsReadable: true }` on `ok` rows
 * when the best-effort `listHosts()` enrichment succeeded, or
 * `{ hostsReadable: false }` (no `hostCount`) when it did not — which must
 * NEVER downgrade the connection's own `ok` status, and does not downgrade
 * this rollup's summary either; it becomes an honest `note` instead.
 */
function termixSummary(rows: FleetSignalProviderRow[]): {
  summary: string | null;
  note: string | null;
} {
  let hosts = 0;
  let counted = 0;
  let unreadableCount = 0;
  for (const row of rows) {
    if (row.status !== 'ok') continue;
    if (boolField(row.detail, 'hostsReadable') === false) {
      unreadableCount += 1;
      continue;
    }
    const hostCount = numberField(row.detail, 'hostCount');
    if (hostCount === null) continue;
    hosts += hostCount;
    counted += 1;
  }
  const summary = counted === 0 ? null : `${hosts} Termix ${plural(hosts, 'host')} registered`;
  const note =
    unreadableCount === 0
      ? null
      : `Host list unreadable on ${unreadableCount} otherwise-healthy Termix ${plural(unreadableCount, 'connection')}`;
  return { summary, note };
}

const PROVIDER_SUMMARIZERS: Record<
  FleetProvider,
  (rows: FleetSignalProviderRow[]) => { summary: string | null; note: string | null }
> = {
  beszel: beszelSummary,
  dockhand: dockhandSummary,
  gatus: gatusSummary,
  tailscale: tailscaleSummary,
  termix: termixSummary
};

/**
 * Gatus's mirror of Loxep's own heartbeat (loxep-1au §3.3), read straight out
 * of whichever Gatus connection's `detail.heartbeat` is present — the probe
 * only ever populates it on the ONE connection matching the configured push
 * target (its own ambiguity guard already refuses to guess between two), so
 * "first match" is "the only possible match", not a real ambiguity here.
 */
function extractHeartbeat(
  connections: FleetSignalConnectionInput[],
  healthByConnectionId: Map<string, FleetSignalHealthInput>
): FleetHeartbeatMirrorDto | null {
  for (const connection of connections) {
    if (connection.provider !== 'gatus') continue;
    const row = healthByConnectionId.get(connection.id);
    if (row === undefined) continue;
    const raw = row.detail['heartbeat'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const heartbeat = raw as Record<string, unknown>;
    const configuredKey = stringField(heartbeat, 'configuredKey');
    const keyFound = boolField(heartbeat, 'keyFound');
    if (configuredKey === null || keyFound === null) continue;
    return {
      connectionId: connection.id,
      connectionName: connection.name,
      configuredKey,
      keyFound,
      uptime24h: numberField(heartbeat, 'uptime24h'),
      gatusObservedAt: stringField(heartbeat, 'gatusObservedAt'),
      gatusSuccess: boolField(heartbeat, 'gatusSuccess'),
      source: stringField(heartbeat, 'source') ?? 'unknown',
      checkedAt: iso(row.checkedAt)
    };
  }
  return null;
}

/** See this section's module doc — the pure rollup 9m2 can call directly. */
export function computeFleetSignals(
  connections: FleetSignalConnectionInput[],
  connectionHealth: FleetSignalHealthInput[]
): FleetSignalsDto {
  const healthByConnectionId = new Map(connectionHealth.map((row) => [row.subjectId, row]));

  const providers = FLEET_PROVIDERS.map((provider) => {
    const providerConnections = connections.filter(
      (connection) => connection.provider === provider
    );
    const rows: FleetSignalProviderRow[] = [];
    let okCount = 0;
    let degradedCount = 0;
    let failingCount = 0;
    let unknownCount = 0;
    let uncheckedCount = 0;
    let lastCheckedAt: Date | null = null;

    for (const connection of providerConnections) {
      const health = healthByConnectionId.get(connection.id);
      if (health === undefined) {
        uncheckedCount += 1;
        continue;
      }
      rows.push({ status: health.status, detail: health.detail });
      if (lastCheckedAt === null || health.checkedAt > lastCheckedAt)
        lastCheckedAt = health.checkedAt;
      if (health.status === 'ok') okCount += 1;
      else if (health.status === 'degraded') degradedCount += 1;
      else if (health.status === 'failing') failingCount += 1;
      else unknownCount += 1;
    }

    const { summary, note } = PROVIDER_SUMMARIZERS[provider](rows);

    return {
      provider,
      connectionCount: providerConnections.length,
      okCount,
      degradedCount,
      failingCount,
      unknownCount,
      uncheckedCount,
      lastCheckedAt: lastCheckedAt === null ? null : iso(lastCheckedAt),
      summary,
      note
    } satisfies FleetProviderSignalDto;
  });

  return { providers, heartbeat: extractHeartbeat(connections, healthByConnectionId) };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface InfrastructureOverviewDto {
  domainCount: number;
  domainsNeedingAttentionCount: number;
  hostingTargetCount: number;
  dnsProviderTokenCount: number;
  unresolvedDriftCount: number;
  domainsNeedingAttention: {
    id: string;
    name: string;
    state: string;
    driftDetectedAt: string | null;
    lastErrorCode: string | null;
  }[];
  recentRuns: {
    id: string;
    kind: string;
    subjectType: string;
    status: string;
    mode: string;
    startedAt: string;
    finishedAt: string | null;
  }[];
  /** loxep-cum's fleet signals band — see the section above for what each provider's summary/note means and why. */
  fleetSignals: FleetSignalsDto;
}

export const fetchInfrastructureOverview = createServerFn({ method: 'GET' }).handler(
  async (): Promise<InfrastructureOverviewDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const admin = getAdminServices();
    const { handle } = admin;

    const [
      domains,
      hostingTargets,
      tokens,
      unresolvedDrift,
      recentRuns,
      connections,
      connectionHealth
    ] = await Promise.all([
      handle.db.query.managedDomains.findMany(),
      handle.db.query.hostingTargets.findMany({
        where: (table, { isNull }) => isNull(table.decommissionedAt)
      }),
      handle.db.query.dnsProviderTokens.findMany(),
      handle.db.query.dnsDriftFindings.findMany({
        where: (table, { isNull }) => isNull(table.resolvedAt)
      }),
      handle.db.query.reconcileRuns.findMany({
        orderBy: (table, { desc }) => [desc(table.startedAt)],
        limit: 10
      }),
      admin.connections.listConnections(),
      // Phase 8 (loxep-cum): the same `integration_health` rows rf4's
      // fleet probes already write, read here for the fleet signals band —
      // never written to, never driving retry/backoff (that stays
      // `connections.status`'s job).
      admin.health.listHealth({ subjectType: 'connection' })
    ]);

    const needingAttention = domains.filter(
      (domain) => domain.state !== 'ready' || domain.driftDetectedAt !== null
    );

    return {
      domainCount: domains.length,
      domainsNeedingAttentionCount: needingAttention.length,
      hostingTargetCount: hostingTargets.length,
      dnsProviderTokenCount: tokens.length,
      unresolvedDriftCount: unresolvedDrift.length,
      domainsNeedingAttention: needingAttention.slice(0, 10).map((domain) => ({
        id: domain.id,
        name: domain.name,
        state: domain.state,
        driftDetectedAt: iso(domain.driftDetectedAt),
        lastErrorCode: domain.lastErrorCode
      })),
      recentRuns: recentRuns.map((run) => ({
        id: run.id,
        kind: run.kind,
        subjectType: run.subjectType,
        status: run.status,
        mode: run.mode,
        startedAt: iso(run.startedAt),
        finishedAt: iso(run.finishedAt)
      })),
      fleetSignals: computeFleetSignals(connections, connectionHealth)
    };
  }
);

// ---------------------------------------------------------------------------
// Managed domains (loxep-lmy.3)
// ---------------------------------------------------------------------------

export interface ManagedDomainDto {
  id: string;
  name: string;
  state: string;
  dnsConnectionId: string;
  apexTargetId: string | null;
  apexTargetName: string | null;
  apexProxied: boolean;
  wildcardProxied: boolean;
  mailEnabled: boolean;
  mailRegistered: boolean;
  mailVerified: boolean;
  registrar: string | null;
  zoneNameservers: string[] | null;
  driftDetectedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  lastReconciledAt: string | null;
  createdAt: string;
}

export const fetchManagedDomains = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ManagedDomainDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const [domains, hostingTargets, mailDomains] = await Promise.all([
      handle.db.query.managedDomains.findMany({
        orderBy: (table, { asc }) => [asc(table.name)]
      }),
      handle.db.query.hostingTargets.findMany({ columns: { id: true, name: true } }),
      handle.db.query.mailDomains.findMany({
        columns: { domainId: true, providerAddedAt: true, ownershipVerifiedAt: true }
      })
    ]);
    const targetNameById = new Map(hostingTargets.map((row) => [row.id, row.name]));
    const mailByDomainId = new Map(mailDomains.map((row) => [row.domainId, row]));

    return domains.map((domain) => {
      const mail = mailByDomainId.get(domain.id);
      return {
        id: domain.id,
        name: domain.name,
        state: domain.state,
        dnsConnectionId: domain.dnsConnectionId,
        apexTargetId: domain.apexTargetId,
        apexTargetName: domain.apexTargetId
          ? (targetNameById.get(domain.apexTargetId) ?? null)
          : null,
        apexProxied: domain.apexProxied,
        wildcardProxied: domain.wildcardProxied,
        mailEnabled: domain.mailEnabled,
        mailRegistered: mail?.providerAddedAt !== undefined && mail.providerAddedAt !== null,
        mailVerified: mail?.ownershipVerifiedAt !== undefined && mail.ownershipVerifiedAt !== null,
        registrar: domain.registrar,
        zoneNameservers: domain.zoneNameservers,
        driftDetectedAt: iso(domain.driftDetectedAt),
        lastErrorAt: iso(domain.lastErrorAt),
        lastErrorCode: domain.lastErrorCode,
        lastReconciledAt: iso(domain.lastReconciledAt),
        createdAt: iso(domain.createdAt)
      };
    });
  }
);

export interface DnsRecordDto {
  id: string;
  type: string;
  name: string;
  content: string;
  ttlSeconds: number | null;
  proxied: boolean;
  owner: string;
  lastSyncedAt: string | null;
}

export interface DnsDriftFindingDto {
  id: string;
  kind: string;
  recordType: string;
  recordName: string;
  desiredContent: string | null;
  observedContent: string | null;
  desiredProxied: boolean | null;
  observedProxied: boolean | null;
  firstDetectedAt: string;
  lastDetectedAt: string;
}

export interface MailboxDto {
  id: string;
  localPart: string;
  kind: string;
  forwardTo: string | null;
  hasSecret: boolean;
  providerCreatedAt: string | null;
  desiredDeletedAt: string | null;
}

export interface MailStateDto {
  mailConnectionId: string;
  providerAddedAt: string | null;
  ownershipVerifiedAt: string | null;
  verifyAttempts: number;
  lastVerifyError: string | null;
  lastVerifyAt: string | null;
}

export interface ManagedDomainDetailDto extends ManagedDomainDto {
  records: DnsRecordDto[];
  unresolvedDrift: DnsDriftFindingDto[];
  mail: MailStateDto | null;
  mailboxes: MailboxDto[];
}

export const fetchManagedDomain = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ name: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<ManagedDomainDetailDto> => {
    const { requireSession, getAdminServices, getInfrastructureMailService, getDriftService } =
      await import('@/server/admin');
    await requireSession();
    const { managedDomains, hostingTargets: targets } = getAdminServices();
    const domain = await managedDomains.findByName(data.name);
    if (domain === null) {
      throw new Error(`Managed domain "${data.name}" not found`);
    }

    const mailService = getInfrastructureMailService();
    const drift = getDriftService();
    const [records, unresolvedDrift, mail, mailboxes, apexTarget] = await Promise.all([
      managedDomains.listRecords(domain.id),
      drift.listUnresolved(domain.id),
      mailService.find(domain.id),
      mailService.listMailboxes(domain.id),
      domain.apexTargetId ? targets.get(domain.apexTargetId).catch(() => null) : null
    ]);

    return {
      id: domain.id,
      name: domain.name,
      state: domain.state,
      dnsConnectionId: domain.dnsConnectionId,
      apexTargetId: domain.apexTargetId,
      apexTargetName: apexTarget?.name ?? null,
      apexProxied: domain.apexProxied,
      wildcardProxied: domain.wildcardProxied,
      mailEnabled: domain.mailEnabled,
      mailRegistered: mail?.providerAddedAt !== null && mail?.providerAddedAt !== undefined,
      mailVerified: mail?.ownershipVerifiedAt !== null && mail?.ownershipVerifiedAt !== undefined,
      registrar: domain.registrar,
      zoneNameservers: domain.zoneNameservers,
      driftDetectedAt: iso(domain.driftDetectedAt),
      lastErrorAt: iso(domain.lastErrorAt),
      lastErrorCode: domain.lastErrorCode,
      lastReconciledAt: iso(domain.lastReconciledAt),
      createdAt: iso(domain.createdAt),
      records: records.map((record) => ({
        id: record.id,
        type: record.type,
        name: record.name,
        content: record.content,
        ttlSeconds: record.ttlSeconds,
        proxied: record.proxied,
        owner: record.owner,
        lastSyncedAt: iso(record.lastSyncedAt)
      })),
      unresolvedDrift: unresolvedDrift.map((finding) => ({
        id: finding.id,
        kind: finding.kind,
        recordType: finding.recordType,
        recordName: finding.recordName,
        desiredContent: finding.desiredContent,
        observedContent: finding.observedContent,
        desiredProxied: finding.desiredProxied,
        observedProxied: finding.observedProxied,
        firstDetectedAt: iso(finding.firstDetectedAt),
        lastDetectedAt: iso(finding.lastDetectedAt)
      })),
      mail:
        mail === null
          ? null
          : {
              mailConnectionId: mail.mailConnectionId,
              providerAddedAt: iso(mail.providerAddedAt),
              ownershipVerifiedAt: iso(mail.ownershipVerifiedAt),
              verifyAttempts: mail.verifyAttempts,
              lastVerifyError: mail.lastVerifyError,
              lastVerifyAt: iso(mail.lastVerifyAt)
            },
      mailboxes: mailboxes.map((mailbox) => ({
        id: mailbox.id,
        localPart: mailbox.localPart,
        kind: mailbox.kind,
        forwardTo: mailbox.forwardTo,
        hasSecret: mailbox.secretId !== null,
        providerCreatedAt: iso(mailbox.providerCreatedAt),
        desiredDeletedAt: iso(mailbox.desiredDeletedAt)
      }))
    };
  });

const createManagedDomainInput = z.strictObject({
  name: z.string().trim().min(1),
  dnsConnectionId: z.uuid(),
  apexTargetId: z.uuid().nullish(),
  apexProxied: z.boolean().optional(),
  wildcardProxied: z.boolean().optional(),
  mailEnabled: z.boolean().optional(),
  registrar: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish()
});

/**
 * Writes intent and enqueues `infrastructure.materialize-records`, then
 * returns — it never awaits a provider call. The reconciler is asynchronous;
 * the caller redirects to the domain detail page, where state advances as
 * the worker (not this request) drives the provisioning chain forward.
 */
export const createManagedDomain = createServerFn({ method: 'POST' })
  .inputValidator(createManagedDomainInput)
  .handler(async ({ data }): Promise<{ id: string; name: string }> => {
    const { requireAdmin, getManagedDomainsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getManagedDomainsService().create({
      name: data.name,
      dnsConnectionId: data.dnsConnectionId,
      apexTargetId: data.apexTargetId,
      apexProxied: data.apexProxied,
      wildcardProxied: data.wildcardProxied,
      mailEnabled: data.mailEnabled,
      registrar: data.registrar,
      notes: data.notes,
      createdByUserId: session.user.id
    });
    return { id: row.id, name: row.name };
  });

const updateManagedDomainIntentInput = z.strictObject({
  id: z.uuid(),
  apexTargetId: z.uuid().nullish(),
  apexProxied: z.boolean().optional(),
  wildcardProxied: z.boolean().optional(),
  mailEnabled: z.boolean().optional(),
  registrar: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish()
});

export const updateManagedDomainIntent = createServerFn({ method: 'POST' })
  .inputValidator(updateManagedDomainIntentInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getManagedDomainsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const { id, ...patch } = data;
    const row = await getManagedDomainsService().updateIntent(id, {
      ...patch,
      actorUserId: session.user.id
    });
    return { id: row.id };
  });

/**
 * "Adopt": write the observed value into `dns_records` as a `manual` record.
 * Reality is never overwritten — intent catches up with it. The finding
 * itself resolves on the NEXT sync (as `disappeared`, once observed and
 * desired agree), matching `@loxep/infrastructure`'s own tested behavior
 * rather than marking it resolved optimistically here.
 */
export const adoptDriftFinding = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ domainId: z.uuid(), findingId: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices, getManagedDomainsService } =
      await import('@/server/admin');
    const session = await requireAdmin();
    const { handle } = getAdminServices();
    const finding = await handle.db.query.dnsDriftFindings.findFirst({
      where: (table, { eq }) => eq(table.id, data.findingId)
    });
    if (finding === undefined || finding.domainId !== data.domainId) {
      throw new Error(`Drift finding "${data.findingId}" not found`);
    }
    if (finding.observedContent === null) {
      throw new Error(
        'This finding has no observed value to adopt (a missing record has nothing to adopt).'
      );
    }
    const record = await getManagedDomainsService().addManualRecord(
      data.domainId,
      {
        type: finding.recordType,
        name: finding.recordName,
        content: finding.observedContent,
        proxied: finding.observedProxied ?? false,
        externalRecordId: finding.externalRecordId
      },
      { actorUserId: session.user.id }
    );
    return { id: record.id };
  });

export const dismissDriftFinding = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ findingId: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getDriftService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getDriftService().dismiss(data.findingId, { actorUserId: session.user.id });
    return { id: row.id };
  });

export const enableMailForDomain = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ domainId: z.uuid(), mailConnectionId: z.uuid() }))
  .handler(async ({ data }): Promise<{ domainId: string }> => {
    const { requireAdmin, getInfrastructureMailService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getInfrastructureMailService().enableMail(data.domainId, {
      mailConnectionId: data.mailConnectionId,
      actorUserId: session.user.id
    });
    return { domainId: row.domainId };
  });

export const applyDefaultMailboxTemplate = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ domainId: z.uuid() }))
  .handler(
    async ({ data }): Promise<{ created: number; resurrected: number; unchanged: number }> => {
      const { requireAdmin, getInfrastructureMailService } = await import('@/server/admin');
      const session = await requireAdmin();
      return getInfrastructureMailService().applyTemplate(data.domainId, undefined, {
        actorUserId: session.user.id
      });
    }
  );

/**
 * A manual "sync now": re-enqueues `infrastructure.sync-records` in `check`
 * mode. Enqueues rather than running inline — the same asynchronous shape
 * every intent-changing action here uses; the run's result shows up on
 * `/infrastructure/runs` once the worker processes it.
 */
export const requestDomainResync = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ domainId: z.uuid() }))
  .handler(async ({ data }): Promise<{ enqueued: true }> => {
    const [{ requireAdmin, getAdminServices, getInfrastructureEnqueue }, infrastructure] =
      await Promise.all([import('@/server/admin'), import('@loxep/infrastructure')]);
    await requireAdmin();
    const { handle } = getAdminServices();
    const enqueue = getInfrastructureEnqueue();
    await handle.db.transaction(async (tx) => {
      await enqueue(
        tx,
        infrastructure.SYNC_RECORDS_TASK,
        { domainId: data.domainId, mode: 'check', trigger: 'manual' },
        { jobKey: infrastructure.domainJobKey(infrastructure.SYNC_RECORDS_TASK, data.domainId) }
      );
    });
    return { enqueued: true };
  });

// ---------------------------------------------------------------------------
// Hosting targets / fleet (loxep-lmy.3)
// ---------------------------------------------------------------------------

export interface HostingTargetDto {
  id: string;
  name: string;
  controlSurface: string;
  provider: string | null;
  region: string | null;
  addressV4: string | null;
  addressV6: string | null;
  frontedByTargetId: string | null;
  frontedByTargetName: string | null;
  domainCount: number;
  tokenCount: number;
  decommissionedAt: string | null;
  createdAt: string;
}

export const fetchHostingTargets = createServerFn({ method: 'GET' }).handler(
  async (): Promise<HostingTargetDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const [targets, domains, tokens] = await Promise.all([
      handle.db.query.hostingTargets.findMany({ orderBy: (table, { asc }) => [asc(table.name)] }),
      handle.db.query.managedDomains.findMany({ columns: { apexTargetId: true } }),
      handle.db.query.dnsProviderTokens.findMany({ columns: { hostingTargetId: true } })
    ]);
    const nameById = new Map(targets.map((row) => [row.id, row.name]));
    const domainCountByTarget = new Map<string, number>();
    for (const domain of domains) {
      if (domain.apexTargetId === null) continue;
      domainCountByTarget.set(
        domain.apexTargetId,
        (domainCountByTarget.get(domain.apexTargetId) ?? 0) + 1
      );
    }
    const tokenCountByTarget = new Map<string, number>();
    for (const token of tokens) {
      tokenCountByTarget.set(
        token.hostingTargetId,
        (tokenCountByTarget.get(token.hostingTargetId) ?? 0) + 1
      );
    }

    return targets.map((target) => ({
      id: target.id,
      name: target.name,
      controlSurface: target.controlSurface,
      provider: target.provider,
      region: target.region,
      addressV4: target.addressV4,
      addressV6: target.addressV6,
      frontedByTargetId: target.frontedByTargetId,
      frontedByTargetName: target.frontedByTargetId
        ? (nameById.get(target.frontedByTargetId) ?? null)
        : null,
      domainCount: domainCountByTarget.get(target.id) ?? 0,
      tokenCount: tokenCountByTarget.get(target.id) ?? 0,
      decommissionedAt: iso(target.decommissionedAt),
      createdAt: iso(target.createdAt)
    }));
  }
);

/**
 * The `integration_health` projection for one companion link (loxep-ovj.3):
 * `subject_type = 'external_resource'`, `subject_id = ` the link's
 * `external_resources.id` — a DEDICATED row per link, never shared with
 * `hosting_target`, per the design's own rule ("a shared row would let
 * Gatus/Beszel/Dockhand race and the last sweep would win"). `null` when the
 * sweep has not reached this link yet (a brand-new link, or a provider with
 * no tier-2 health path at all — see `@loxep/domain`'s
 * `fleet-tool-registry.ts`) — the panel renders that as "no automated check"
 * rather than a fabricated status.
 *
 * `status`/`source` are `HealthStatus`/`HealthSource` verbatim (never
 * widened to `string`) so the client's tone/label maps stay exhaustive.
 * `checkedAt` is LOXEP's read clock — see the panel's rendering rule for why
 * this is never conflated with a tool's own reported timestamp (today's
 * probe is credential-free reachability only, so there IS no second clock
 * yet; a future adapter-sourced row may add one to `detail` without
 * widening this shape).
 */
export interface CompanionLinkHealthDto {
  status: HealthStatus;
  source: HealthSource;
  checkedAt: string;
  detail: Record<string, JsonValue>;
}

/**
 * One `resource_links` attachment, joined with the `external_resources` row
 * it points at (loxep-v5r.3's generic companion-link service). `id` is the
 * `external_resources` row id; `resourceId`/`purpose` are carried too so the
 * panel can address this exact attachment (the natural key includes both,
 * per `resource_links_resource_purpose_uq`) when removing it.
 */
export interface CompanionLinkDto {
  id: string;
  provider: string;
  externalType: string;
  url: string;
  title: string | null;
  resourceId: string;
  purpose: string;
  createdAt: string;
  /** loxep-ovj.3's tier-2 companion-link health projection — see {@link CompanionLinkHealthDto}. */
  health: CompanionLinkHealthDto | null;
  /**
   * `@loxep/domain`'s known-tool registry entry for this link's `provider`
   * (`fleet-tool-registry.ts`), or `null` for a provider the registry does
   * not know (a hand-typed tier-1 link, or a future non-fleet companion —
   * see `resource-links.ts`'s consolidation note). Threaded through as a DTO
   * field rather than importing the registry client-side, because
   * `@loxep/domain`'s barrel pulls in server-only packages that must stay
   * out of the client bundle — the same reason every other server-package
   * read in this file goes through a dynamic import.
   */
  knownTool: { label: string; embeddable: boolean } | null;
}

export interface DnsProviderTokenDto {
  id: string;
  name: string;
  externalTokenId: string;
  permissionScope: string;
  policySyncedAt: string | null;
  lastRolledAt: string | null;
  domainIds: string[];
  createdAt: string;
}

export interface HostingTargetDetailDto extends HostingTargetDto {
  frontedTargets: { id: string; name: string }[];
  domains: { id: string; name: string; state: string }[];
  tokens: DnsProviderTokenDto[];
  companionLinks: CompanionLinkDto[];
  /**
   * `null` unless the stored address itself falls in Tailscale's CGNAT or
   * ULA range (loxep-89h; loxep-50t §3.2). Classified here, server-side,
   * with the SAME `tailnetAddressKind` predicate `resolveHostingAddress`
   * refuses on — not a second copy of the CIDR literals — so the fleet
   * detail warning and the materializer's refusal can never disagree about
   * what counts as a tailnet address. Computed from `addressV4`/`addressV6`,
   * which this response already carries; no extra read.
   */
  addressV4TailnetKind: TailnetAddressKind | null;
  addressV6TailnetKind: TailnetAddressKind | null;
  /**
   * `@loxep/domain`'s `diagnoseHostWitnesses` (loxep-50t §3.1, loxep-1au §5,
   * loxep-y64 §4), computed from this target's LINKED tailscale/beszel/
   * dockhand/gatus companion links and their tier-2 health projections —
   * see `computeHostDiagnosisInput` below. Reused verbatim, never a second
   * sentence function: a `status`/`health` field on this type is exactly
   * what witness-not-verdict forbids, so the panel renders `sentence`
   * (naming its subjects) or the honest `'Not enough linked tools to say.'`
   * refusal, never a derived badge.
   */
  diagnosis: HostDiagnosisResult;
}

/** `failing` > `degraded` > `unknown` > `ok` — matches `@loxep/app`'s `gatus-push.ts` `STATUS_SEVERITY` convention (duplicated locally, not imported, since this file otherwise takes no `@loxep/app` dependency). */
const HEALTH_STATUS_SEVERITY: Record<HealthStatus, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  failing: 3
};

/**
 * Worst status among ONE provider's (possibly several) companion links on
 * this target; `undefined` when the provider has no link at all — "absent
 * renders absent" carried through to the diagnosis input too, per
 * `@loxep/domain`'s `host-diagnosis.ts` ("an unlinked witness contributes
 * NOTHING … not a key on `HostDiagnosisInput`").
 */
function worstCompanionHealthStatus(
  links: readonly CompanionLinkDto[],
  provider: string
): HealthStatus | undefined {
  const providerLinks = links.filter((link) => link.provider === provider);
  if (providerLinks.length === 0) return undefined;
  let worst: HealthStatus = 'ok';
  for (const link of providerLinks) {
    // A LINKED witness with no health row yet (the sweep has not reached it)
    // reads 'unknown' — Loxep genuinely does not know, a different fact from
    // "no link exists", per host-diagnosis.ts's "Absent ≠ green" section.
    const status = link.health?.status ?? 'unknown';
    if (HEALTH_STATUS_SEVERITY[status] > HEALTH_STATUS_SEVERITY[worst]) worst = status;
  }
  return worst;
}

/**
 * Builds `@loxep/domain`'s `HostDiagnosisInput` from this target's linked
 * companion tools and their tier-2 health projections (loxep-ovj.3).
 *
 * **Honesty note, worth restating at the one call site that matters:** every
 * non-null status here today comes from the credential-free tier-2
 * reachability probe (`source: 'probe'` — "Loxep pinged the tool's own
 * health path"). It answers "can Loxep reach this tool at all", not "is
 * THIS SPECIFIC system/device/endpoint up", which needs an authenticated
 * per-resource adapter read (loxep-hb7 Milestone B / loxep-y64 slice 3 /
 * loxep-50t slice B / loxep-wvm slice B — design-complete, unbuilt). Both
 * write to the SAME `integration_health` key (`subject_type=
 * 'external_resource'`, `subject_id=` the link id), so this function needs
 * no change when that richer data lands — `worstCompanionHealthStatus` just
 * starts reading a `source: 'adapter'` row instead of a `'probe'` one.
 * `tailscale` never gets a non-null status from THIS mechanism at all
 * (Tailscale has no unauthenticated health path — see `fleet-tool-
 * registry.ts`), and stays that way until that same future work lands.
 */
function computeHostDiagnosisInput(links: readonly CompanionLinkDto[]): HostDiagnosisInput {
  const input: HostDiagnosisInput = {};

  const tailscale = worstCompanionHealthStatus(links, 'tailscale');
  if (tailscale !== undefined) input.tailscale = { status: tailscale };
  const beszel = worstCompanionHealthStatus(links, 'beszel');
  if (beszel !== undefined) input.beszel = { status: beszel };
  const dockhand = worstCompanionHealthStatus(links, 'dockhand');
  if (dockhand !== undefined) input.dockhand = { status: dockhand };

  const gatusLinks = links.filter((link) => link.provider === 'gatus');
  if (gatusLinks.length > 0) {
    input.gatus = {
      total: gatusLinks.length,
      failing: gatusLinks.filter((link) => (link.health?.status ?? 'unknown') === 'failing').length
    };
  }

  return input;
}

export const fetchHostingTarget = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ name: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<HostingTargetDetailDto> => {
    const {
      requireSession,
      getAdminServices,
      getDnsProviderTokensService,
      getResourceLinksService
    } = await import('@/server/admin');
    // Dynamic, not top-level: `@loxep/infrastructure` pulls in server-only
    // packages (drizzle-orm, pg, graphile-worker via other modules in its
    // barrel) that must stay out of the client bundle — same reason every
    // other server-package access in this file goes through `@/server/admin`.
    const { tailnetAddressKind } = await import('@loxep/infrastructure');
    // `diagnoseHostWitnesses`, the known-tool registry, and its panel-order
    // comparator are all pure (no db, no network) — imported dynamically
    // anyway, matching this file's own rule that only TYPES from a server
    // package are allowed at the top level.
    const {
      compareFleetToolPanelOrder,
      diagnoseHostWitnesses,
      FLEET_TOOL_REGISTRY,
      isFleetToolProvider
    } = await import('@loxep/domain');
    await requireSession();
    const { handle, health } = getAdminServices();
    const target = await handle.db.query.hostingTargets.findFirst({
      where: (table, { eq }) => eq(table.name, data.name)
    });
    if (target === undefined) {
      throw new Error(`Hosting target "${data.name}" not found`);
    }

    const [frontedTargets, domains, tokens, tokenZoneRows, rawCompanionLinks, frontingNode] =
      await Promise.all([
        handle.db.query.hostingTargets.findMany({
          where: (table, { eq }) => eq(table.frontedByTargetId, target.id),
          columns: { id: true, name: true }
        }),
        handle.db.query.managedDomains.findMany({
          where: (table, { eq }) => eq(table.apexTargetId, target.id),
          columns: { id: true, name: true, state: true }
        }),
        getDnsProviderTokensService().listForTarget(target.id),
        handle.db.query.dnsProviderTokenZones.findMany(),
        // loxep-v5r.3's generic companion-link service — the SINGLE owner of
        // `external_resources`/`resource_links` reads/writes; this handler
        // no longer queries those two tables directly.
        getResourceLinksService().listLinksFor('hosting_target', target.id),
        target.frontedByTargetId
          ? handle.db.query.hostingTargets.findFirst({
              where: (table, { eq }) => eq(table.id, target.frontedByTargetId as string),
              columns: { id: true, name: true }
            })
          : null
      ]);

    // loxep-ovj.3: per-link `integration_health` projection
    // (`subject_type='external_resource'`, `subject_id=` the link's
    // `external_resources.id`) — one lookup per link, "tens of subjects" per
    // the design's own cost model, the same honest cost `runHealthSweep`
    // already takes for its own candidate lists.
    const healthByLinkId = new Map(
      (
        await Promise.all(
          rawCompanionLinks.map(async (link) => {
            const row = await health.getHealth('external_resource', link.externalResourceId);
            return [link.externalResourceId, row] as const;
          })
        )
      ).filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null)
    );

    const companionLinks: CompanionLinkDto[] = rawCompanionLinks
      .map((link) => {
        const row = healthByLinkId.get(link.externalResourceId) ?? null;
        return {
          id: link.externalResourceId,
          provider: link.provider,
          externalType: link.externalType,
          url: link.url,
          title: link.title,
          resourceId: link.resourceId,
          purpose: link.purpose,
          createdAt: iso(link.createdAt),
          health:
            row === null
              ? null
              : {
                  status: row.status,
                  source: row.source,
                  checkedAt: iso(row.checkedAt),
                  detail: row.detail as Record<string, JsonValue>
                },
          knownTool: isFleetToolProvider(link.provider)
            ? {
                label: FLEET_TOOL_REGISTRY[link.provider].label,
                embeddable: FLEET_TOOL_REGISTRY[link.provider].embeddable
              }
            : null
        };
      })
      // loxep-ovj.3's PROVISIONAL panel order (fundamental-first) — see
      // `fleet-tool-registry.ts`'s module doc for the full reasoning and
      // fleet-observability-design.md's "Where this surfaces" section for
      // the mirrored note. A provider the comparator does not know (a
      // hand-typed tier-1 link) sorts after every known fleet tool.
      .sort((a, b) => compareFleetToolPanelOrder(a.provider, b.provider));

    const diagnosis = diagnoseHostWitnesses(computeHostDiagnosisInput(companionLinks));

    const zonesByToken = new Map<string, string[]>();
    for (const row of tokenZoneRows) {
      const list = zonesByToken.get(row.tokenId) ?? [];
      list.push(row.domainId);
      zonesByToken.set(row.tokenId, list);
    }

    return {
      id: target.id,
      name: target.name,
      controlSurface: target.controlSurface,
      provider: target.provider,
      region: target.region,
      addressV4: target.addressV4,
      addressV6: target.addressV6,
      addressV4TailnetKind: target.addressV4 === null ? null : tailnetAddressKind(target.addressV4),
      addressV6TailnetKind: target.addressV6 === null ? null : tailnetAddressKind(target.addressV6),
      frontedByTargetId: target.frontedByTargetId,
      frontedByTargetName: frontingNode?.name ?? null,
      domainCount: domains.length,
      tokenCount: tokens.length,
      decommissionedAt: iso(target.decommissionedAt),
      createdAt: iso(target.createdAt),
      frontedTargets,
      domains,
      tokens: tokens.map((token) => ({
        id: token.id,
        name: token.name,
        externalTokenId: token.externalTokenId,
        permissionScope: token.permissionScope,
        policySyncedAt: iso(token.policySyncedAt),
        lastRolledAt: iso(token.lastRolledAt),
        domainIds: zonesByToken.get(token.id) ?? [],
        createdAt: iso(token.createdAt)
      })),
      companionLinks,
      diagnosis
    };
  });

const addCompanionLinkInput = z.strictObject({
  hostingTargetId: z.uuid(),
  provider: z.string().trim().min(1).max(100),
  externalType: z.string().trim().min(1).max(100),
  url: z.url(),
  title: z.string().trim().min(1).max(200).nullish(),
  /** Free text (loxep-v5r.3's generic tier-1 mechanism, no closed vocabulary yet). */
  purpose: z.string().trim().min(1).max(100)
});

/**
 * Adds one companion-tool link to a hosting target — the "Add tool link"
 * form the fleet detail page's `CompanionLinksPanel` renders. Writes through
 * `@loxep/domain`'s generic `resourceLinks.createLink` (loxep-v5r.3), the
 * single owner of `external_resources`/`resource_links` writes; this handler
 * does not touch either table directly.
 */
export const addCompanionLink = createServerFn({ method: 'POST' })
  .inputValidator(addCompanionLinkInput)
  .handler(async ({ data }): Promise<CompanionLinkDto> => {
    const { requireAdmin, getResourceLinksService } = await import('@/server/admin');
    const { FLEET_TOOL_REGISTRY, isFleetToolProvider } = await import('@loxep/domain');
    await requireAdmin();
    const link = await getResourceLinksService().createLink({
      provider: data.provider,
      externalType: data.externalType,
      url: data.url,
      title: data.title ?? null,
      resourceType: 'hosting_target',
      resourceId: data.hostingTargetId,
      purpose: data.purpose
    });
    return {
      id: link.externalResourceId,
      provider: link.provider,
      externalType: link.externalType,
      url: link.url,
      title: link.title,
      resourceId: link.resourceId,
      purpose: link.purpose,
      createdAt: iso(link.createdAt),
      // A freshly created link has no `integration_health` row yet — the
      // sweep has not reached it. `null` here is the same honest "no
      // automated check yet" the panel renders for any unprobed link, not a
      // fabricated status.
      health: null,
      knownTool: isFleetToolProvider(link.provider)
        ? {
            label: FLEET_TOOL_REGISTRY[link.provider].label,
            embeddable: FLEET_TOOL_REGISTRY[link.provider].embeddable
          }
        : null
    };
  });

const removeCompanionLinkInput = z.strictObject({
  externalResourceId: z.uuid(),
  hostingTargetId: z.uuid(),
  purpose: z.string().trim().min(1).max(100)
});

/** Removes one companion-tool link (loxep-v5r.3's generic `detachLink`, idempotent). */
export const removeCompanionLink = createServerFn({ method: 'POST' })
  .inputValidator(removeCompanionLinkInput)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { requireAdmin, getResourceLinksService } = await import('@/server/admin');
    await requireAdmin();
    await getResourceLinksService().detachLink({
      externalResourceId: data.externalResourceId,
      resourceType: 'hosting_target',
      resourceId: data.hostingTargetId,
      purpose: data.purpose
    });
    return { ok: true };
  });

const createHostingTargetInput = z.strictObject({
  name: z.string().trim().min(1),
  controlSurface: z.enum(['proxy_node', 'tunnel_client', 'direct_reverse_proxy', 'none']),
  provider: z.string().trim().min(1).nullish(),
  region: z.string().trim().min(1).nullish(),
  addressV4: z.string().trim().min(1).nullish(),
  addressV6: z.string().trim().min(1).nullish(),
  frontedByTargetId: z.uuid().nullish(),
  notes: z.string().trim().min(1).nullish()
});

export const createHostingTarget = createServerFn({ method: 'POST' })
  .inputValidator(createHostingTargetInput)
  .handler(async ({ data }): Promise<{ id: string; name: string }> => {
    const { requireAdmin, getHostingTargetsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getHostingTargetsService().create({
      ...data,
      createdByUserId: session.user.id
    });
    return { id: row.id, name: row.name };
  });

export const decommissionHostingTarget = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getHostingTargetsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getHostingTargetsService().decommission(data.id, {
      actorUserId: session.user.id
    });
    return { id: row.id };
  });

// ---------------------------------------------------------------------------
// Minted DNS tokens (loxep-lmy.3) — HARD CONSTRAINT: mint/roll are
// request-scoped admin actions, never enqueued. See the module doc.
// ---------------------------------------------------------------------------

const mintDnsProviderTokenInput = z.strictObject({
  hostingTargetId: z.uuid(),
  dnsConnectionId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  domainIds: z.array(z.uuid()).optional()
});

export interface MintedDnsProviderTokenDto {
  token: DnsProviderTokenDto;
  /**
   * The plaintext value. Present in THIS response only — ADR-0022's one-time
   * reveal. No other function in this module returns it, and nothing reads
   * it back afterward.
   */
  value: string;
}

export const mintDnsProviderToken = createServerFn({ method: 'POST' })
  .inputValidator(mintDnsProviderTokenInput)
  .handler(async ({ data }): Promise<MintedDnsProviderTokenDto> => {
    const { requireAdmin, getDnsProviderTokensService } = await import('@/server/admin');
    const session = await requireAdmin();
    const result = await getDnsProviderTokensService().mint({
      hostingTargetId: data.hostingTargetId,
      dnsConnectionId: data.dnsConnectionId,
      name: data.name,
      domainIds: data.domainIds,
      actorUserId: session.user.id
    });
    return {
      token: {
        id: result.token.id,
        name: result.token.name,
        externalTokenId: result.token.externalTokenId,
        permissionScope: result.token.permissionScope,
        policySyncedAt: iso(result.token.policySyncedAt),
        lastRolledAt: iso(result.token.lastRolledAt),
        domainIds: data.domainIds ?? [],
        createdAt: iso(result.token.createdAt)
      },
      value: result.value
    };
  });

export const setDnsProviderTokenZones = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ tokenId: z.uuid(), domainIds: z.array(z.uuid()) }))
  .handler(async ({ data }): Promise<{ domainIds: string[] }> => {
    const { requireAdmin, getDnsProviderTokensService } = await import('@/server/admin');
    const session = await requireAdmin();
    return getDnsProviderTokensService().setZones(data.tokenId, {
      domainIds: data.domainIds,
      actorUserId: session.user.id
    });
  });

/**
 * Rolling regenerates the value and is styled destructively in the UI —
 * scope editing and rolling are deliberately never neighbours. Also a
 * request-scoped admin action, for the same ADR-0022 reason `mint` is.
 */
export const rollDnsProviderToken = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ tokenId: z.uuid() }))
  .handler(async ({ data }): Promise<{ token: DnsProviderTokenDto; value: string }> => {
    const { requireAdmin, getDnsProviderTokensService, getAdminServices } =
      await import('@/server/admin');
    const session = await requireAdmin();
    const tokens = getDnsProviderTokensService();
    const result = await tokens.roll(data.tokenId, { actorUserId: session.user.id });
    const zones = await getAdminServices().handle.db.query.dnsProviderTokenZones.findMany({
      where: (table, { eq }) => eq(table.tokenId, data.tokenId),
      columns: { domainId: true }
    });
    return {
      token: {
        id: result.token.id,
        name: result.token.name,
        externalTokenId: result.token.externalTokenId,
        permissionScope: result.token.permissionScope,
        policySyncedAt: iso(result.token.policySyncedAt),
        lastRolledAt: iso(result.token.lastRolledAt),
        domainIds: zones.map((row) => row.domainId),
        createdAt: iso(result.token.createdAt)
      },
      value: result.value
    };
  });

/** Manual "sync policy now" — calls the idempotent, re-runnable half directly (see `tokens.ts`). */
export const requestDnsProviderTokenPolicySync = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ tokenId: z.uuid() }))
  .handler(async ({ data }): Promise<{ status: string; zoneCount: number }> => {
    const { requireAdmin, getDnsProviderTokensService } = await import('@/server/admin');
    await requireAdmin();
    const result = await getDnsProviderTokensService().syncPolicy(data.tokenId, {
      trigger: 'manual'
    });
    return { status: result.status, zoneCount: result.zoneCount };
  });

// ---------------------------------------------------------------------------
// Reconcile runs (loxep-lmy.3)
// ---------------------------------------------------------------------------

export interface ReconcileRunDto {
  id: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string | null;
  mode: string;
  status: string;
  trigger: string;
  stepCount: number;
  errorSummary: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const RECONCILE_RUNS_LIMIT = 100;

export const fetchReconcileRuns = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ReconcileRunDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const runs = await handle.db.query.reconcileRuns.findMany({
      orderBy: (table, { desc }) => [desc(table.startedAt)],
      limit: RECONCILE_RUNS_LIMIT
    });

    const domainIds = runs
      .filter((run) => run.subjectType === 'domain')
      .map((run) => run.subjectId);
    const tokenIds = runs.filter((run) => run.subjectType === 'token').map((run) => run.subjectId);
    const [domains, tokens] = await Promise.all([
      domainIds.length > 0
        ? handle.db.query.managedDomains.findMany({
            where: (table, { inArray }) => inArray(table.id, domainIds),
            columns: { id: true, name: true }
          })
        : [],
      tokenIds.length > 0
        ? handle.db.query.dnsProviderTokens.findMany({
            where: (table, { inArray }) => inArray(table.id, tokenIds),
            columns: { id: true, name: true }
          })
        : []
    ]);
    const domainNameById = new Map(domains.map((row) => [row.id, row.name]));
    const tokenNameById = new Map(tokens.map((row) => [row.id, row.name]));

    return runs.map((run) => ({
      id: run.id,
      kind: run.kind,
      subjectType: run.subjectType,
      subjectId: run.subjectId,
      subjectLabel:
        run.subjectType === 'domain'
          ? (domainNameById.get(run.subjectId) ?? null)
          : run.subjectType === 'token'
            ? (tokenNameById.get(run.subjectId) ?? null)
            : null,
      mode: run.mode,
      status: run.status,
      trigger: run.trigger,
      stepCount: run.stepCount,
      errorSummary: run.errorSummary,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt)
    }));
  }
);

export interface ReconcileRunStepDto {
  id: string;
  sequence: number;
  step: string;
  status: string;
  provider: string | null;
  requestSummary: Record<string, JsonValue> | null;
  responseSummary: Record<string, JsonValue> | null;
  errorCode: string | null;
  errorDetail: string | null;
  occurredAt: string;
}

export interface ReconcileRunDetailDto extends ReconcileRunDto {
  steps: ReconcileRunStepDto[];
}

export const fetchReconcileRun = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<ReconcileRunDetailDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const run = await handle.db.query.reconcileRuns.findFirst({
      where: (table, { eq }) => eq(table.id, data.id)
    });
    if (run === undefined) {
      throw new Error(`Reconcile run "${data.id}" not found`);
    }
    const steps = await handle.db.query.reconcileRunSteps.findMany({
      where: (table, { eq }) => eq(table.runId, data.id),
      orderBy: (table, { asc }) => [asc(table.sequence)]
    });

    let subjectLabel: string | null = null;
    if (run.subjectType === 'domain') {
      const domain = await handle.db.query.managedDomains.findFirst({
        where: (table, { eq }) => eq(table.id, run.subjectId),
        columns: { name: true }
      });
      subjectLabel = domain?.name ?? null;
    } else if (run.subjectType === 'token') {
      const token = await handle.db.query.dnsProviderTokens.findFirst({
        where: (table, { eq }) => eq(table.id, run.subjectId),
        columns: { name: true }
      });
      subjectLabel = token?.name ?? null;
    }

    return {
      id: run.id,
      kind: run.kind,
      subjectType: run.subjectType,
      subjectId: run.subjectId,
      subjectLabel,
      mode: run.mode,
      status: run.status,
      trigger: run.trigger,
      stepCount: run.stepCount,
      errorSummary: run.errorSummary,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt),
      steps: steps.map((step) => ({
        id: String(step.id),
        sequence: step.sequence,
        step: step.step,
        status: step.status,
        provider: step.provider,
        requestSummary: step.requestSummary as Record<string, JsonValue> | null,
        responseSummary: step.responseSummary as Record<string, JsonValue> | null,
        errorCode: step.errorCode,
        errorDetail: step.errorDetail,
        occurredAt: iso(step.occurredAt)
      }))
    };
  });

/**
 * "Retry" for `/infrastructure/runs/$id`: re-drives the SAME subject through
 * its reconciler, asynchronously. A `domain` subject re-enqueues
 * `sync-records` (check mode); a `token` subject re-runs the (idempotent)
 * policy sync directly, mirroring `requestDnsProviderTokenPolicySync`.
 */
export const retryReconcileRun = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ retried: boolean }> => {
    const {
      requireAdmin,
      getAdminServices,
      getInfrastructureEnqueue,
      getDnsProviderTokensService
    } = await import('@/server/admin');
    await requireAdmin();
    const { handle } = getAdminServices();
    const run = await handle.db.query.reconcileRuns.findFirst({
      where: (table, { eq }) => eq(table.id, data.id)
    });
    if (run === undefined) {
      throw new Error(`Reconcile run "${data.id}" not found`);
    }

    if (run.subjectType === 'domain') {
      const infrastructure = await import('@loxep/infrastructure');
      const enqueue = getInfrastructureEnqueue();
      await handle.db.transaction(async (tx) => {
        await enqueue(
          tx,
          infrastructure.SYNC_RECORDS_TASK,
          { domainId: run.subjectId, mode: 'check', trigger: 'manual' },
          { jobKey: infrastructure.domainJobKey(infrastructure.SYNC_RECORDS_TASK, run.subjectId) }
        );
      });
      return { retried: true };
    }
    if (run.subjectType === 'token') {
      await getDnsProviderTokensService().syncPolicy(run.subjectId, { trigger: 'manual' });
      return { retried: true };
    }
    throw new Error(`No retry action exists yet for subject type "${run.subjectType}"`);
  });
