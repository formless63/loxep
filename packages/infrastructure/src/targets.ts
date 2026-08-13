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
import { hostingTargets } from "@loxep/db/schema";
import { eq } from "drizzle-orm";
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

export interface HostingTargetsService {
  create(input: CreateHostingTargetInput): Promise<HostingTargetRow>;
  get(id: string): Promise<HostingTargetRow>;
  list(): Promise<HostingTargetRow[]>;
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
    if (node.addressV4 === null && node.addressV6 === null) {
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
        if (parsed.frontedByTargetId !== null && parsed.frontedByTargetId !== undefined) {
          await assertFrontingNodeIsTerminal(tx, parsed.frontedByTargetId);
        }

        const rows = await tx
          .insert(hostingTargets)
          .values({
            name: parsed.name,
            controlSurface: parsed.controlSurface,
            provider: parsed.provider ?? null,
            region: parsed.region ?? null,
            addressV4: parsed.addressV4 ?? null,
            addressV6: parsed.addressV6 ?? null,
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
