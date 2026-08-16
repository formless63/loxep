/**
 * Server functions for the Gatus estate browser (loxep-47o.5). Design:
 * `apps/docs/src/content/docs/architecture/estate-browsers-design.md` §3.7.
 *
 * ## Sections, and their call cost
 *
 * {@link fetchGatusEstateInstance} is the INSTANCE section: `probeConfig()`
 * (unauthenticated) plus `health()` (unauthenticated) — TWO calls. It also
 * recovers the three-way `open`/`basic`/`oidc` posture the adapter's own
 * binary `mode` (`direct` | `oidc_degraded`) discards: `basic` vs `open` is
 * a source-read inference — whether Loxep holds a stored `gatus_credentials`
 * bundle for this connection — layered on top of the adapter's own `oidc`
 * signal, per the adapter package's own module doc ("this inference MAY
 * DRIVE DISPLAY COPY ONLY… it must never gate a read or a capability"). This
 * function never branches on the inferred posture; it only reports it.
 *
 * {@link fetchGatusEstateEndpoints} is the ENDPOINTS section: ONE
 * `listEndpointStatuses` call — direct posture only. In OIDC posture the
 * adapter throws `kind: 'auth'` with `detail.mode === 'oidc_degraded'`
 * (`@loxep/integration-gatus`'s own structural refusal, "provably
 * unwinnable" per its module doc) — this function recognizes that SPECIFIC
 * shape and renders it as Rule P13's BLOCKED state, never as an error; a
 * genuine credential rejection in direct posture (no `detail.mode`) still
 * renders as an ERROR, since that is the provider actually saying no rather
 * than Loxep declining to try. Together with the Instance section, this is
 * THREE adapter-level calls total (Estate Browsers Design §3.7), matching
 * every other estate page's Rule P7 accounting.
 *
 * {@link fetchGatusEstateEndpointUptime} is the per-endpoint DRILL-IN (Rule
 * P6): `endpointUptime(key, duration)`, the one read that works in EVERY
 * auth posture, since the per-endpoint uptime route sits on Gatus's
 * permanently-unauthenticated route group. This is what makes the page
 * usable on an OIDC instance where the Endpoints section is blocked.
 *
 * ## The mandatory exclusion (loxep-1au Binding Rule 1, extended here)
 *
 * `gatusPushSetting.endpointKey` and its five derived fact keys
 * (`@loxep/app`'s `gatusPushQuarantinedKeys()`, re-exported from
 * `fleet-health.ts` — the SAME derivation `gatus-push.ts` pushes to and
 * discovery's own `projectGatusEndpoints` excludes) are removed from
 * {@link fetchGatusEstateEndpoints}'s list in EVERY posture, whether or not
 * the push is enabled, and the drill-in refuses them too (BLOCKED, not an
 * error) as a defense-in-depth match — the self-latching loop the binding
 * rule exists to prevent (Gatus says down -> Loxep writes failing -> the
 * push reports failure -> the endpoint stays down, permanently) does not
 * care which entry point reached the key. The heartbeat mirror
 * (`/infrastructure/overview`'s `FleetSignalsBand`) and `GatusPushCard`
 * (`/settings/application`) keep owning Loxep's own heartbeat; this module
 * never merges or duplicates them, only counts what it excluded so the page
 * can say why a key is missing rather than silently shrinking the list.
 *
 * ## Writes: none, ever
 *
 * Gatus configuration is files-only (30s poll, no API) — `GatusAdapter`
 * exports no write member of any kind, and this module mounts none.
 *
 * ## Honesty states cross the RPC boundary as DATA, not thrown errors
 *
 * Matches `cloudflare-estate-functions.ts`'s discipline: every classifiable
 * Gatus failure is caught here and returned as an `EstateSectionResult`'s
 * `'error'` (or, for the OIDC-degraded shape, `'blocked'`) branch — never
 * thrown.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { classifyCaughtProviderError } from '@/features/estate/error-taxonomy';
import {
  estateBlocked,
  estateError,
  estateOk,
  type EstateSectionResult
} from '@/features/estate/types';

function iso(date: Date): string {
  return date.toISOString();
}

const GATUS_PROVIDER = 'gatus';

const connectionIdInput = z.strictObject({ connectionId: z.uuid() });

/** Resolves the connection and throws unless it is really a Gatus one — every handler below starts here. */
async function requireGatusConnection(connectionId: string): Promise<void> {
  const { getAdminServices } = await import('@/server/admin');
  const { connections } = getAdminServices();
  const connection = await connections.getConnection(connectionId);
  if (connection.provider !== GATUS_PROVIDER) {
    throw new Error(`connection "${connectionId}" is not a Gatus connection`);
  }
}

/**
 * `gatusPushQuarantinedKeys()`'s current set for THIS installation — a
 * single settings read, shared by both the Endpoints list and the uptime
 * drill-in so the two can never disagree about what is quarantined. Fails
 * CLOSED on a settings-read hiccup (an empty set, matching a real key never
 * accidentally excludes real endpoints) — the same posture
 * `projectGatusEndpoints` (`@loxep/app`'s discovery sweep) takes on its own
 * read side.
 */
async function readGatusQuarantinedKeys(): Promise<Set<string>> {
  const [{ getAdminServices }, app, domain] = await Promise.all([
    import('@/server/admin'),
    import('@loxep/app'),
    import('@loxep/domain')
  ]);
  try {
    const pushConfig = await getAdminServices().settings.get(domain.gatusPushSetting);
    return new Set(app.gatusPushQuarantinedKeys(pushConfig));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Instance — probeConfig() + health(), both unauthenticated
// ---------------------------------------------------------------------------

/**
 * The three-way posture this page shows — a DISPLAY-ONLY inference layered
 * on the adapter's own binary `oidc` signal (see this module's own doc and
 * `@loxep/integration-gatus`'s module doc: "may drive copy but NEVER a
 * security decision").
 */
export type GatusEstatePosture = 'open' | 'basic' | 'oidc';

/**
 * The pure posture decision: `oidc: true` always wins (the adapter's own
 * structural signal); otherwise a stored `gatus_credentials` bundle splits
 * `'open'` from `'basic'`. Exported and pure so it is unit-testable with
 * fakes — no adapter, no database — matching
 * `cloudflareRecordCrossReference`'s own precedent. Never gates a read; see
 * this module's own doc.
 */
export function inferGatusEstatePosture(
  oidc: boolean,
  hasStoredCredential: boolean
): GatusEstatePosture {
  if (oidc) return 'oidc';
  return hasStoredCredential ? 'basic' : 'open';
}

/**
 * Recognizes `@loxep/integration-gatus`'s SPECIFIC "OIDC structurally
 * refused this, zero network calls made to the statuses endpoint" shape
 * (`detail.mode === 'oidc_degraded'`) — distinct from a genuine credential
 * rejection in direct posture, which carries no `detail.mode` and must still
 * render as an ERROR (Rule P13), not BLOCKED. Exported and pure so it is
 * unit-testable with fake caught errors.
 */
export function isGatusOidcDegradedRefusal(error: unknown): boolean {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  const mode =
    typeof detail === 'object' && detail !== null
      ? (detail as Record<string, unknown>).mode
      : undefined;
  return mode === 'oidc_degraded';
}

export interface GatusEstateInstanceDto {
  posture: GatusEstatePosture;
  /** Verbatim from Gatus's own config probe (Rule P3) — the signal `posture` is inferred FROM, never overridden. */
  oidc: boolean;
  authenticated: boolean;
  health: { reachable: boolean; status: string | null; httpStatus: number };
}

/**
 * Whether Loxep holds a stored `gatus_credentials` bundle for this
 * connection — the source read that splits the adapter's `oidc: false`
 * bucket into `'open'` vs `'basic'`. Never gates a read; see this module's
 * own doc.
 */
async function readGatusStoredCredentialPresence(connectionId: string): Promise<boolean> {
  const [{ getAdminServices }, app, domain] = await Promise.all([
    import('@/server/admin'),
    import('@loxep/app'),
    import('@loxep/domain')
  ]);
  try {
    await getAdminServices().connectionCredentials.getCredentialPayload(
      connectionId,
      app.GATUS_CREDENTIAL_TYPE
    );
    return true;
  } catch (error) {
    if (error instanceof domain.SecretNotFoundError) return false;
    throw error;
  }
}

/**
 * `probeConfig()` + `health()` — the Instance section, two calls, both
 * unauthenticated. Member-readable (`requireSession`): this is visibility,
 * not control.
 */
export const fetchGatusEstateInstance = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<GatusEstateInstanceDto>> => {
    const { requireSession, getGatusAdapterForConnection } = await import('@/server/admin');
    await requireSession();
    await requireGatusConnection(data.connectionId);
    const readAt = iso(new Date());

    const { adapter } = await getGatusAdapterForConnection(data.connectionId);
    try {
      const [probe, health] = await Promise.all([adapter.probeConfig(), adapter.health()]);
      // Short-circuit: never spend the credential-presence read when `oidc`
      // already decides the posture on its own.
      const hasStoredCredential = probe.oidc
        ? false
        : await readGatusStoredCredentialPresence(data.connectionId);
      const posture = inferGatusEstatePosture(probe.oidc, hasStoredCredential);
      return estateOk(
        { posture, oidc: probe.oidc, authenticated: probe.authenticated, health },
        readAt
      );
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'Could not read this Gatus instance.'),
        readAt
      );
    }
  });

// ---------------------------------------------------------------------------
// Endpoints — listEndpointStatuses(), direct posture only
// ---------------------------------------------------------------------------

export interface GatusEstateEndpointDto {
  /** Gatus's own `<group>_<name>` key (Rule P3). */
  key: string;
  group: string | null;
  name: string | null;
  success: boolean | null;
  httpStatus: number | null;
  /** GATUS's own clock (loxep-1au binding rule 2) — a different field, and a different render, from Loxep's `readAt`. Never merged. */
  observedAt: string | null;
  errorCount: number;
  loxep: { hostingTargetId: string; hostingTargetName: string } | null;
}

export interface GatusEstateEndpointsDto {
  endpoints: GatusEstateEndpointDto[];
  /** How many of the RAW `listEndpointStatuses` rows were removed by the mandatory quarantine — a one-line explanation the section renders, never a silently shorter list. */
  excludedHeartbeatCount: number;
}

const fetchGatusEstateEndpointsInput = z.strictObject({
  connectionId: z.uuid(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50)
});

/**
 * `listEndpointStatuses({page, pageSize})` — the whole Endpoints section,
 * exactly one Gatus call. Reads Gatus's `detail.mode` off a caught `auth`
 * failure to tell "OIDC structurally refused this" (BLOCKED) from "the
 * provider rejected a real credential" (ERROR) — see this module's own doc.
 */
export const fetchGatusEstateEndpoints = createServerFn({ method: 'GET' })
  .inputValidator(fetchGatusEstateEndpointsInput)
  .handler(async ({ data }): Promise<EstateSectionResult<GatusEstateEndpointsDto>> => {
    const { requireSession, getAdminServices, getGatusAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    await requireGatusConnection(data.connectionId);
    const readAt = iso(new Date());

    const { adapter } = await getGatusAdapterForConnection(data.connectionId);
    let statuses: Awaited<ReturnType<typeof adapter.listEndpointStatuses>>;
    try {
      statuses = await adapter.listEndpointStatuses({ page: data.page, pageSize: data.pageSize });
    } catch (error) {
      if (isGatusOidcDegradedRefusal(error)) {
        return estateBlocked(
          "This Gatus instance is OIDC-secured — the bulk endpoint-statuses read is unwinnable for a server-to-server credential. Use each endpoint's uptime drill-in instead; it works in every posture.",
          readAt
        );
      }
      return estateError(
        classifyCaughtProviderError(error, 'Could not list Gatus endpoint statuses.'),
        readAt
      );
    }

    const quarantinedKeys = await readGatusQuarantinedKeys();
    const visible = statuses.filter((status) => !quarantinedKeys.has(status.key));
    const excludedHeartbeatCount = statuses.length - visible.length;

    const { handle } = getAdminServices();
    const visibleKeys = visible.map((status) => status.key);
    const resources =
      visibleKeys.length === 0
        ? []
        : await handle.db.query.externalResources.findMany({
            where: (table, { and, eq, inArray }) =>
              and(
                eq(table.provider, GATUS_PROVIDER),
                eq(table.externalType, 'endpoint'),
                eq(table.connectionId, data.connectionId),
                inArray(table.externalId, visibleKeys)
              ),
            columns: { id: true, externalId: true }
          });
    const resourceByKey = new Map(
      resources
        .filter((row): row is typeof row & { externalId: string } => row.externalId !== null)
        .map((row) => [row.externalId, row])
    );
    const resourceIds = resources.map((row) => row.id);
    const links =
      resourceIds.length === 0
        ? []
        : await handle.db.query.resourceLinks.findMany({
            where: (table, { and, eq, inArray }) =>
              and(
                inArray(table.externalResourceId, resourceIds),
                eq(table.resourceType, 'hosting_target')
              ),
            columns: { externalResourceId: true, resourceId: true }
          });
    const hostingTargetIdByResourceId = new Map(
      links.map((link) => [link.externalResourceId, link.resourceId])
    );
    const hostingTargetIds = [...new Set(links.map((link) => link.resourceId))];
    const targets =
      hostingTargetIds.length === 0
        ? []
        : await handle.db.query.hostingTargets.findMany({
            where: (table, { inArray }) => inArray(table.id, hostingTargetIds),
            columns: { id: true, name: true }
          });
    const targetNameById = new Map(targets.map((target) => [target.id, target.name]));

    return estateOk(
      {
        endpoints: visible.map((status): GatusEstateEndpointDto => {
          const resource = resourceByKey.get(status.key);
          let loxep: GatusEstateEndpointDto['loxep'] = null;
          if (resource !== undefined) {
            const hostingTargetId = hostingTargetIdByResourceId.get(resource.id);
            const hostingTargetName =
              hostingTargetId === undefined ? undefined : targetNameById.get(hostingTargetId);
            if (hostingTargetId !== undefined && hostingTargetName !== undefined) {
              loxep = { hostingTargetId, hostingTargetName };
            }
          }
          return {
            key: status.key,
            group: status.group,
            name: status.name,
            success: status.success,
            httpStatus: status.httpStatus,
            observedAt: status.observedAt,
            errorCount: status.errorCount,
            loxep
          };
        }),
        excludedHeartbeatCount
      },
      readAt
    );
  });

// ---------------------------------------------------------------------------
// Per-endpoint uptime — the always-unauthenticated DRILL-IN (Rule P6)
// ---------------------------------------------------------------------------

const GATUS_ESTATE_UPTIME_DURATIONS = ['30d', '7d', '24h', '1h'] as const;
export type GatusEstateUptimeDuration = (typeof GATUS_ESTATE_UPTIME_DURATIONS)[number];

export interface GatusEstateEndpointUptimeDto {
  key: string;
  duration: GatusEstateUptimeDuration;
  /** A fraction 0..1, Gatus's own value verbatim (Rule P3) — the UI renders the percentage, never this function. */
  uptime: number | null;
}

const fetchGatusEstateEndpointUptimeInput = z.strictObject({
  connectionId: z.uuid(),
  key: z.string().trim().min(1),
  duration: z.enum(GATUS_ESTATE_UPTIME_DURATIONS)
});

/**
 * `endpointUptime(key, duration)` — permanently unauthenticated in every
 * Gatus security posture, which is what keeps this drill-in usable on an
 * OIDC instance where {@link fetchGatusEstateEndpoints} is BLOCKED. Refuses
 * a quarantined key too (defense in depth matching the list's own exclusion
 * — see this module's own doc), even though the UI never offers a drill-in
 * button for a row that was never listed.
 */
export const fetchGatusEstateEndpointUptime = createServerFn({ method: 'GET' })
  .inputValidator(fetchGatusEstateEndpointUptimeInput)
  .handler(async ({ data }): Promise<EstateSectionResult<GatusEstateEndpointUptimeDto>> => {
    const { requireSession, getGatusAdapterForConnection } = await import('@/server/admin');
    await requireSession();
    await requireGatusConnection(data.connectionId);
    const readAt = iso(new Date());

    const quarantinedKeys = await readGatusQuarantinedKeys();
    if (quarantinedKeys.has(data.key)) {
      return estateBlocked(
        "This endpoint is Loxep's own outward heartbeat and is excluded from every read on this page.",
        readAt
      );
    }

    const { adapter } = await getGatusAdapterForConnection(data.connectionId);
    try {
      const result = await adapter.endpointUptime(data.key, data.duration);
      return estateOk({ key: result.key, duration: data.duration, uptime: result.uptime }, readAt);
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, "Could not read this endpoint's uptime."),
        readAt
      );
    }
  });
