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
import type {
  ProxyResourceRow,
  ProxyResourceRuleRow,
  TailnetAddressKind
} from '@loxep/infrastructure';
import type {
  CompanionLink,
  HealthSource,
  HealthStatus,
  HostDiagnosisInput,
  HostDiagnosisResult,
  ProviderWritePolicyTier
} from '@loxep/domain';
import type { DbHandle } from '@loxep/db';

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

/**
 * One `proxy_resource_rules` row, rendered where DNS drift renders (the
 * Pangolin chain design's own instruction — check-mode-only, so there is no
 * "apply" action here, only visibility).
 */
export interface ProxyResourceRuleDto {
  id: string;
  action: string;
  match: string;
  value: string;
  priority: number;
  enabled: boolean;
  /** Closed set: `template` | `manual` | `dynamic_ip`. See `dns_records.owner`'s precedent. */
  owner: string;
}

/**
 * One `proxy_resources` row — the chain's third link, rendered on both the
 * domain detail page (grouped by domain) and the fleet detail page (grouped
 * by hosting target). Milestone 2 (loxep-acj.2) shipped CHECK MODE ONLY;
 * milestone 4 (loxep-acj.4) adds the fields the Apply affordance needs to
 * render honestly — `connectionId`/`writePolicyTier` — without adding a
 * write action to THIS dto itself (the apply is per-DOMAIN, matching
 * `SYNC_PROXY_RESOURCE_TASK`'s own payload granularity; see
 * `requestProxyResourceDomainApply`).
 */
export interface ProxyResourceChainDto {
  id: string;
  domainId: string;
  domainName: string;
  hostingTargetId: string;
  hostingTargetName: string;
  /** `null` for an apex resource. */
  subdomain: string | null;
  fullDomain: string;
  mode: string;
  ssl: boolean;
  enabled: boolean;
  /** `null` until a check-mode plan first matches this resource by full domain. */
  externalResourceId: string | null;
  rules: ProxyResourceRuleDto[];
  lastRun: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
  } | null;
  /**
   * "Pangolin knows about N resources Loxep does not" — the design's own
   * phrasing. `null` when no run has ever completed for this resource (never
   * rendered as zero, which would read as "checked, and found nothing").
   */
  unmatchedObservedCount: number | null;
  /** This resource's hosting target's linked Pangolin connection, or `null` when unlinked. */
  connectionId: string | null;
  /**
   * The connection's stored `infrastructure.provider_write_policy` tier —
   * `null` when `connectionId` is `null`. Read fresh on every fetch (never
   * cached client-side) so the Apply affordance's blocked/enabled state
   * always reflects the CURRENT flip, not a stale one.
   */
  writePolicyTier: ProviderWritePolicyTier | null;
}

export interface ManagedDomainDetailDto extends ManagedDomainDto {
  records: DnsRecordDto[];
  unresolvedDrift: DnsDriftFindingDto[];
  mail: MailStateDto | null;
  mailboxes: MailboxDto[];
  /** The chain's third link: domain -> Cloudflare record (above, in `records`) -> Pangolin resource -> hosting target. */
  proxyResources: ProxyResourceChainDto[];
}

/**
 * Shared by `fetchManagedDomain` (grouped by domain) and `fetchHostingTarget`
 * (grouped by hosting target) — the ONE place `ProxyResourceChainDto` is
 * assembled, so the two detail pages can never render the chain differently.
 *
 * `unmatchedObservedCount` is read from the most recent run's `'diff'` step
 * summary rather than stored as its own column — `@loxep/infrastructure`'s
 * `proxy.ts` writes it into `reconcile_run_steps.response_summary`, following
 * `ContainerHostPlan.unmatchedObserved`'s own "ride the plan, no drift table"
 * precedent (the Pangolin chain design's resolved open question 8).
 */
async function buildProxyResourceChainDtos(
  handle: DbHandle,
  entries: ReadonlyArray<{ resource: ProxyResourceRow; rules: ProxyResourceRuleRow[] }>,
  names: { domainNameById: Map<string, string>; hostingTargetNameById: Map<string, string> }
): Promise<ProxyResourceChainDto[]> {
  // The connection each entry's hosting target links to, plus that
  // connection's stored write-policy tier — batched once for the whole
  // list rather than per-row, matching `domainNameById`'s own precedent.
  const hostingTargetIds = [...new Set(entries.map((e) => e.resource.hostingTargetId))];
  const connectionIdByHostingTargetId = new Map<string, string | null>();
  if (hostingTargetIds.length > 0) {
    const rows = await handle.db.query.hostingTargets.findMany({
      where: (table, { inArray }) => inArray(table.id, hostingTargetIds),
      columns: { id: true, proxyConnectionId: true }
    });
    for (const row of rows) connectionIdByHostingTargetId.set(row.id, row.proxyConnectionId);
  }
  let writePolicies: Record<string, ProviderWritePolicyTier> = {};
  const hasLinkedConnection = [...connectionIdByHostingTargetId.values()].some((id) => id !== null);
  if (hasLinkedConnection) {
    const { getAdminServices } = await import('@/server/admin');
    const { providerWritePolicySetting } = await import('@loxep/domain');
    writePolicies = await getAdminServices().settings.get(providerWritePolicySetting);
  }

  const results: ProxyResourceChainDto[] = [];
  for (const { resource, rules } of entries) {
    const domainName = names.domainNameById.get(resource.domainId) ?? '';
    const hostingTargetName = names.hostingTargetNameById.get(resource.hostingTargetId) ?? '';
    const fullDomain =
      resource.subdomain === null ? domainName : `${resource.subdomain}.${domainName}`;

    const lastRunRow = await handle.db.query.reconcileRuns.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.subjectType, 'proxy_resource'), eq(table.subjectId, resource.id)),
      orderBy: (table, { desc }) => [desc(table.startedAt)]
    });

    let unmatchedObservedCount: number | null = null;
    if (lastRunRow !== undefined) {
      const diffStep = await handle.db.query.reconcileRunSteps.findFirst({
        where: (table, { and, eq }) => and(eq(table.runId, lastRunRow.id), eq(table.step, 'diff')),
        orderBy: (table, { desc }) => [desc(table.sequence)]
      });
      const summary = diffStep?.responseSummary as Record<string, unknown> | null | undefined;
      const count = summary?.['unmatchedObservedCount'];
      unmatchedObservedCount = typeof count === 'number' ? count : null;
    }

    const connectionId = connectionIdByHostingTargetId.get(resource.hostingTargetId) ?? null;
    // Absent from the map is the setting's own documented default:
    // 'read_only'. Never assume 'allow' from a missing key.
    const writePolicyTier: ProviderWritePolicyTier | null =
      connectionId === null ? null : (writePolicies[connectionId] ?? 'read_only');

    results.push({
      id: resource.id,
      domainId: resource.domainId,
      domainName,
      hostingTargetId: resource.hostingTargetId,
      hostingTargetName,
      subdomain: resource.subdomain,
      fullDomain,
      mode: resource.mode,
      ssl: resource.ssl,
      enabled: resource.enabled,
      externalResourceId: resource.externalResourceId,
      rules: rules
        .map((rule) => ({
          id: rule.id,
          action: rule.action,
          match: rule.match,
          value: rule.value,
          priority: rule.priority,
          enabled: rule.enabled,
          owner: rule.owner
        }))
        .sort((a, b) => a.priority - b.priority),
      lastRun:
        lastRunRow === undefined
          ? null
          : {
              id: lastRunRow.id,
              status: lastRunRow.status,
              startedAt: iso(lastRunRow.startedAt),
              finishedAt: iso(lastRunRow.finishedAt)
            },
      unmatchedObservedCount,
      connectionId,
      writePolicyTier
    });
  }
  return results;
}

export const fetchManagedDomain = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ name: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<ManagedDomainDetailDto> => {
    const {
      requireSession,
      getAdminServices,
      getInfrastructureMailService,
      getDriftService,
      getProxyResourcesService
    } = await import('@/server/admin');
    await requireSession();
    const { managedDomains, hostingTargets: targets, handle } = getAdminServices();
    const domain = await managedDomains.findByName(data.name);
    if (domain === null) {
      throw new Error(`Managed domain "${data.name}" not found`);
    }

    const mailService = getInfrastructureMailService();
    const drift = getDriftService();
    const [records, unresolvedDrift, mail, mailboxes, apexTarget, proxyResourceEntries] =
      await Promise.all([
        managedDomains.listRecords(domain.id),
        drift.listUnresolved(domain.id),
        mailService.find(domain.id),
        mailService.listMailboxes(domain.id),
        domain.apexTargetId ? targets.get(domain.apexTargetId).catch(() => null) : null,
        getProxyResourcesService().listResourcesForDomain(domain.id)
      ]);

    const hostingTargetIds = [
      ...new Set(proxyResourceEntries.map((entry) => entry.resource.hostingTargetId))
    ];
    const hostingTargetRows =
      hostingTargetIds.length === 0
        ? []
        : await handle.db.query.hostingTargets.findMany({
            where: (table, { inArray }) => inArray(table.id, hostingTargetIds),
            columns: { id: true, name: true }
          });
    const proxyResources = await buildProxyResourceChainDtos(handle, proxyResourceEntries, {
      domainNameById: new Map([[domain.id, domain.name]]),
      hostingTargetNameById: new Map(hostingTargetRows.map((row) => [row.id, row.name]))
    });

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
      })),
      proxyResources
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

/**
 * The M4 (loxep-acj.4) apply affordance: enqueues `infrastructure.
 * sync-proxy-resource` in `mode: 'apply'`, `trigger: 'manual'` for every
 * declared `proxy_resources` row under one domain — the task's own payload
 * granularity (`{domainId}`, no connection id, no per-resource targeting).
 * Admin-only, matching the owner's ruling that writes are admin-only in
 * Loxep. Does NOT await the reconcile — writes intent (a job) and returns,
 * per Phase 7's own rule; the run's outcome (`succeeded`/`partial` with a
 * `blocked` step/`failed`) shows up on the SAME panel that already polls
 * `lastRun`, exactly like `requestDomainResync`'s own check-mode sibling.
 *
 * This does NOT flip the connection's write policy — that is a SEPARATE,
 * per-connection admin control (`infrastructure.provider_write_policy`,
 * `loxep-acj.3`'s own scope). A `read_only` connection still enqueues
 * successfully here; the run simply comes back `partial` with a `blocked`
 * step naming the exact flip that unblocks it — see
 * `ProxyResourceChainDto.writePolicyTier`, which the client already has
 * before ever clicking Apply, so the affordance can render its blocked
 * state honestly up front rather than only after a failed attempt.
 */
export const requestProxyResourceDomainApply = createServerFn({ method: 'POST' })
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
        infrastructure.SYNC_PROXY_RESOURCE_TASK,
        { domainId: data.domainId, mode: 'apply', trigger: 'manual' },
        {
          jobKey: infrastructure.domainJobKey(
            infrastructure.SYNC_PROXY_RESOURCE_TASK,
            data.domainId
          )
        }
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
  /**
   * The `external_resources` row's own sync metadata (loxep-50t §1.3,
   * loxep-1au §4.2) — a Tailscale device's addresses/MagicDNS/os/authorized,
   * a Gatus endpoint's group/observedAt/success, a Beszel system's status/
   * host/port. Threaded through verbatim rather than pre-shaped per-provider,
   * so a new discovery writer needs no DTO change to make its metadata
   * visible; today's one consumer is the fleet detail's "Private network"
   * row, which reads a `tailscale`/`private_network` link's own fields out of
   * this bag rather than a dedicated DTO shape.
   */
  metadata: Record<string, JsonValue>;
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
  /**
   * The fleet-detail "Private network" row (loxep-50t §1.2), `null` unless
   * this target carries a `tailscale`/`private_network` companion link.
   * Server-computed so the client never needs its own copy of the CGNAT/ULA
   * or reachability-caveat logic — see {@link fetchHostingTarget}'s
   * `computePrivateNetworkRow`.
   */
  privateNetwork: PrivateNetworkRowDto | null;
  /**
   * The Pangolin connection this target reconciles proxy resources against
   * (Pangolin chain design milestone 2, loxep-acj.2) — `hosting_targets
   * .proxy_connection_id`, dormant since migration `0012`, driven for the
   * first time by this milestone. `null` until an operator links one.
   */
  proxyConnectionId: string | null;
  proxyConnectionName: string | null;
  /** Pangolin's own site id for the newt tunnel fronting this target, if known. */
  externalSiteId: string | null;
  /** Every declared `proxy_resources` row fronted by THIS target. */
  proxyResources: ProxyResourceChainDto[];
}

/**
 * The rendered "Private network" row's content (loxep-50t §1.2). Every field
 * but `reachabilityCaveat` is read straight from the linked device's own
 * sync `metadata`, unchanged — see `projectTailscaleDevices` in
 * `@loxep/app`'s `fleet-health.ts` for exactly what that payload holds.
 */
export interface PrivateNetworkRowDto {
  /** The device's own admin-console deep link ("[open in Tailscale]"). */
  url: string;
  addresses: string[];
  magicDnsName: string | null;
  os: string | null;
  authorized: boolean | null;
  online: boolean | null;
  /** Relative-time source when `online` is false. `null` while online, or when Tailscale reported none. */
  lastSeen: string | null;
  /**
   * The OBSERVATION's own age — Loxep's read clock, rendered always and
   * separately from `online`/`lastSeen` per §1.2's "a stale observation must
   * not read as a live one" rule. `null` only if the sweep has never reached
   * this link yet (freshly attached, not yet probed).
   */
  checkedAt: string | null;
  /**
   * §1.2's conditional, evidence-withdrawn reachability explanation — a
   * pre-rendered sentence, or `null` when the caveat does not apply (no
   * OTHER companion link's underlying connection is both host-matched to
   * this device AND has never once succeeded). See `computePrivateNetworkRow`.
   */
  reachabilityCaveat: string | null;
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
 * companion tools and their per-resource health projections (loxep-ovj.3;
 * loxep-y64 slice 3 for Beszel specifically).
 *
 * **Honesty note, worth restating at the one call site that matters — now
 * TRUE for Beszel, still aspirational for the others.** A Beszel link's
 * status here is, since loxep-y64 slice 3, an authenticated PER-SYSTEM
 * adapter read (`source: 'adapter'` — Loxep read THIS system's own verbatim
 * status from the hub, written by `@loxep/app`'s `projectBeszelSystems` as a
 * side effect of the connection probe's `listSystems()` call). Dockhand/
 * Gatus/Tailscale's links still carry only the credential-free tier-2
 * reachability probe's status (`source: 'probe'` — "Loxep pinged the tool's
 * own health path", answering "can Loxep reach this tool at all", not "is
 * THIS SPECIFIC device/environment/endpoint up") until their own discovery
 * slices land (loxep-hb7 Milestone B / loxep-50t slice B / loxep-wvm slice
 * B — design-complete, unbuilt). Every source writes to the SAME
 * `integration_health` key (`subject_type='external_resource'`, `subject_id=`
 * the link id), so this function needed NO CHANGE when Beszel's richer data
 * landed — `worstCompanionHealthStatus` simply started reading a
 * `source: 'adapter'` row instead of a `'probe'` one, exactly as this
 * comment predicted before slice 3 existed. `tailscale` never gets a
 * non-null status from THIS mechanism at all (Tailscale has no
 * unauthenticated health path — see `fleet-tool-registry.ts`), and stays
 * that way until its own discovery slice lands.
 */
export function computeHostDiagnosisInput(links: readonly CompanionLinkDto[]): HostDiagnosisInput {
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

/** The minimal per-companion-connection shape {@link computePrivateNetworkRow} needs. */
interface CompanionConnectionLookup {
  config: Record<string, unknown>;
  lastSuccessAt: Date | null;
}

/** The minimal `integration_health` row shape {@link computePrivateNetworkRow} needs. */
interface CompanionHealthLookup {
  status: HealthStatus;
  checkedAt: Date;
  detail: Record<string, unknown>;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
}

function metadataBoolean(metadata: Record<string, unknown>, key: string): boolean | null {
  const value = metadata[key];
  return typeof value === 'boolean' ? value : null;
}

/**
 * Every non-secret `connections.config` block in this codebase keys its
 * provider-specific settings under a block literally named after the
 * provider (`config.beszel.baseUrl`, `config.gatus.baseUrl`, …) — see
 * `@loxep/app`'s `fleet.ts`, `*_CONNECTION_CONFIG_KEY` constants, each of
 * which equals its own `*_CONNECTION_PROVIDER`. Reading it generically here
 * (rather than importing @loxep/app's five per-provider readers, which
 * would pull a heavy server-only dependency into this handler) is exactly
 * that convention exploited once. `null` for a connection with no base URL
 * or an unparseable one — never treated as a match.
 */
function companionConnectionHost(provider: string, config: Record<string, unknown>): string | null {
  const block = config[provider];
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null;
  const baseUrl = (block as Record<string, unknown>)['baseUrl'];
  if (typeof baseUrl !== 'string' || baseUrl === '') return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The fleet-detail "Private network" row (loxep-50t §1.2) — tailnet
 * address, online/lastSeen, the observation's own age, and the conditional,
 * evidence-withdrawn reachability caveat. `null` when this target carries no
 * `tailscale`/`private_network` link at all.
 *
 * **The caveat's two mandatory guards, both enforced here:**
 *
 * 1. **The trigger is a cheap string comparison, never a probe.** A SIBLING
 *    companion link (any OTHER provider on the same target) is a candidate
 *    only when its own connection's stored base-URL HOST equals one of this
 *    device's addresses or its MagicDNS name — proving the tool in question
 *    is genuinely hosted on THIS device, not merely unreachable for some
 *    unrelated reason.
 * 2. **Withdrawn on evidence.** Even a host-matched, currently-`unknown`
 *    sibling does not trigger the caveat if its own connection's
 *    `last_success_at` is non-null — Loxep reaching that connection even
 *    once contradicts "Loxep is not on this tailnet."
 *
 * A Beszel witness reading `unknown` because an OPERATOR paused it in Beszel
 * itself (`detail.status === 'paused'`) is deliberately excluded from
 * triggering the caveat — that `unknown` is not a network fact (see
 * `beszelSystemHealthStatus`'s own doc in `@loxep/app`'s `fleet-health.ts`).
 */
export function computePrivateNetworkRow(input: {
  companionLinks: readonly CompanionLink[];
  healthByLinkId: ReadonlyMap<string, CompanionHealthLookup>;
  connectionsById: ReadonlyMap<string, CompanionConnectionLookup>;
  /** Display label for the sibling provider named in the caveat sentence. */
  providerLabel: (provider: string) => string;
}): PrivateNetworkRowDto | null {
  const { companionLinks, healthByLinkId, connectionsById, providerLabel } = input;
  const deviceLink = companionLinks.find(
    (link) => link.provider === 'tailscale' && link.purpose === 'private_network'
  );
  if (deviceLink === undefined) return null;

  const metadata = deviceLink.metadata;
  const addressesRaw = metadata['addresses'];
  const addresses = Array.isArray(addressesRaw)
    ? addressesRaw.filter((value): value is string => typeof value === 'string')
    : [];
  const magicDnsName = metadataString(metadata, 'magicDnsName');
  const online = metadataBoolean(metadata, 'online');
  const lastSeen = metadataString(metadata, 'lastSeen');

  const matchHosts = new Set<string>();
  for (const address of addresses) matchHosts.add(address.toLowerCase());
  if (magicDnsName !== null) matchHosts.add(magicDnsName.toLowerCase());

  let reachabilityCaveat: string | null = null;
  for (const other of companionLinks) {
    if (other.externalResourceId === deviceLink.externalResourceId) continue;
    if (other.connectionId === null) continue;
    const otherHealth = healthByLinkId.get(other.externalResourceId);
    if (otherHealth === undefined || otherHealth.status !== 'unknown') continue;
    if (other.provider === 'beszel' && otherHealth.detail['status'] === 'paused') continue;
    const connection = connectionsById.get(other.connectionId);
    if (connection === undefined) continue;
    const host = companionConnectionHost(other.provider, connection.config);
    if (host === null || !matchHosts.has(host)) continue;
    if (connection.lastSuccessAt !== null) continue; // Guard 2 — withdrawn on evidence.
    reachabilityCaveat =
      `Loxep reached the Tailscale API, not this host. ${providerLabel(other.provider)} here ` +
      'is unknown because the Loxep container is not on this tailnet — a topology fact, not an outage.';
    break;
  }

  const healthRow = healthByLinkId.get(deviceLink.externalResourceId);

  return {
    url: deviceLink.url,
    addresses,
    magicDnsName,
    os: metadataString(metadata, 'os'),
    authorized: metadataBoolean(metadata, 'authorized'),
    online,
    lastSeen: online === true ? null : lastSeen,
    checkedAt: healthRow === undefined ? null : iso(healthRow.checkedAt),
    reachabilityCaveat
  };
}

export const fetchHostingTarget = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ name: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<HostingTargetDetailDto> => {
    const {
      requireSession,
      getAdminServices,
      getDnsProviderTokensService,
      getResourceLinksService,
      getProxyResourcesService
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

    const [
      frontedTargets,
      domains,
      tokens,
      tokenZoneRows,
      rawCompanionLinks,
      frontingNode,
      proxyConnection,
      proxyResourceEntries
    ] = await Promise.all([
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
        : null,
      // Pangolin chain design milestone 2 (loxep-acj.2): the connection
      // `proxy_connection_id` finally drives.
      target.proxyConnectionId
        ? handle.db.query.connections.findFirst({
            where: (table, { eq }) => eq(table.id, target.proxyConnectionId as string),
            columns: { id: true, name: true }
          })
        : null,
      getProxyResourcesService().listResourcesForHostingTarget(target.id)
    ]);

    const domainIdsForProxy = [
      ...new Set(proxyResourceEntries.map((entry) => entry.resource.domainId))
    ];
    const domainRowsForProxy =
      domainIdsForProxy.length === 0
        ? []
        : await handle.db.query.managedDomains.findMany({
            where: (table, { inArray }) => inArray(table.id, domainIdsForProxy),
            columns: { id: true, name: true }
          });
    const proxyResources = await buildProxyResourceChainDtos(handle, proxyResourceEntries, {
      domainNameById: new Map(domainRowsForProxy.map((row) => [row.id, row.name])),
      hostingTargetNameById: new Map([[target.id, target.name]])
    });

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
            : null,
          metadata: link.metadata as Record<string, JsonValue>
        };
      })
      // loxep-ovj.3's PROVISIONAL panel order (fundamental-first) — see
      // `fleet-tool-registry.ts`'s module doc for the full reasoning and
      // fleet-observability-design.md's "Where this surfaces" section for
      // the mirrored note. A provider the comparator does not know (a
      // hand-typed tier-1 link) sorts after every known fleet tool.
      .sort((a, b) => compareFleetToolPanelOrder(a.provider, b.provider));

    const diagnosis = diagnoseHostWitnesses(computeHostDiagnosisInput(companionLinks));

    // loxep-50t §1.2: the connections behind every OTHER companion link on
    // this target, needed only for the "Private network" row's reachability
    // caveat (host comparison + last_success_at withdrawal). A target with
    // no tailscale link at all skips this entirely — `computePrivateNetworkRow`
    // returns `null` immediately, but the query still runs uniformly rather
    // than special-casing that here; it is at most a handful of rows.
    const companionConnectionIds = [
      ...new Set(
        rawCompanionLinks.map((link) => link.connectionId).filter((id): id is string => id !== null)
      )
    ];
    const companionConnectionRows =
      companionConnectionIds.length === 0
        ? []
        : await handle.db.query.connections.findMany({
            where: (table, { inArray }) => inArray(table.id, companionConnectionIds),
            columns: { id: true, config: true, lastSuccessAt: true }
          });
    const connectionsById = new Map(
      companionConnectionRows.map((row) => [
        row.id,
        { config: row.config as Record<string, unknown>, lastSuccessAt: row.lastSuccessAt }
      ])
    );
    const privateNetwork = computePrivateNetworkRow({
      companionLinks: rawCompanionLinks,
      healthByLinkId,
      connectionsById,
      providerLabel: (provider) =>
        isFleetToolProvider(provider) ? FLEET_TOOL_REGISTRY[provider].label : provider
    });

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
      diagnosis,
      privateNetwork,
      proxyConnectionId: target.proxyConnectionId,
      proxyConnectionName: proxyConnection?.name ?? null,
      externalSiteId: target.externalSiteId,
      proxyResources
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
        : null,
      // A tier-1 hand-typed link carries no sync metadata — `createLink`
      // was called with no `metadata` above, so the service defaulted it to
      // `{}`, echoed here verbatim rather than guessed at.
      metadata: {}
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

// ---------------------------------------------------------------------------
// The operator-confirmed attach picker (loxep-y64 slice 3)
//
// A discovery sweep (today: only Beszel's, `@loxep/app`'s
// `projectBeszelSystems`) upserts one `external_resources` row per observed
// system, linked or not — "discovered-but-unlinked systems are kept," per
// the design's §2. This picker lists that provider's UNATTACHED rows and
// lets the operator confirm exactly one attachment; it never joins on a
// name, and it never writes a link without an explicit operator action. The
// fixed `(provider, externalType, resourceType) -> purpose` vocabulary lives
// in `@loxep/domain`'s `fleet-tool-registry.ts` — this handler resolves it
// server-side rather than trusting a client-supplied purpose, so the picker
// cannot be made to write an invented purpose even by a modified client.
// ---------------------------------------------------------------------------

/**
 * One discovered-but-not-yet-attached `external_resources` row (loxep-y64
 * slice 3). `host`/`status`/`observedAt` are read straight out of the row's
 * own sync `metadata` — never a second live read — and are HINTS for the
 * picker, exactly like the design's §2 rule for the attach form ("showing
 * name/host as hints and labelling them as unverified when null"); `status`/
 * `observedAt` are additionally shown so the operator is not confirming an
 * attachment blind to whether the candidate looks healthy.
 */
export interface DiscoveredFleetResourceDto {
  id: string;
  provider: string;
  externalType: string;
  externalId: string | null;
  title: string | null;
  url: string;
  host: string | null;
  status: string | null;
  observedAt: string | null;
  createdAt: string;
}

function metadataStringField(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
}

const fetchDiscoveredFleetResourcesInput = z.strictObject({
  provider: z.string().trim().min(1).max(100)
});

/**
 * Every provider's discovered-but-unattached resource — the attach picker's
 * candidate list. `requireSession`, not `requireAdmin`: reading the list is
 * no more sensitive than reading the companion links panel it feeds, and
 * matches every other GET in this file.
 */
export const fetchDiscoveredFleetResources = createServerFn({ method: 'GET' })
  .inputValidator(fetchDiscoveredFleetResourcesInput)
  .handler(async ({ data }): Promise<DiscoveredFleetResourceDto[]> => {
    const { requireSession, getResourceLinksService } = await import('@/server/admin');
    await requireSession();
    const rows = await getResourceLinksService().listUnattachedByProvider(data.provider);
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      externalType: row.externalType,
      externalId: row.externalId,
      title: row.title,
      url: row.url,
      host: metadataStringField(row.metadata, 'host'),
      status: metadataStringField(row.metadata, 'status'),
      observedAt: metadataStringField(row.metadata, 'observedAt'),
      createdAt: iso(row.createdAt)
    }));
  });

const attachDiscoveredFleetResourceInput = z.strictObject({
  hostingTargetId: z.uuid(),
  externalResourceId: z.uuid()
});

/**
 * Attaches one operator-CONFIRMED discovered resource to a hosting target.
 * The purpose is resolved server-side from `@loxep/domain`'s
 * `fleetDiscoveredResourcePurpose` (the design's fixed vocabulary table) —
 * never accepted from the client — so this endpoint structurally cannot be
 * used to write an invented purpose, and refuses outright for a provider/
 * externalType combination nothing discovers yet rather than guessing one.
 * `attachLink` is idempotent (`resource_links_resource_purpose_uq`), so a
 * retried click is harmless.
 */
export const attachDiscoveredFleetResource = createServerFn({ method: 'POST' })
  .inputValidator(attachDiscoveredFleetResourceInput)
  .handler(async ({ data }): Promise<CompanionLinkDto> => {
    const { requireAdmin, getAdminServices, getResourceLinksService } =
      await import('@/server/admin');
    const { fleetDiscoveredResourcePurpose, FLEET_TOOL_REGISTRY, isFleetToolProvider } =
      await import('@loxep/domain');
    await requireAdmin();
    const resourceLinks = getResourceLinksService();
    const resource = await resourceLinks.getExternalResource(data.externalResourceId);
    if (resource === null) {
      throw new Error(`Discovered resource "${data.externalResourceId}" not found`);
    }
    const purpose = fleetDiscoveredResourcePurpose(
      resource.provider,
      resource.externalType,
      'hosting_target'
    );
    if (purpose === null) {
      throw new Error(
        `Loxep does not yet know an attach purpose for "${resource.provider}/${resource.externalType}" -> hosting_target`
      );
    }
    await resourceLinks.attachLink({
      externalResourceId: resource.id,
      resourceType: 'hosting_target',
      resourceId: data.hostingTargetId,
      purpose
    });

    const links = await resourceLinks.listLinksFor('hosting_target', data.hostingTargetId);
    const link = links.find(
      (candidate) => candidate.externalResourceId === resource.id && candidate.purpose === purpose
    );
    const { health } = getAdminServices();
    // Discovery already wrote this resource's per-system health row (loxep-
    // y64 slice 3) BEFORE it was ever attachable — unlike a fresh tier-1
    // `addCompanionLink`, whose brand-new link genuinely has no health row
    // yet, this response should show the real status the operator just saw
    // in the picker, not a fabricated `null`.
    const healthRow = await health.getHealth('external_resource', resource.id);
    return {
      id: resource.id,
      provider: resource.provider,
      externalType: resource.externalType,
      url: resource.url,
      title: resource.title,
      resourceId: data.hostingTargetId,
      purpose,
      createdAt: iso(link?.createdAt ?? new Date()),
      health:
        healthRow === null
          ? null
          : {
              status: healthRow.status,
              source: healthRow.source,
              checkedAt: iso(healthRow.checkedAt),
              detail: healthRow.detail as Record<string, JsonValue>
            },
      knownTool: isFleetToolProvider(resource.provider)
        ? {
            label: FLEET_TOOL_REGISTRY[resource.provider].label,
            embeddable: FLEET_TOOL_REGISTRY[resource.provider].embeddable
          }
        : null,
      metadata: resource.metadata as Record<string, JsonValue>
    };
  });

const IPV4_SHAPE = /^(\d{1,3}\.){3}\d{1,3}$/;

const adoptContainerHostAsHostingTargetInput = z.strictObject({
  externalResourceId: z.uuid(),
  /** Defaults to the discovered environment's own title/name. */
  name: z.string().trim().min(1).optional()
});

/**
 * hb7 §2.6/§3.2: "an explicit 'adopt as hosting target' action… must never
 * be automatic." Turns one Dockhand environment `plan.unmatchedObserved`
 * (surfaced installation-wide via `listUnattachedByProvider('dockhand')` —
 * the same discovery set the attach picker already offers, see
 * `fetchDiscoveredFleetResources`'s own doc) into a real `hosting_targets`
 * row plus its `container_console` link — never a reconcile-intent
 * declaration. The environment is already known to Dockhand (that is what
 * "unmatched" means), so THIS call only records Loxep's own fleet fact;
 * an operator who also wants Loxep to reconcile it opens the new target's
 * registration panel and declares intent there, same as any other target.
 *
 * `control_surface`/`address_v4` are a best-effort guess from the
 * discovery's own sync metadata (`host`, written by
 * `projectDockhandResources`) — `direct_reverse_proxy` + the observed host
 * when it looks like a bare IPv4 address, `none` (DNS-only, no address
 * claim) otherwise. Either is editable nowhere in this codebase today (no
 * hosting-target edit form outside this one field set), so a wrong guess
 * costs a decommission-and-recreate, not silent data corruption — the same
 * tradeoff every other adopt-shaped action in this file accepts.
 */
export const adoptContainerHostAsHostingTarget = createServerFn({ method: 'POST' })
  .inputValidator(adoptContainerHostAsHostingTargetInput)
  .handler(async ({ data }): Promise<{ hostingTargetId: string; name: string }> => {
    const { requireAdmin, getResourceLinksService, getHostingTargetsService } =
      await import('@/server/admin');
    const session = await requireAdmin();
    const resourceLinks = getResourceLinksService();
    const resource = await resourceLinks.getExternalResource(data.externalResourceId);
    if (
      resource === null ||
      resource.provider !== 'dockhand' ||
      resource.externalType !== 'environment'
    ) {
      throw new Error(`"${data.externalResourceId}" is not a discovered Dockhand environment`);
    }
    const name = (data.name ?? resource.title ?? resource.externalId ?? 'dockhand-host').trim();
    const host = metadataStringField(resource.metadata as Record<string, unknown>, 'host');
    const looksLikeIPv4 = host !== null && IPV4_SHAPE.test(host);

    const target = await getHostingTargetsService().create({
      name,
      controlSurface: looksLikeIPv4 ? 'direct_reverse_proxy' : 'none',
      addressV4: looksLikeIPv4 ? host : undefined,
      notes: `Adopted from a discovered Dockhand environment (${resource.externalId ?? 'no id'}).`,
      createdByUserId: session.user.id
    });

    await resourceLinks.attachLink({
      externalResourceId: resource.id,
      resourceType: 'hosting_target',
      resourceId: target.id,
      purpose: 'container_console'
    });

    return { hostingTargetId: target.id, name: target.name };
  });

// ---------------------------------------------------------------------------
// Unmatched tailnet devices (loxep-50t slice C) — the fleet LIST page's
// opt-in candidates panel (§4). Every tailscale `external_resources` row
// with no `resource_links` attachment IS the candidate set —
// `listUnattachedByProvider` (the same call `fetchDiscoveredFleetResources`
// makes for the Beszel attach picker) — so this reads exactly what
// `projectTailscaleDevices`'s (`packages/app`'s) upsert-on-every-sweep
// already writes; nothing here discovers or writes a device row.
// ---------------------------------------------------------------------------

/**
 * One candidate row for the panel: a discovered tailscale device with no
 * `private_network` link. Every field but `ignoredAt` is read straight out
 * of the device's own sync `metadata` (§1.3's "overwritten wholesale on
 * every refresh" payload — never a second live read).
 *
 * `hostname` is deliberately absent: `projectTailscaleDevices` stores
 * `magicDnsName` (`TailscaleDeviceFact.name`) but not the adapter's separate
 * `hostname` field, so it is not available here without a
 * `packages/app`/`fleet-health.ts` change, which is outside this change's
 * scope (the sibling fleet-detail work owns that file). `title` — the same
 * `device.name ?? device.hostname ?? nodeId` fallback the admin-console link
 * and the attach picker already use — is the best available stand-in.
 */
export interface UnmatchedTailscaleDeviceDto {
  /** `external_resources.id` — the id `attachDiscoveredFleetResource` addresses. */
  id: string;
  /** The tailnet node id (`TailscaleDeviceFact.externalDeviceId`) — the ignore setting's own key. */
  externalId: string | null;
  title: string | null;
  addresses: string[];
  magicDnsName: string | null;
  os: string | null;
  authorized: boolean | null;
  online: boolean | null;
  lastSeen: string | null;
  /** The discovery sweep's own read clock (`metadata.observedAt`) — Loxep's clock, never Tailscale's `lastSeen`. */
  observedAt: string | null;
  url: string;
  /** Non-null when ignored — `tailscaleIgnoredDevicesSetting`'s own recorded instant. */
  ignoredAt: string | null;
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Every tailscale device Loxep has discovered but not linked to a hosting
 * target, plus the operator's own ignore annotations (loxep-50t §4).
 * `requireSession`, not `requireAdmin` — reading this candidate list is no
 * more sensitive than `fetchDiscoveredFleetResources`, which this reuses the
 * identical `listUnattachedByProvider` call from.
 */
export const fetchUnmatchedTailscaleDevices = createServerFn({ method: 'GET' }).handler(
  async (): Promise<UnmatchedTailscaleDeviceDto[]> => {
    const [{ requireSession, getAdminServices, getResourceLinksService }, domain] =
      await Promise.all([import('@/server/admin'), import('@loxep/domain')]);
    await requireSession();
    const [rows, ignored] = await Promise.all([
      getResourceLinksService().listUnattachedByProvider('tailscale'),
      getAdminServices().settings.get(domain.tailscaleIgnoredDevicesSetting)
    ]);
    return rows.map((row) => ({
      id: row.id,
      externalId: row.externalId,
      title: row.title,
      addresses: metadataStringArray(row.metadata, 'addresses'),
      magicDnsName: metadataString(row.metadata, 'magicDnsName'),
      os: metadataString(row.metadata, 'os'),
      authorized: metadataBoolean(row.metadata, 'authorized'),
      online: metadataBoolean(row.metadata, 'online'),
      lastSeen: metadataString(row.metadata, 'lastSeen'),
      observedAt: metadataString(row.metadata, 'observedAt'),
      url: row.url,
      ignoredAt: row.externalId !== null ? (ignored[row.externalId] ?? null) : null
    }));
  }
);

const setTailscaleDeviceIgnoredInput = z.strictObject({
  externalId: z.string().trim().min(1),
  ignored: z.boolean()
});

/**
 * Persists (or clears) one device's "ignore" dismissal — see
 * `tailscaleIgnoredDevicesSetting`'s doc comment for why this is a settings
 * map rather than the design's first-choice `external_resources.metadata`
 * field. Keyed by the device's own tailnet node id, so the dismissal
 * survives `projectTailscaleDevices` re-upserting the row on every sweep.
 */
export const setTailscaleDeviceIgnored = createServerFn({ method: 'POST' })
  .inputValidator(setTailscaleDeviceIgnoredInput)
  .handler(async ({ data }): Promise<{ ignoredAt: string | null }> => {
    const [{ requireAdmin, getAdminServices }, domain] = await Promise.all([
      import('@/server/admin'),
      import('@loxep/domain')
    ]);
    const session = await requireAdmin();
    const { settings } = getAdminServices();
    const current = await settings.get(domain.tailscaleIgnoredDevicesSetting);
    const next = { ...current };
    let ignoredAt: string | null = null;
    if (data.ignored) {
      ignoredAt = new Date().toISOString();
      next[data.externalId] = ignoredAt;
    } else {
      delete next[data.externalId];
    }
    await settings.set(domain.tailscaleIgnoredDevicesSetting, next, {
      actorUserId: session.user.id
    });
    return { ignoredAt };
  });

// ---------------------------------------------------------------------------
// Dockhand containers panel (loxep-hb7 Milestone B) — the ONE dedicated
// tool-specific panel the anti-soup rule licenses (hb7 §3.2 rule 1: "a tool
// earns a panel only by contributing rows Loxep cannot otherwise show").
// A LIVE, request-scoped read, NEVER persisted — no table, no cache, no
// cadence (hb7 §3.3: "why the containers panel is a live read and not a
// sweep" — two GETs on a page a human opened, never a third scheduled call).
// ---------------------------------------------------------------------------

export interface DockhandContainerDto {
  externalContainerId: string;
  name: string | null;
  image: string | null;
  /** Docker's own string, verbatim (`running`, `exited`, …). */
  state: string;
  /** Docker's human status line, verbatim (`Up 3 days`). */
  status: string | null;
}

export interface DockhandStackDto {
  name: string;
  status: string;
  sourceType: string | null;
  containerCount: number;
  runningContainerCount: number;
}

export interface DockhandHostViewDto {
  containers: DockhandContainerDto[];
  stacks: DockhandStackDto[];
  /**
   * Loxep's own read clock. This response has no staleness story because it
   * has no storage — "read just now", never a cache age — per hb7 §3.2
   * rule 2's "every panel stamps its own provenance and its own clock".
   */
  readAt: string;
}

/**
 * Resolves `hostingTargetId`'s dockhand/environment companion link (the
 * fleet design's `container_console` purpose), calls `listContainers`/
 * `listStacks` live against Dockhand, and returns the result — or `null`
 * when no such link exists (nothing to show), which the panel renders as
 * ABSENT, never an empty table (hb7 §3.2 rule 3: "absent, not green, not
 * empty"). No lifecycle verb is called or exposed anywhere in this
 * function — `DockhandAdapter` structurally has none (rule 13).
 */
export const fetchDockhandHostView = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ hostingTargetId: z.uuid() }))
  .handler(async ({ data }): Promise<DockhandHostViewDto | null> => {
    const { requireSession, getResourceLinksService, getDockhandAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    const resourceLinks = getResourceLinksService();
    const links = await resourceLinks.listLinksFor('hosting_target', data.hostingTargetId);
    const link = links.find(
      (candidate) => candidate.provider === 'dockhand' && candidate.externalType === 'environment'
    );
    if (link === undefined || link.externalId === null) return null;

    const resource = await resourceLinks.getExternalResource(link.externalResourceId);
    if (resource === null || resource.connectionId === null) return null;

    const adapter = await getDockhandAdapterForConnection(resource.connectionId);
    const [containers, stacks] = await Promise.all([
      adapter.listContainers({ externalHostId: link.externalId }),
      adapter.listStacks({ externalHostId: link.externalId })
    ]);

    return {
      containers: containers.map((container) => ({
        externalContainerId: container.externalContainerId,
        name: container.name,
        image: container.image,
        state: container.state,
        status: container.status
      })),
      stacks: stacks.map((stack) => ({
        name: stack.name,
        status: stack.status,
        sourceType: stack.sourceType,
        containerCount: stack.containerCount,
        runningContainerCount: stack.runningContainerCount
      })),
      readAt: iso(new Date())
    };
  });

// ---------------------------------------------------------------------------
// Termix per-session rows (loxep-4ah, owner-approved 2026-08-15 ruling —
// "the more info the better, this tool is meant to be used by people that
// trust one another"). The wvm design double-gated this on (a) a live run
// confirming the active-sessions field names and (b) an explicit owner
// ruling on the trust model; both are now satisfied — see loxep-4ah's own
// notes and the corrected loxep-wvm docs.
//
// Sessions stay LIVE-READ, exactly like Dockhand's containers panel above:
// no table, no cache, no cadence. `TermixSessionFact` is never persisted —
// wvm §3's "no session history, no per-instant storage of a session" rule
// still holds; only the best-effort COUNT (`detail.sessionCount`, already
// written by `projectTermixResources`) is ever stored, unchanged by this
// slice.
// ---------------------------------------------------------------------------

/**
 * A defensive cap on how many session rows one page render will ever ask
 * for — Termix's active-sessions read has no documented page size, and a
 * live-read panel must not become an unbounded render just because an
 * instance happens to have many open tabs. Not a UX limit (a real fleet used
 * by "people who trust one another" is expected to stay well under this),
 * a correctness ceiling matching this package's other honestly-conservative
 * caps (`DEFAULT_MAX_SUBJECTS_PER_TYPE`, `TERMIX_RATE_BUDGET_CAPACITY`).
 */
export const TERMIX_SESSION_ROWS_MAX = 200;

export interface TermixSessionRowDto {
  sessionId: string;
  hostId: string;
  hostName: string | null;
  isConnected: boolean;
  /** Epoch milliseconds, Termix's own clock — `null` when Termix omitted it. Formatted client-side. */
  createdAt: number | null;
  isOwnSession: boolean;
  /**
   * The human this session was shared BY, when it is not the caller's own —
   * `null` for an own session. Rendered verbatim as the username Termix
   * itself reports: the owner's 2026-08-15 ruling is that this tool is used
   * by people who trust one another, so "who is logged into which host" is
   * the intended value, not a surveillance surface to redact.
   */
  sharedByUsername: string | null;
  permissionLevel: string | null;
}

export interface TermixHostSessionsDto {
  /** The linked host's own Termix externalHostId — echoed for the empty-state copy. */
  hostId: string;
  hostName: string | null;
  sessions: TermixSessionRowDto[];
  /** Loxep's own read clock — this response has no staleness story, same discipline as `DockhandHostViewDto.readAt`. */
  readAt: string;
}

/**
 * Resolves `hostingTargetId`'s termix/host companion link, calls
 * `listSessions()` live against Termix, and returns every session for THAT
 * host — or `null` when no such link exists (nothing to show; the caller
 * renders this as ABSENT, never an empty table, matching
 * `fetchDockhandHostView`'s own "absent, not green, not empty" rule).
 *
 * Filters the WHOLE-INSTANCE session list down to this one host's
 * `externalHostId` — Termix's `/open-tabs/active-sessions` carries every
 * session the caller can see across every host, own and shared-with-me
 * alike (wvm §3's fully-specified read), and a per-host panel must only
 * ever show the sessions that belong to the host it was mounted for.
 */
export const fetchTermixHostSessions = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ hostingTargetId: z.uuid() }))
  .handler(async ({ data }): Promise<TermixHostSessionsDto | null> => {
    const { requireSession, getResourceLinksService, getTermixAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    const resourceLinks = getResourceLinksService();
    const links = await resourceLinks.listLinksFor('hosting_target', data.hostingTargetId);
    const link = links.find(
      (candidate) => candidate.provider === 'termix' && candidate.externalType === 'host'
    );
    if (link === undefined || link.externalId === null) return null;

    const resource = await resourceLinks.getExternalResource(link.externalResourceId);
    if (resource === null || resource.connectionId === null) return null;

    const adapter = await getTermixAdapterForConnection(resource.connectionId);
    const sessions = await adapter.listSessions();
    const forThisHost = sessions.filter((session) => session.hostId === link.externalId);

    return {
      hostId: link.externalId,
      hostName: resource.title,
      sessions: forThisHost.slice(0, TERMIX_SESSION_ROWS_MAX).map((session) => ({
        sessionId: session.sessionId,
        hostId: session.hostId,
        hostName: session.hostName,
        isConnected: session.isConnected,
        createdAt: session.createdAt,
        isOwnSession: session.isOwnSession,
        sharedByUsername: session.sharedByUsername,
        permissionLevel: session.permissionLevel
      })),
      readAt: iso(new Date())
    };
  });

// ---------------------------------------------------------------------------
// Dockhand host-registration intent (loxep-hb7 Milestone C) — the create
// dialog's "also register this host in Dockhand" section and the
// fleet-detail registration panel both call these. Declaring intent NEVER
// calls Dockhand synchronously: it writes `external_resources`/
// `resource_links` (+ `application_secrets` for any TLS/Hawser material) and
// enqueues `infrastructure.reconcile-container-host`, which the worker runs —
// the same "write intent, enqueue, return" shape `createManagedDomain` uses.
// ---------------------------------------------------------------------------

/** Dockhand connections (`connections.provider = 'dockhand'`) for the registration form's connection picker. */
export const fetchDockhandConnectionOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().connections.listConnections({ provider: 'dockhand' });
    return rows.map((row) => ({ id: row.id, name: row.name, status: row.status }));
  }
);

/**
 * Pangolin connections (`connections.provider = 'pangolin'`) for the fleet
 * detail "link a proxy connection" control — the Pangolin chain design's
 * milestone 2 (loxep-acj.2), driving `hosting_targets.proxy_connection_id`
 * for the first time.
 */
export const fetchPangolinConnectionOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConnectionOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().connections.listConnections({ provider: 'pangolin' });
    return rows.map((row) => ({ id: row.id, name: row.name, status: row.status }));
  }
);

export interface ContainerHostLastRunDto {
  id: string;
  status: string;
  mode: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * The fleet-detail "Container host registration" panel's whole read model
 * (hb7 §2.1(b)/§2.6): whether intent is declared at all, the declared
 * (non-secret) fields, whether the identity has self-retired
 * (`externalHostId !== null`), and the most recent reconcile run's outcome —
 * matched/unmatched, applied, when it last ran. `null` when nothing has been
 * declared yet — the panel then renders the "register" form instead of the
 * status view, never a fabricated "not configured" status row.
 */
export interface ContainerHostRegistrationDto {
  externalResourceId: string;
  connectionId: string;
  connectionType: string;
  host: string | null;
  port: number | null;
  protocol: string | null;
  socketPath: string | null;
  tlsSkipVerify: boolean | null;
  labels: string[];
  publicIp: string | null;
  /** Non-null once hb7 §3.1's identity has self-retired — the provider's own id for this host. */
  externalHostId: string | null;
  desiredAt: string;
  lastAppliedAt: string | null;
  lastRun: ContainerHostLastRunDto | null;
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads the target's declared Dockhand registration, or `null` when nothing
 * has been declared (no link at all, or a Milestone B discovery auto-attach
 * with no operator intent behind it — `desiredAt` absent, mirroring
 * `@loxep/infrastructure`'s own `isContainerHostIntent` narrowing).
 */
export const fetchContainerHostRegistration = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ hostingTargetId: z.uuid() }))
  .handler(async ({ data }): Promise<ContainerHostRegistrationDto | null> => {
    const { requireSession, getResourceLinksService, getContainerHostsService } =
      await import('@/server/admin');
    await requireSession();
    const resourceLinks = getResourceLinksService();
    const links = await resourceLinks.listLinksFor('hosting_target', data.hostingTargetId);
    const link = links.find(
      (candidate) =>
        candidate.provider === 'dockhand' &&
        candidate.externalType === 'environment' &&
        candidate.purpose === 'container_console'
    );
    const desiredAt = link ? metadataString(link.metadata, 'desiredAt') : null;
    if (link === undefined || link.connectionId === null || desiredAt === null) return null;

    const runs = await getContainerHostsService().listRuns(data.hostingTargetId);
    const lastRun = runs.slice().sort((a, b) => +b.startedAt - +a.startedAt)[0] ?? null;

    return {
      externalResourceId: link.externalResourceId,
      connectionId: link.connectionId,
      connectionType: metadataString(link.metadata, 'connectionType') ?? 'socket',
      host: metadataString(link.metadata, 'host'),
      port: metadataNumber(link.metadata, 'port'),
      protocol: metadataString(link.metadata, 'protocol'),
      socketPath: metadataString(link.metadata, 'socketPath'),
      tlsSkipVerify: metadataBoolean(link.metadata, 'tlsSkipVerify'),
      labels: metadataStringArray(link.metadata, 'labels'),
      publicIp: metadataString(link.metadata, 'publicIp'),
      externalHostId: link.externalId,
      desiredAt,
      lastAppliedAt: metadataString(link.metadata, 'lastAppliedAt'),
      lastRun:
        lastRun === null
          ? null
          : {
              id: lastRun.id,
              status: lastRun.status,
              mode: lastRun.mode,
              trigger: lastRun.trigger,
              startedAt: iso(lastRun.startedAt),
              finishedAt: iso(lastRun.finishedAt)
            }
    };
  });

const declareContainerHostIntentInput = z.strictObject({
  hostingTargetId: z.uuid(),
  connectionId: z.uuid(),
  /** The Dockhand instance origin — resolved client-side is not an option (needs the connection's own config), so the handler resolves it from the connection. */
  connectionType: z.enum(['socket', 'direct', 'hawser-standard', 'hawser-edge']),
  socketPath: z.string().trim().min(1).nullish(),
  host: z.string().trim().min(1).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  protocol: z.enum(['http', 'https']).nullish(),
  tlsSkipVerify: z.boolean().nullish(),
  labels: z.array(z.string().trim().min(1)).max(10).optional(),
  publicIp: z.string().trim().min(1).nullish(),
  // Write-only. Blank/absent leaves any already-stored value untouched.
  tlsCa: z.string().trim().min(1).optional(),
  tlsCert: z.string().trim().min(1).optional(),
  tlsKey: z.string().trim().min(1).optional(),
  hawserToken: z.string().trim().min(1).optional()
});

/**
 * The client-facing POST body shape — deliberately NOT `@loxep/infrastructure`'s
 * own `DeclareContainerHostIntentInput` (which requires `url` and
 * `actorUserId`, both resolved server-side; see the handler below). Exported
 * so `dockhand-registration-fields.tsx` can type its shared form value
 * against exactly what this endpoint accepts.
 */
export type DeclareContainerHostIntentInput = z.infer<typeof declareContainerHostIntentInput>;

/**
 * Declares (or edits) one hosting target's Dockhand host-registration
 * intent — the create dialog's collapsed section AND the fleet-detail
 * registration panel's save action, since there is no separate hosting-
 * target edit form (hb7 §2.1(b)). Resolves the connection's own base URL for
 * the stored `url` (the design's own rule: never a guessed per-environment
 * path, always the instance origin — see `fleet-health.ts`'s
 * `projectDockhandResources` for the identical resolution).
 */
export const declareContainerHostIntent = createServerFn({ method: 'POST' })
  .inputValidator(declareContainerHostIntentInput)
  .handler(async ({ data }): Promise<{ externalResourceId: string; jobKey: string }> => {
    const { requireAdmin, getAdminServices, getContainerHostsService, getFleetModule } =
      await import('@/server/admin');
    const actor = await requireAdmin();
    const { connections } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);
    if (connection.provider !== 'dockhand') {
      throw new Error(`connection ${data.connectionId} is not a Dockhand connection`);
    }
    const fleet = await getFleetModule();
    const rawBaseUrl = fleet.readDockhandBaseUrl(connection.config);
    if (rawBaseUrl === null) {
      throw new Error(`Dockhand connection ${data.connectionId} has no configured base URL`);
    }
    const url = fleet.normalizeDockhandBaseUrl(rawBaseUrl);

    const result = await getContainerHostsService().declareIntent({
      hostingTargetId: data.hostingTargetId,
      connectionId: data.connectionId,
      url,
      connectionType: data.connectionType,
      socketPath: data.socketPath ?? undefined,
      host: data.host ?? undefined,
      port: data.port ?? undefined,
      protocol: data.protocol ?? undefined,
      tlsSkipVerify: data.tlsSkipVerify ?? undefined,
      labels: data.labels,
      publicIp: data.publicIp ?? undefined,
      tlsCa: data.tlsCa,
      tlsCert: data.tlsCert,
      tlsKey: data.tlsKey,
      hawserToken: data.hawserToken,
      actorUserId: actor.user.id
    });
    return { externalResourceId: result.externalResourceId, jobKey: result.jobKey };
  });

const requestContainerHostReconcileInput = z.strictObject({
  hostingTargetId: z.uuid(),
  mode: z.enum(['apply', 'check'])
});

/**
 * A manual Reconcile ("apply") or Check now ("check") from the registration
 * panel: re-enqueues `infrastructure.reconcile-container-host`. Enqueues
 * rather than running inline — the same asynchronous shape
 * `requestDomainResync` uses; the run's result shows up on
 * `/infrastructure/runs` once the worker processes it.
 */
export const requestContainerHostReconcile = createServerFn({ method: 'POST' })
  .inputValidator(requestContainerHostReconcileInput)
  .handler(async ({ data }): Promise<{ enqueued: true }> => {
    const [{ requireAdmin, getAdminServices, getInfrastructureEnqueue }, infrastructure] =
      await Promise.all([import('@/server/admin'), import('@loxep/infrastructure')]);
    await requireAdmin();
    const { handle } = getAdminServices();
    const enqueue = getInfrastructureEnqueue();
    await handle.db.transaction(async (tx) => {
      await enqueue(
        tx,
        infrastructure.RECONCILE_CONTAINER_HOST_TASK,
        { hostingTargetId: data.hostingTargetId, mode: data.mode, trigger: 'manual' },
        {
          jobKey: infrastructure.containerHostJobKey(
            infrastructure.RECONCILE_CONTAINER_HOST_TASK,
            data.hostingTargetId
          )
        }
      );
    });
    return { enqueued: true };
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

/**
 * Links (or clears) `hosting_targets.proxy_connection_id`/`external_site_id`
 * — the Pangolin chain design's milestone 2 (loxep-acj.2), driving that
 * column for the first time since migration `0012`. This writes ONLY
 * Loxep's own row; it never calls Pangolin (the reconciler this connects to
 * is CHECK MODE ONLY this milestone). `connectionId: null` clears the link.
 */
export const linkHostingTargetProxyConnection = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      hostingTargetId: z.uuid(),
      connectionId: z.uuid().nullable(),
      externalSiteId: z.string().trim().min(1).nullish()
    })
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getHostingTargetsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getHostingTargetsService().updateProxyConnection(data.hostingTargetId, {
      proxyConnectionId: data.connectionId,
      externalSiteId: data.externalSiteId,
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
    const hostingTargetIds = runs
      .filter((run) => run.subjectType === 'hosting_target')
      .map((run) => run.subjectId);
    const [domains, tokens, hostingTargetRows] = await Promise.all([
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
        : [],
      hostingTargetIds.length > 0
        ? handle.db.query.hostingTargets.findMany({
            where: (table, { inArray }) => inArray(table.id, hostingTargetIds),
            columns: { id: true, name: true }
          })
        : []
    ]);
    const domainNameById = new Map(domains.map((row) => [row.id, row.name]));
    const tokenNameById = new Map(tokens.map((row) => [row.id, row.name]));
    const hostingTargetNameById = new Map(hostingTargetRows.map((row) => [row.id, row.name]));

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
            : run.subjectType === 'hosting_target'
              ? (hostingTargetNameById.get(run.subjectId) ?? null)
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
    } else if (run.subjectType === 'hosting_target') {
      const hostingTarget = await handle.db.query.hostingTargets.findFirst({
        where: (table, { eq }) => eq(table.id, run.subjectId),
        columns: { name: true }
      });
      subjectLabel = hostingTarget?.name ?? null;
    } else if (run.subjectType === 'proxy_resource') {
      // loxep-acj.2: the subject is a `proxy_resources` row, not a domain —
      // see `@loxep/infrastructure`'s `proxy.ts` module doc.
      const resource = await handle.db.query.proxyResources.findFirst({
        where: (table, { eq }) => eq(table.id, run.subjectId)
      });
      if (resource !== undefined) {
        const domain = await handle.db.query.managedDomains.findFirst({
          where: (table, { eq }) => eq(table.id, resource.domainId),
          columns: { name: true }
        });
        subjectLabel =
          domain === undefined
            ? null
            : resource.subdomain === null
              ? domain.name
              : `${resource.subdomain}.${domain.name}`;
      }
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
    if (run.subjectType === 'hosting_target') {
      // Check mode, matching the `domain` branch above — a retry from the
      // generic runs list is a diagnostic re-check, never an unattended
      // apply; the panel's own "Reconcile" button is the explicit apply
      // action (hb7 §2.6).
      const infrastructure = await import('@loxep/infrastructure');
      const enqueue = getInfrastructureEnqueue();
      await handle.db.transaction(async (tx) => {
        await enqueue(
          tx,
          infrastructure.RECONCILE_CONTAINER_HOST_TASK,
          { hostingTargetId: run.subjectId, mode: 'check', trigger: 'manual' },
          {
            jobKey: infrastructure.containerHostJobKey(
              infrastructure.RECONCILE_CONTAINER_HOST_TASK,
              run.subjectId
            )
          }
        );
      });
      return { retried: true };
    }
    throw new Error(`No retry action exists yet for subject type "${run.subjectType}"`);
  });
