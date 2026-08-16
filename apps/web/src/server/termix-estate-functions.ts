/**
 * Server functions for the Termix estate browser (loxep-47o.7): hosts
 * instance-wide, plus instance-wide active sessions —
 * `apps/docs/src/content/docs/architecture/estate-browsers-design.md` §3.8.
 *
 * ## Hosts
 *
 * `listHosts()` (internally `/hosts` + `/status`), instance-wide, cross-
 * referenced against linked hosting targets the same way
 * `tailscale-estate-functions.ts`/`beszel-estate-functions.ts` do.
 *
 * ## Sessions — instance-wide, per the owner's 5b ruling (2026-08-16)
 *
 * The design's §8.6 ("Instance-wide Termix sessions name humans") and this
 * bead's own acceptance criteria originally gated an INSTANCE-WIDE sessions
 * section behind an explicit owner grant, shipping hosts-only until then.
 * That grant now exists — owner ruling 2026-08-16, item 5b: instance-wide
 * Termix sessions are permitted, on the SAME trust basis the owner already
 * gave the per-host panel (2026-08-15: "the more info the better … this
 * tool is meant to be used by people that trust one another"). §8.6 itself
 * is updated in the same change that ships this file (see the design doc).
 *
 * `sharedByUsername` renders VERBATIM — the human it names, never redacted
 * or generalized to a count, matching `termix-sessions-panel/columns.tsx`'s
 * own established rule for the per-host panel. This section reuses that
 * EXACT column set (`termixSessionColumns`) and DTO shape
 * (`TermixSessionRowDto`, `infrastructure-functions.ts`) rather than
 * re-declaring a parallel "who/where/age" shape — the wvm design's own
 * fully-specified read, applied instance-wide instead of filtered to one
 * host's `externalHostId`.
 *
 * Every field is read DEFENSIVELY: `@loxep/integration-termix`'s own
 * `stableRecordShapes: false` capability means host/session field names are
 * UNVERIFIED (see that package's module doc) — a field Termix omits renders
 * as an honest `null`/empty, never a thrown error for one malformed row.
 *
 * ## Writes: none, ever
 *
 * `TERMIX_FORBIDDEN_MEMBER_VERBS` is asserted against the adapter's exported
 * surface by a boundary test in `@loxep/integration-termix` — a security
 * control, not a style check. This page mounts no write affordance at all.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { estateError, estateOk } from '@/features/estate/types';
import { classifyCaughtProviderError } from '@/features/estate/error-taxonomy';
import { estateResourceCrossReference } from '@/features/estate/resource-cross-reference';
import type { EstateSectionResult } from '@/features/estate/types';
import type { TermixSessionRowDto } from '@/server/infrastructure-functions';

const TERMIX_PROVIDER = 'termix';

/** Same defensive ceiling `infrastructure-functions.ts`'s per-host panel applies — see `TERMIX_SESSION_ROWS_MAX`'s own doc. */
const TERMIX_ESTATE_SESSION_ROWS_MAX = 200;

function iso(date: Date): string {
  return date.toISOString();
}

const connectionIdInput = z.strictObject({ connectionId: z.uuid() });

/** Resolves the connection and throws unless it is really a Termix one. */
async function requireTermixConnection(connectionId: string): Promise<void> {
  const { getAdminServices } = await import('@/server/admin');
  const { connections } = getAdminServices();
  const connection = await connections.getConnection(connectionId);
  if (connection.provider !== TERMIX_PROVIDER) {
    throw new Error(`connection "${connectionId}" is not a Termix connection`);
  }
}

// ---------------------------------------------------------------------------
// Hosts — instance-wide
// ---------------------------------------------------------------------------

export interface TermixEstateHostDto {
  externalHostId: string;
  name: string | null;
  ip: string | null;
  online: boolean | null;
  lastSeenAt: string | null;
  /** `external_resources.id` for this host, or `null` when the last discovery sweep has never seen it yet. */
  externalResourceId: string | null;
  /** Non-null exactly when a `resource_links` row already attaches this host to a hosting target. */
  linked: { hostingTargetId: string; hostingTargetName: string } | null;
}

export const fetchTermixEstateHosts = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<TermixEstateHostDto[]>> => {
    const { requireSession, getAdminServices, getTermixAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    await requireTermixConnection(data.connectionId);
    const readAt = iso(new Date());

    // `getTermixAdapterForConnection` returns the raw adapter directly
    // (unlike Cloudflare/Pangolin/Purelymail/Tailscale/Beszel's factories,
    // which return the whole `ConnectionAdapter` wrapper) — see its own doc
    // in `admin.ts`.
    const adapter = await getTermixAdapterForConnection(data.connectionId);
    let hosts: Awaited<ReturnType<typeof adapter.listHosts>>;
    try {
      hosts = await adapter.listHosts();
    } catch (error) {
      return estateError(classifyCaughtProviderError(error, 'could not list hosts'), readAt);
    }

    const { handle } = getAdminServices();
    const resourceRows = await handle.db.query.externalResources.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.provider, TERMIX_PROVIDER),
          eq(table.externalType, 'host'),
          eq(table.connectionId, data.connectionId)
        ),
      columns: { id: true, externalId: true }
    });
    const resourceByExternalId = new Map(
      resourceRows
        .filter((row) => row.externalId !== null)
        .map((row) => [row.externalId as string, row])
    );

    const resourceIds = resourceRows.map((row) => row.id);
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
    const linkedResourceIdByExternalResourceId = new Map(
      links.map((link) => [link.externalResourceId, link.resourceId])
    );
    const hostingTargetIds = [...new Set(links.map((link) => link.resourceId))];
    const hostingTargetRows =
      hostingTargetIds.length === 0
        ? []
        : await handle.db.query.hostingTargets.findMany({
            where: (table, { inArray }) => inArray(table.id, hostingTargetIds),
            columns: { id: true, name: true }
          });
    const hostingTargetNameById = new Map(hostingTargetRows.map((row) => [row.id, row.name]));

    return estateOk(
      hosts.map((host) => {
        const crossReference = estateResourceCrossReference(
          host.externalHostId,
          resourceByExternalId,
          linkedResourceIdByExternalResourceId,
          hostingTargetNameById
        );
        return {
          externalHostId: host.externalHostId,
          name: host.name,
          ip: host.ip,
          online: host.online,
          lastSeenAt: host.lastSeenAt,
          externalResourceId: crossReference.externalResourceId,
          linked: crossReference.linked
        };
      }),
      readAt
    );
  });

// ---------------------------------------------------------------------------
// Sessions — instance-wide (owner ruling 2026-08-16, item 5b — see module doc)
// ---------------------------------------------------------------------------

export interface TermixEstateSessionsDto {
  sessions: TermixSessionRowDto[];
  /** `true` when the live list was truncated at `TERMIX_ESTATE_SESSION_ROWS_MAX` — a defensive ceiling, not expected in ordinary use. */
  truncated: boolean;
}

export const fetchTermixEstateSessions = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<TermixEstateSessionsDto>> => {
    const { requireSession, getTermixAdapterForConnection } = await import('@/server/admin');
    await requireSession();
    await requireTermixConnection(data.connectionId);
    const readAt = iso(new Date());

    const adapter = await getTermixAdapterForConnection(data.connectionId);
    let sessions: Awaited<ReturnType<typeof adapter.listSessions>>;
    try {
      sessions = await adapter.listSessions();
    } catch (error) {
      return estateError(classifyCaughtProviderError(error, 'could not list sessions'), readAt);
    }

    return estateOk(
      {
        sessions: sessions.slice(0, TERMIX_ESTATE_SESSION_ROWS_MAX).map((session) => ({
          sessionId: session.sessionId,
          hostId: session.hostId,
          hostName: session.hostName,
          isConnected: session.isConnected,
          createdAt: session.createdAt,
          isOwnSession: session.isOwnSession,
          sharedByUsername: session.sharedByUsername,
          permissionLevel: session.permissionLevel
        })),
        truncated: sessions.length > TERMIX_ESTATE_SESSION_ROWS_MAX
      },
      readAt
    );
  });
