/**
 * Hosting targets: the places a name can point at.
 *
 * The service exists mainly to enforce the two rules PostgreSQL cannot state
 * declaratively, both of them about the fronting chain:
 *
 * 1. **a fronting node may not itself be fronted** — the relationship is ONE
 *    hop;
 * 2. **no cycle**, of any length. The table's `CHECK` blocks the trivial
 *    self-loop and nothing more, and the design says so explicitly: *"Say so
 *    in the service, because the next reader will assume the constraint covers
 *    it."*
 *
 * Every operator intent change writes an `audit_events` row **in the same
 * transaction** as the change, exactly as `SettingsService.setByKey` and the
 * credential services do.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import {
  HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE,
  hostAddresses,
  hostingTargets,
} from "@loxep/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
} from "./errors.ts";

export type HostingTargetRow = typeof hostingTargets.$inferSelect;

/** `audit_events.resource_type` for this table. */
export const HOSTING_TARGET_RESOURCE_TYPE = "hosting_target";

const CONTROL_SURFACES = [
  "proxy_node",
  "tunnel_client",
  "direct_reverse_proxy",
  "none",
] as const;

const createSchema = z
  .strictObject({
    name: z.string().trim().min(1),
    controlSurface: z.enum(CONTROL_SURFACES),
    provider: z.string().trim().min(1).nullish(),
    region: z.string().trim().min(1).nullish(),
    addressV4: z.string().trim().min(1).nullish(),
    addressV6: z.string().trim().min(1).nullish(),
    frontedByTargetId: z.string().uuid().nullish(),
    proxyConnectionId: z.string().uuid().nullish(),
    externalSiteId: z.string().trim().min(1).nullish(),
    notes: z.string().trim().min(1).nullish(),
    createdByUserId: z.string().min(1).nullish(),
  })
  .refine(
    (value) =>
      (value.controlSurface === "tunnel_client") ===
      (value.frontedByTargetId !== null && value.frontedByTargetId !== undefined),
    {
      message:
        "control_surface 'tunnel_client' requires a fronting node, and only a tunnel client may have one",
      path: ["frontedByTargetId"],
    },
  );

export type CreateHostingTargetInput = z.input<typeof createSchema>;

const updateProxyConnectionSchema = z.strictObject({
  proxyConnectionId: z.string().uuid().nullish(),
  externalSiteId: z.string().trim().min(1).nullish(),
  actorUserId: z.string().min(1).nullish(),
});

export type UpdateProxyConnectionInput = z.input<
  typeof updateProxyConnectionSchema
>;

export interface HostingTargetsService {
  create(input: CreateHostingTargetInput): Promise<HostingTargetRow>;
  get(id: string): Promise<HostingTargetRow>;
  list(): Promise<HostingTargetRow[]>;
  /**
   * Links (or clears) the target's `proxy_connection_id`/`external_site_id`
   * — the Pangolin chain design's milestone 2 (loxep-acj.2), and the ONE
   * write this milestone adds anywhere: it edits Loxep's OWN row, never a
   * Pangolin call. `create()` already accepted both fields at creation time;
   * this is the update path for a target that already exists — the design's
   * own scope item, "linking a pangolin connection to a hosting target
   * through the existing connection/link surfaces."
   */
  updateProxyConnection(
    id: string,
    input: UpdateProxyConnectionInput,
  ): Promise<HostingTargetRow>;
  /** Retire without deleting: history is why the column exists at all. */
  decommission(
    id: string,
    options?: { actorUserId?: string | null },
  ): Promise<HostingTargetRow>;
}

export function createHostingTargetsService(options: {
  db: LoxepDb;
}): HostingTargetsService {
  const { db } = options;

  async function requireTarget(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<HostingTargetRow> {
    const rows = await executor
      .select()
      .from(hostingTargets)
      .where(eq(hostingTargets.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`hosting target ${id} not found`, {
        id,
      });
    }
    return row;
  }

  /**
   * The one-hop rule. A tunnel client's fronting node must exist, must not be
   * decommissioned, and must not itself be fronted — which also makes a cycle
   * of any length unreachable, because no chain can be longer than one hop.
   */
  async function assertFrontingNodeIsTerminal(
    executor: Pick<LoxepDb, "select">,
    frontedByTargetId: string,
  ): Promise<void> {
    const node = await requireTarget(executor, frontedByTargetId);
    if (node.decommissionedAt !== null) {
      throw new InfrastructureValidationError(
        `hosting target "${node.name}" is decommissioned and cannot front another target`,
        { frontedByTargetId },
      );
    }
    if (node.frontedByTargetId !== null) {
      throw new InfrastructureValidationError(
        `hosting target "${node.name}" is itself fronted; the fronting relationship is ONE hop`,
        { frontedByTargetId, itsFrontingNode: node.frontedByTargetId },
      );
    }
    // Was `node.addressV4 === null && node.addressV6 === null` — that pair
    // is gone (loxep-bub). Re-expressed against `host_addresses`: a fronting
    // node must carry at least one operator-declared WAN row, the same
    // WAN-only semantic `address_v4`/`address_v6` always carried.
    const wanRows = await executor
      .select({ id: hostAddresses.id })
      .from(hostAddresses)
      .where(
        and(
          eq(hostAddresses.hostingTargetId, frontedByTargetId),
          eq(hostAddresses.kind, "wan"),
          eq(
            hostAddresses.provenance,
            HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE,
          ),
        ),
      );
    if (wanRows.length === 0) {
      // Caught here rather than at materialization, where the diagnostic would
      // arrive during a sweep instead of at the edit that caused it.
      throw new InfrastructureValidationError(
        `hosting target "${node.name}" has no address and cannot front another target`,
        { frontedByTargetId },
      );
    }
  }

  return {
    async create(input) {
      const parsed = createSchema.parse(input);

      return db.transaction(async (tx) => {
        const hasFrontingNode =
          parsed.frontedByTargetId !== null && parsed.frontedByTargetId !== undefined;
        if (hasFrontingNode) {
          await assertFrontingNodeIsTerminal(tx, parsed.frontedByTargetId as string);
        }

        // `hosting_targets_addressable_check`, re-expressed (loxep-bub): a
        // `CHECK` cannot query `host_addresses`, so the DB no longer refuses
        // this at INSERT time — it is enforced here, synchronously, before
        // either row is written, so the failure lands at the same edit that
        // caused it rather than at the next materialize/sync run.
        const hasInlineWanAddress =
          (parsed.addressV4 !== null && parsed.addressV4 !== undefined) ||
          (parsed.addressV6 !== null && parsed.addressV6 !== undefined);
        if (parsed.controlSurface !== "none" && !hasFrontingNode && !hasInlineWanAddress) {
          throw new InfrastructureValidationError(
            `hosting target "${parsed.name}" needs an operator-declared WAN address (or a fronting node, or control_surface 'none')`,
            { name: parsed.name, controlSurface: parsed.controlSurface },
          );
        }

        const rows = await tx
          .insert(hostingTargets)
          .values({
            name: parsed.name,
            controlSurface: parsed.controlSurface,
            provider: parsed.provider ?? null,
            region: parsed.region ?? null,
            frontedByTargetId: parsed.frontedByTargetId ?? null,
            proxyConnectionId: parsed.proxyConnectionId ?? null,
            externalSiteId: parsed.externalSiteId ?? null,
            notes: parsed.notes ?? null,
            createdByUserId: parsed.createdByUserId ?? null,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("hosting target insert returned no row");
        }

        // The create dialog's (and this service's) `addressV4`/`addressV6`
        // convenience fields write `wan`/`operator_declared`/primary rows in
        // the SAME transaction — declaring more addresses (LAN, tailnet, a
        // second WAN address) is `host-addresses.ts`'s `declare()`, a
        // separate, later action.
        if (parsed.addressV4 !== null && parsed.addressV4 !== undefined) {
          await tx.insert(hostAddresses).values({
            hostingTargetId: row.id,
            kind: "wan",
            family: "v4",
            value: parsed.addressV4,
            provenance: HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE,
            isPrimary: true,
            createdByUserId: parsed.createdByUserId ?? null,
          });
        }
        if (parsed.addressV6 !== null && parsed.addressV6 !== undefined) {
          await tx.insert(hostAddresses).values({
            hostingTargetId: row.id,
            kind: "wan",
            family: "v6",
            value: parsed.addressV6,
            provenance: HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE,
            isPrimary: true,
            createdByUserId: parsed.createdByUserId ?? null,
          });
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.createdByUserId ?? null,
          action: "infrastructure.hosting_target.create",
          resourceType: HOSTING_TARGET_RESOURCE_TYPE,
          resourceId: row.id,
          after: {
            name: row.name,
            controlSurface: row.controlSurface,
            frontedByTargetId: row.frontedByTargetId,
          },
        });

        return row;
      });
    },

    async get(id) {
      return requireTarget(db, id);
    },

    async list() {
      return db.select().from(hostingTargets);
    },

    async updateProxyConnection(id, input) {
      const parsed = updateProxyConnectionSchema.parse(input);
      return db.transaction(async (tx) => {
        const before = await requireTarget(tx, id);
        const rows = await tx
          .update(hostingTargets)
          .set({
            proxyConnectionId: parsed.proxyConnectionId ?? null,
            externalSiteId: parsed.externalSiteId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(hostingTargets.id, id))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("hosting target update returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.hosting_target.update_proxy_connection",
          resourceType: HOSTING_TARGET_RESOURCE_TYPE,
          resourceId: id,
          before: {
            proxyConnectionId: before.proxyConnectionId,
            externalSiteId: before.externalSiteId,
          },
          after: {
            proxyConnectionId: row.proxyConnectionId,
            externalSiteId: row.externalSiteId,
          },
        });

        return row;
      });
    },

    async decommission(id, decommissionOptions) {
      return db.transaction(async (tx) => {
        const before = await requireTarget(tx, id);
        const rows = await tx
          .update(hostingTargets)
          .set({ decommissionedAt: new Date(), updatedAt: new Date() })
          .where(eq(hostingTargets.id, id))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("hosting target update returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: decommissionOptions?.actorUserId ?? null,
          action: "infrastructure.hosting_target.decommission",
          resourceType: HOSTING_TARGET_RESOURCE_TYPE,
          resourceId: id,
          before: { decommissionedAt: before.decommissionedAt },
          after: { decommissionedAt: row.decommissionedAt },
        });

        return row;
      });
    },
  };
}
