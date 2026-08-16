/**
 * Server functions for the Beszel estate browser (loxep-47o.7): the hub's
 * health plus every system it reports, read live in TWO calls —
 * `apps/docs/src/content/docs/architecture/estate-browsers-design.md` §3.5.
 *
 * ## Two calls, no drill-in, ever
 *
 * `health()` (unauthenticated) and `listSystems()` (which ALREADY walks
 * every page hub-wide internally, up to `BESZEL_MAX_LIST_PAGES` pages of
 * `BESZEL_LIST_PER_PAGE` — see `@loxep/integration-beszel`'s
 * `operations.ts`) are the whole read. There is no `getSystem` on the
 * adapter and there must never be a metric read — Beszel's own capabilities
 * report `readOnly: true` as a literal type, and Loxep's restraint here is
 * "no CPU chart, ever" (the design's own words), not a missing feature.
 *
 * ## Writes: none, ever
 *
 * The one verb this page mounts is ATTACH — the existing operator-confirmed
 * `AttachDiscoveredResourceDialog` (`attach-discovered-resource-dialog.tsx`),
 * wired to the SAME `attachDiscoveredFleetResource` server function the
 * fleet-detail page's own Beszel picker already calls (Rule P10 — this file
 * adds no write of any kind).
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { estateError, estateOk } from '@/features/estate/types';
import { classifyCaughtProviderError } from '@/features/estate/error-taxonomy';
import { estateResourceCrossReference } from '@/features/estate/resource-cross-reference';
import type { EstateSectionResult } from '@/features/estate/types';

const BESZEL_PROVIDER = 'beszel';

function iso(date: Date): string {
  return date.toISOString();
}

const connectionIdInput = z.strictObject({ connectionId: z.uuid() });

/** Resolves the connection and throws unless it is really a Beszel one. */
async function requireBeszelConnection(connectionId: string): Promise<void> {
  const { getAdminServices } = await import('@/server/admin');
  const { connections } = getAdminServices();
  const connection = await connections.getConnection(connectionId);
  if (connection.provider !== BESZEL_PROVIDER) {
    throw new Error(`connection "${connectionId}" is not a Beszel connection`);
  }
}

// ---------------------------------------------------------------------------
// Hub health — unauthenticated
// ---------------------------------------------------------------------------

export interface BeszelEstateHubDto {
  reachable: boolean;
  httpStatus: number;
  /** PocketBase's own message, verbatim (Rule P3). `null` when it sent none. */
  message: string | null;
}

export const fetchBeszelEstateHub = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<BeszelEstateHubDto>> => {
    const { requireSession, getBeszelAdapterForConnection } = await import('@/server/admin');
    await requireSession();
    await requireBeszelConnection(data.connectionId);
    const readAt = iso(new Date());

    const { adapter } = await getBeszelAdapterForConnection(data.connectionId);
    try {
      const health = await adapter.health();
      return estateOk(health, readAt);
    } catch (error) {
      return estateError(classifyCaughtProviderError(error, 'could not read hub health'), readAt);
    }
  });

// ---------------------------------------------------------------------------
// Systems — hub-wide, cross-referenced against linked hosting targets
// ---------------------------------------------------------------------------

export interface BeszelEstateSystemDto {
  externalSystemId: string;
  name: string | null;
  host: string | null;
  port: number | null;
  /** The hub's own string, verbatim (Rule P3) — never mapped onto a Loxep-coined verdict. */
  status: string;
  /** The record's own last-write time, Beszel's clock — distinct from this response's `readAt`. */
  observedAt: string | null;
  sharedWithCount: number;
  /** `external_resources.id` for this system, or `null` when the last discovery sweep has never seen it yet — the Attach dialog needs this connection's own discovery row to exist first. */
  externalResourceId: string | null;
  /** Non-null exactly when a `resource_links` row already attaches this system to a hosting target. */
  linked: { hostingTargetId: string; hostingTargetName: string } | null;
}

export const fetchBeszelEstateSystems = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<BeszelEstateSystemDto[]>> => {
    const { requireSession, getAdminServices, getBeszelAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    await requireBeszelConnection(data.connectionId);
    const readAt = iso(new Date());

    const { adapter } = await getBeszelAdapterForConnection(data.connectionId);
    let systems: Awaited<ReturnType<typeof adapter.listSystems>>;
    try {
      systems = await adapter.listSystems();
    } catch (error) {
      return estateError(classifyCaughtProviderError(error, 'could not list systems'), readAt);
    }

    const { handle } = getAdminServices();
    const resourceRows = await handle.db.query.externalResources.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.provider, BESZEL_PROVIDER),
          eq(table.externalType, 'system'),
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
      systems.map((system) => {
        const crossReference = estateResourceCrossReference(
          system.externalSystemId,
          resourceByExternalId,
          linkedResourceIdByExternalResourceId,
          hostingTargetNameById
        );
        return {
          externalSystemId: system.externalSystemId,
          name: system.name,
          host: system.host,
          port: system.port,
          status: system.status,
          observedAt: system.observedAt,
          sharedWithCount: system.sharedWithCount,
          externalResourceId: crossReference.externalResourceId,
          linked: crossReference.linked
        };
      }),
      readAt
    );
  });
