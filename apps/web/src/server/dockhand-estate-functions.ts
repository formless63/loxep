/**
 * Server functions for the Dockhand estate browser (loxep-47o.4), read-only
 * per its own title. Design:
 * `apps/docs/src/content/docs/architecture/estate-browsers-design.md` §3.4.
 *
 * ## Sections, and their call cost
 *
 * {@link fetchDockhandEstateEnvironments} is the OVERVIEW: ONE `listHosts`
 * call, instance-wide, cross-referenced against Loxep's own
 * `external_resources`/`resource_links` (a database read, never a second
 * Dockhand call) — the same auto-attachment `@loxep/app`'s
 * `projectDockhandResources` (health.sweep's discovery sweep) already writes
 * when an environment's name matches an un-decommissioned hosting target.
 * Rule P7's overview budget (at most 3 calls) is honored with room to spare:
 * this section costs exactly ONE call.
 *
 * {@link fetchDockhandEstateEnvironmentDetail} is the per-environment
 * DRILL-IN (Rule P6): fired only when an operator expands one environment,
 * `listContainers` + `listStacks` — TWO calls, exactly what the shipped
 * per-host `DockhandContainersPanel` (`/infrastructure/fleet/$name`,
 * `fetchDockhandHostView`) already makes for ONE linked host. This function
 * is deliberately independent of that one: it reads by `externalHostId`
 * directly, so it works for an environment Loxep has NOT attached to a
 * hosting target yet, which `fetchDockhandHostView` (keyed on
 * `hostingTargetId`) structurally cannot do. Rule P16 forbids this estate
 * page from recruiting the per-host panel itself — this is a parallel,
 * instance-wide-aware read, not a call to `fetchDockhandHostView`.
 *
 * Login costs `DOCKHAND_LOGIN_COST` (4) of an 8-token capacity — the reason
 * the overview is `listHosts` ALONE and every container/stack read is
 * expand-only (design §3.4: "a render that has to authenticate has four
 * tokens left").
 *
 * ## READ-ONLY, absolutely (rule 13 / `DOCKHAND_FORBIDDEN_*`)
 *
 * Nothing in this module calls, exposes, or implies `applyHost`, and no DTO
 * below carries a lifecycle field of any kind — `DockhandAdapter` has no
 * exported member for start/stop/restart/kill/pause/unpause/exec/logs/
 * terminal/file-browse/deploy/redeploy/prune/pull/push/images/networks/
 * volumes/schedules/auto-update, and `test/forbidden-verbs.test.ts` asserts
 * that against the exported adapter surface. `applyHost` itself is
 * write-capable but is not reached from this file — see the design's §3.4
 * "Writes today": this wave ships read-only, with registration staying on
 * `ContainerHostRegistrationPanel` (`/infrastructure/fleet/$name`).
 *
 * ## The one write this page mounts is NOT in this file
 *
 * "Adopt as hosting target" for an unmatched environment reuses
 * `adoptContainerHostAsHostingTarget` from `infrastructure-functions.ts` —
 * the EXACT server function `/infrastructure/overview`'s
 * `UnmatchedContainerHostsCard` already calls (Rule P10/P11: mount, do not
 * re-implement). This module adds no new write of its own; the estate page's
 * components import that existing function directly.
 *
 * ## Honesty states cross the RPC boundary as DATA, not thrown errors
 *
 * Every classifiable Dockhand failure (the adapter's own five-kind taxonomy)
 * is caught HERE and returned as an `EstateSectionResult`'s `'error'` branch
 * — never thrown — matching `cloudflare-estate-functions.ts`'s own
 * discipline.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { classifyCaughtProviderError } from '@/features/estate/error-taxonomy';
import { estateError, estateOk, type EstateSectionResult } from '@/features/estate/types';

function iso(date: Date): string {
  return date.toISOString();
}

const DOCKHAND_PROVIDER = 'dockhand';

const connectionIdInput = z.strictObject({ connectionId: z.uuid() });

/** Resolves the connection and throws unless it is really a Dockhand one — every handler below starts here. */
async function requireDockhandConnection(connectionId: string): Promise<void> {
  const { getAdminServices } = await import('@/server/admin');
  const { connections } = getAdminServices();
  const connection = await connections.getConnection(connectionId);
  if (connection.provider !== DOCKHAND_PROVIDER) {
    throw new Error(`connection "${connectionId}" is not a Dockhand connection`);
  }
}

// ---------------------------------------------------------------------------
// Environments — the overview, ONE call, instance-wide
// ---------------------------------------------------------------------------

/**
 * The Loxep-side identity of one Dockhand environment (Estate Browsers
 * Design §3.4: "cross-referenced against external_resources/resource_links
 * and the auto-attached hosting target"):
 *
 * - `'linked'` — an `external_resources` row exists AND is attached
 *   (`resource_links`, `resourceType: 'hosting_target'`) to a real, non-
 *   decommissioned hosting target. Rule P16: the row links OUT to that
 *   target's fleet-detail page rather than duplicating its panel here.
 * - `'unmatched'` — an `external_resources` row exists (a health.sweep
 *   discovery already ran) but nothing attaches it yet — the ADOPT
 *   affordance's target state.
 * - `'unknown'` — no `external_resources` row exists at all yet (discovery
 *   has not run for this connection). Honest, not an error: there is
 *   nothing to adopt until the next sweep writes the row.
 */
export type DockhandEstateEnvironmentCrossReference =
  | { kind: 'linked'; hostingTargetId: string; hostingTargetName: string }
  | { kind: 'unmatched'; externalResourceId: string }
  | { kind: 'unknown' };

export interface DockhandEstateEnvironmentDto {
  externalHostId: string;
  name: string;
  /** Verbatim from Dockhand (Rule P3) — `socket` when upstream omitted it, the adapter's own default. */
  connectionType: string;
  host: string | null;
  port: number | null;
  protocol: string | null;
  socketPath: string | null;
  /** Presence bit only — never the TLS material itself (`DockhandHostFact`'s own discipline). */
  tlsConfigured: boolean;
  labels: string[];
  publicIp: string | null;
  /** Presence bit only — never the Hawser agent token itself. */
  hawserConfigured: boolean;
  hawserLastSeen: string | null;
  updatedAt: string | null;
  crossReference: DockhandEstateEnvironmentCrossReference;
}

/**
 * The pure cross-reference decision (Estate Browsers Design §3.4): given one
 * host's matching `external_resources` row (if any) and the
 * `resource_links`/`hosting_targets` lookups already batched for this
 * connection, decide `'linked'` / `'unmatched'` / `'unknown'`. Exported and
 * pure so it is unit-testable with fakes — no database, no adapter —
 * matching `cloudflareRecordCrossReference`'s own precedent.
 */
export function dockhandEnvironmentCrossReference(
  resource: { id: string } | undefined,
  hostingTargetIdByResourceId: ReadonlyMap<string, string>,
  targetNameById: ReadonlyMap<string, string>
): DockhandEstateEnvironmentCrossReference {
  if (resource === undefined) return { kind: 'unknown' };
  const hostingTargetId = hostingTargetIdByResourceId.get(resource.id);
  const hostingTargetName =
    hostingTargetId === undefined ? undefined : targetNameById.get(hostingTargetId);
  if (hostingTargetId === undefined || hostingTargetName === undefined) {
    return { kind: 'unmatched', externalResourceId: resource.id };
  }
  return { kind: 'linked', hostingTargetId, hostingTargetName };
}

/**
 * Live `listHosts()`, instance-wide — the whole overview, exactly one
 * Dockhand call. Member-readable (`requireSession`): this is visibility, not
 * control.
 */
export const fetchDockhandEstateEnvironments = createServerFn({ method: 'GET' })
  .inputValidator(connectionIdInput)
  .handler(async ({ data }): Promise<EstateSectionResult<DockhandEstateEnvironmentDto[]>> => {
    const { requireSession, getAdminServices, getDockhandAdapterForConnection } =
      await import('@/server/admin');
    await requireSession();
    await requireDockhandConnection(data.connectionId);
    const readAt = iso(new Date());

    const adapter = await getDockhandAdapterForConnection(data.connectionId);
    let hosts: Awaited<ReturnType<typeof adapter.listHosts>>;
    try {
      hosts = await adapter.listHosts();
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'Could not list Dockhand environments.'),
        readAt
      );
    }

    const { handle } = getAdminServices();
    const resources = await handle.db.query.externalResources.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.provider, DOCKHAND_PROVIDER),
          eq(table.externalType, 'environment'),
          eq(table.connectionId, data.connectionId)
        ),
      columns: { id: true, externalId: true }
    });
    const resourceByExternalId = new Map(
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
      hosts.map((host): DockhandEstateEnvironmentDto => {
        const crossReference = dockhandEnvironmentCrossReference(
          resourceByExternalId.get(host.externalHostId),
          hostingTargetIdByResourceId,
          targetNameById
        );
        return {
          externalHostId: host.externalHostId,
          name: host.name,
          connectionType: host.connectionType,
          host: host.host,
          port: host.port,
          protocol: host.protocol,
          socketPath: host.socketPath,
          tlsConfigured: host.tlsConfigured,
          labels: host.labels,
          publicIp: host.publicIp,
          hawserConfigured: host.hawserConfigured,
          hawserLastSeen: host.hawserLastSeen,
          updatedAt: host.updatedAt,
          crossReference
        };
      }),
      readAt
    );
  });

// ---------------------------------------------------------------------------
// Containers + stacks — PER-ENVIRONMENT drill-in, ON EXPAND ONLY (Rule P6)
// ---------------------------------------------------------------------------

/** No lifecycle field anywhere — rule 13, absolute. See this module's own doc. */
export interface DockhandEstateContainerDto {
  externalContainerId: string;
  name: string | null;
  image: string | null;
  /** Docker's own string, verbatim (`running`, `exited`, …). */
  state: string;
  /** Docker's human status line, verbatim (`Up 3 days`). */
  status: string | null;
}

export interface DockhandEstateStackDto {
  name: string;
  status: string;
  sourceType: string | null;
  containerCount: number;
  runningContainerCount: number;
}

export interface DockhandEstateEnvironmentDetailDto {
  externalHostId: string;
  containers: DockhandEstateContainerDto[];
  stacks: DockhandEstateStackDto[];
}

const fetchDockhandEstateEnvironmentDetailInput = z.strictObject({
  connectionId: z.uuid(),
  externalHostId: z.string().trim().min(1)
});

/**
 * `listContainers` + `listStacks` for ONE environment — two calls, fired
 * only when an operator expands that environment's row (Rule P6). Reads by
 * `externalHostId` directly (never through `hostingTargetId`), so it works
 * for an environment Loxep has not attached to any hosting target yet — see
 * this module's own doc for why this is deliberately NOT
 * `fetchDockhandHostView`.
 */
export const fetchDockhandEstateEnvironmentDetail = createServerFn({ method: 'GET' })
  .inputValidator(fetchDockhandEstateEnvironmentDetailInput)
  .handler(async ({ data }): Promise<EstateSectionResult<DockhandEstateEnvironmentDetailDto>> => {
    const { requireSession, getDockhandAdapterForConnection } = await import('@/server/admin');
    await requireSession();
    await requireDockhandConnection(data.connectionId);
    const readAt = iso(new Date());

    const adapter = await getDockhandAdapterForConnection(data.connectionId);
    try {
      const [containers, stacks] = await Promise.all([
        adapter.listContainers({ externalHostId: data.externalHostId }),
        adapter.listStacks({ externalHostId: data.externalHostId })
      ]);
      return estateOk(
        {
          externalHostId: data.externalHostId,
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
          }))
        },
        readAt
      );
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(
          error,
          "Could not read this environment's containers and stacks."
        ),
        readAt
      );
    }
  });
