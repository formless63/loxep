/**
 * Server functions for the Tailscale estate browser (loxep-47o.6): the whole
 * tailnet, read live in ONE `listDevices()` call —
 * `apps/docs/src/content/docs/architecture/estate-browsers-design.md` §3.6.
 *
 * ## One call, not two
 *
 * `probe()` and `listDevices()` are the SAME underlying read (both a devices
 * list — see `@loxep/integration-tailscale`'s own module doc: "no whoami/
 * identity endpoint is documented… `probe()` therefore reuses the cheapest
 * authenticated read available"). This estate page calls `listDevices()`
 * ONLY — never both — matching the design's "probe() is the same read and
 * must NOT be called a second time."
 *
 * ## The whole tailnet, including linked and ignored devices
 *
 * Unlike `infrastructure-functions.ts`'s `fetchUnmatchedTailscaleDevices`
 * (the fleet LIST page's candidates panel, which reads the LAST SWEEP's
 * persisted `external_resources` rows and shows only the unlinked
 * remainder), this page reads Tailscale LIVE and shows every device the
 * tailnet has — laptops and phones included, per the design's own "scope
 * note that must not be 'fixed'": an estate page IS the whole connection.
 *
 * The cross-reference against `resource_links`/`tailscaleIgnoredDevicesSetting`
 * is a Loxep-DB read, keyed on the device's own tailnet node id
 * (`externalDeviceId`) — NEVER on `name`/`hostname`, which Tailscale
 * contracts neither as unique (the design's own binding instruction, and the
 * same "node id, never name" discipline `fleet-health.ts`'s own discovery
 * sweep already applies).
 *
 * ## The CGNAT rule
 *
 * Every device's `addresses` are Tailscale's own 100.64.0.0/10 CGNAT
 * addresses, rendered VERBATIM (Rule P3) purely as identifying facts. This
 * server function returns them as plain strings; the section component that
 * renders them (`tailscale-sections.tsx`) must NEVER offer a "copy to
 * hosting target" or "use as address" affordance next to them — a published
 * CGNAT address in `hosting_targets.address_v4/v6` is an outage that
 * presents as a propagation problem (loxep-50t's hard rule, carried
 * unchanged into this design's §3.6). Nothing in this file writes any
 * `hosting_targets` column, so that rule cannot be violated server-side
 * either.
 *
 * ## Writes: none against Tailscale, ever
 *
 * The three row actions (link, declare, ignore) all reuse the EXISTING
 * candidates-panel server functions from `infrastructure-functions.ts`
 * (`attachDiscoveredFleetResource`, `setTailscaleDeviceIgnored`) — this file
 * adds no new write of any kind (Rule P10). A device the live call reports
 * but the last sweep never wrote to `external_resources` yet (no
 * `externalResourceId`) simply cannot be linked/declared/ignored from this
 * page until the next sweep — an honest degrade, not a new discovery path.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { estateError, estateOk } from '@/features/estate/types';
import { classifyCaughtProviderError } from '@/features/estate/error-taxonomy';
import { estateResourceCrossReference } from '@/features/estate/resource-cross-reference';
import type { EstateSectionResult } from '@/features/estate/types';

const TAILSCALE_PROVIDER = 'tailscale';

function iso(date: Date): string {
  return date.toISOString();
}

const connectionIdInput = z.strictObject({ connectionId: z.uuid() });

/** Resolves the connection and throws unless it is really a Tailscale one. */
async function requireTailscaleConnection(connectionId: string): Promise<void> {
  const { getAdminServices } = await import('@/server/admin');
  const { connections } = getAdminServices();
  const connection = await connections.getConnection(connectionId);
  if (connection.provider !== TAILSCALE_PROVIDER) {
    throw new Error(`connection "${connectionId}" is not a Tailscale connection`);
  }
}

/**
 * One tailnet device, live Tailscale facts (Rule P3, verbatim) plus the
 * Loxep-DB cross-reference. `title`/`url` mirror
 * `UnmatchedTailscaleDeviceDto`'s own shape exactly so a row can be handed
 * straight to the EXISTING `LinkDeviceDialog`/`NewHostingTargetDialog` flow
 * (Rule P12 — mount, do not re-implement) without a reshaping step.
 */
export interface TailscaleEstateDeviceDto {
  /** The tailnet node id (`TailscaleDeviceFact.externalDeviceId`) — the ONE stable cross-reference key. */
  externalDeviceId: string;
  /** The MagicDNS name, verbatim. */
  name: string | null;
  hostname: string | null;
  /** CGNAT (100.64.0.0/10) addresses, verbatim — never offer a copy-to-hosting-target affordance next to these (see module doc). */
  addresses: string[];
  online: boolean;
  /** `null` while `online` — Tailscale's own documented contract. */
  lastSeen: string | null;
  os: string | null;
  authorized: boolean | null;
  /** `external_resources.id` for this device, or `null` when the last sweep has never discovered it yet — link/declare/ignore all need this id. */
  externalResourceId: string | null;
  /** `external_resources.title`, when a sweep has set one — the candidates panel's own display fallback. */
  title: string | null;
  /** `external_resources.url`, `''` when `externalResourceId` is `null` (unused by either dialog in that case). */
  url: string;
  /** Non-null exactly when a `resource_links` row already attaches this device to a hosting target. */
  linked: { hostingTargetId: string; hostingTargetName: string } | null;
  /** Non-null when the operator has ignored this device — `tailscaleIgnoredDevicesSetting`'s own recorded instant. */
  ignoredAt: string | null;
}

export const fetchTailscaleEstateDevices = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<TailscaleEstateDeviceDto[]>> => {
    const { requireSession, getAdminServices, getTailscaleAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    await requireTailscaleConnection(data.connectionId);
    const readAt = iso(new Date());

    const { adapter } = await getTailscaleAdapterForConnection(data.connectionId);
    let devices: Awaited<ReturnType<typeof adapter.listDevices>>;
    try {
      devices = await adapter.listDevices();
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'could not list tailnet devices'),
        readAt
      );
    }

    const { handle, settings } = getAdminServices();
    const domain = await import('@loxep/domain');

    const [resourceRows, ignored] = await Promise.all([
      handle.db.query.externalResources.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.provider, TAILSCALE_PROVIDER),
            eq(table.externalType, 'device'),
            eq(table.connectionId, data.connectionId)
          ),
        columns: { id: true, externalId: true, title: true, url: true }
      }),
      settings.get(domain.tailscaleIgnoredDevicesSetting)
    ]);
    const resourceByNodeId = new Map(
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
      devices.map((device) => {
        const resource = resourceByNodeId.get(device.externalDeviceId);
        const crossReference = estateResourceCrossReference(
          device.externalDeviceId,
          resourceByNodeId,
          linkedResourceIdByExternalResourceId,
          hostingTargetNameById
        );
        return {
          externalDeviceId: device.externalDeviceId,
          name: device.name,
          hostname: device.hostname,
          addresses: device.addresses,
          online: device.online,
          lastSeen: device.lastSeen,
          os: device.os,
          authorized: device.authorized,
          externalResourceId: crossReference.externalResourceId,
          title: resource?.title ?? null,
          url: resource?.url ?? '',
          linked: crossReference.linked,
          ignoredAt: ignored[device.externalDeviceId] ?? null
        };
      }),
      readAt
    );
  });
