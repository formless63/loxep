/**
 * Typed hosting-target addresses (loxep-bub): declare/classify/set-primary/
 * remove, an idempotent observer upsert, and the structural quarantine that
 * keeps a `tailnet`/`lan`/`other` row — or an OBSERVED `wan` row — from ever
 * reaching a materialized DNS record.
 *
 * See `packages/db/src/schema/infrastructure.ts`'s `hostAddresses` doc for
 * the full column-by-column rationale. The short version:
 *
 * ```text
 * kind         wan | lan | tailnet | other
 * family       v4 | v6
 * provenance   'operator_declared' (the ONLY provenance `declare()` writes)
 *              or 'observed:<provider>[.<field>]' (the ONLY provenance
 *              `upsertObserved()` writes)
 * ```
 *
 * `classify()` may change `kind`; it can NEVER promote a row's `provenance`
 * to `operator_declared` — an observed row stays observed forever, however
 * it is classified. That single rule is the whole quarantine: the
 * materializer's `wanAddressPair()` below reads `kind = 'wan' AND provenance
 * = 'operator_declared'` and nothing else, so no classification action can
 * ever make an observed address publishable. Only `declare()` — an explicit
 * operator action — can.
 *
 * ## Re-expressing `hosting_targets_addressable_check`
 *
 * The dropped CHECK's rule — "a target that is not deliberately
 * address-less must be resolvable to something: its own address, or a
 * fronting node's" — is enforced here (and in `targets.ts`'s `create()`) as
 * `assertAddressabilityPreserved`: a non-`none`, non-fronted target may never
 * be left with zero `wan`/`operator_declared` rows. `declare()` never needs
 * the check (it only adds); `classify()` and `remove()` both call it because
 * either can remove the LAST such row.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import {
  HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE,
  HOST_ADDRESS_RESOURCE_TYPE,
  HOST_ADDRESS_FAMILIES,
  HOST_ADDRESS_KINDS,
  hostAddresses,
  hostingTargets,
  observedProvenance,
} from "@loxep/db/schema";
import type { HostAddressFamily, HostAddressKind } from "@loxep/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
} from "./errors.ts";

export type HostAddressRow = typeof hostAddresses.$inferSelect;

const declareSchema = z.strictObject({
  kind: z.enum(HOST_ADDRESS_KINDS),
  family: z.enum(HOST_ADDRESS_FAMILIES),
  value: z.string().trim().min(1),
  isPrimary: z.boolean().optional(),
  actorUserId: z.string().min(1).nullish(),
});
export type DeclareHostAddressInput = z.input<typeof declareSchema>;

const classifySchema = z.strictObject({
  kind: z.enum(HOST_ADDRESS_KINDS),
  actorUserId: z.string().min(1).nullish(),
});
export type ClassifyHostAddressInput = z.input<typeof classifySchema>;

const upsertObservedSchema = z.strictObject({
  hostingTargetId: z.string().uuid(),
  kind: z.enum(HOST_ADDRESS_KINDS),
  family: z.enum(HOST_ADDRESS_FAMILIES),
  value: z.string().trim().min(1),
  /** The provider name; `provenance` becomes `observed:<provider>`. */
  provider: z.string().trim().min(1),
  isPrimary: z.boolean().optional(),
});
export type UpsertObservedHostAddressInput = z.input<
  typeof upsertObservedSchema
>;

export interface HostAddressesService {
  listForTarget(hostingTargetId: string): Promise<HostAddressRow[]>;
  get(id: string): Promise<HostAddressRow>;
  /** Always writes `provenance = 'operator_declared'`. */
  declare(
    hostingTargetId: string,
    input: DeclareHostAddressInput,
  ): Promise<HostAddressRow>;
  /** Changes `kind` only. `provenance` never changes here — see the module doc. */
  classify(id: string, input: ClassifyHostAddressInput): Promise<HostAddressRow>;
  /** Marks this row primary within its `(target, kind, family)` group. */
  setPrimary(
    id: string,
    options?: { actorUserId?: string | null },
  ): Promise<HostAddressRow>;
  remove(id: string, options?: { actorUserId?: string | null }): Promise<void>;
  /**
   * The observer verb. Idempotent per sweep: at most one row survives per
   * `(hostingTargetId, kind, family, observedProvenance(provider))` —
   * `host_addresses_observed_slot_uq` is the DB-level guarantee this upsert
   * relies on. A repeated call with the SAME value is a no-op write (fresh
   * `observed_at`); a repeated call with a CHANGED value refreshes the
   * existing row in place rather than accumulating a duplicate.
   */
  upsertObserved(input: UpsertObservedHostAddressInput): Promise<HostAddressRow>;
}

export function createHostAddressesService(options: {
  db: LoxepDb;
}): HostAddressesService {
  const { db } = options;

  async function requireRow(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<HostAddressRow> {
    const rows = await executor
      .select()
      .from(hostAddresses)
      .where(eq(hostAddresses.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`host address ${id} not found`, {
        id,
      });
    }
    return row;
  }

  async function requireTarget(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<typeof hostingTargets.$inferSelect> {
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
   * `hosting_targets_addressable_check`, re-expressed. `excludeAddressId` is
   * the row about to be removed or reclassified away from `wan`/declared —
   * it must not count toward its OWN survival.
   */
  async function assertAddressabilityPreserved(
    tx: Pick<LoxepDb, "select">,
    hostingTargetId: string,
    excludeAddressId: string,
  ): Promise<void> {
    const target = await requireTarget(tx, hostingTargetId);
    if (target.controlSurface === "none" || target.frontedByTargetId !== null) {
      return;
    }
    const rows = await tx
      .select({ id: hostAddresses.id })
      .from(hostAddresses)
      .where(
        and(
          eq(hostAddresses.hostingTargetId, hostingTargetId),
          eq(hostAddresses.kind, "wan"),
          eq(
            hostAddresses.provenance,
            HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE,
          ),
        ),
      );
    const survives = rows.some((row) => row.id !== excludeAddressId);
    if (!survives) {
      throw new InfrastructureValidationError(
        `hosting target "${target.name}" needs at least one operator-declared WAN address (or a fronting node, or control_surface 'none')`,
        { hostingTargetId },
      );
    }
  }

  return {
    async listForTarget(hostingTargetId) {
      return db
        .select()
        .from(hostAddresses)
        .where(eq(hostAddresses.hostingTargetId, hostingTargetId));
    },

    async get(id) {
      return requireRow(db, id);
    },

    async declare(hostingTargetId, input) {
      const parsed = declareSchema.parse(input);
      return db.transaction(async (tx) => {
        await requireTarget(tx, hostingTargetId);

        if (parsed.isPrimary === true) {
          await tx
            .update(hostAddresses)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(hostAddresses.hostingTargetId, hostingTargetId),
                eq(hostAddresses.kind, parsed.kind),
                eq(hostAddresses.family, parsed.family),
              ),
            );
        }

        const rows = await tx
          .insert(hostAddresses)
          .values({
            hostingTargetId,
            kind: parsed.kind,
            family: parsed.family,
            value: parsed.value,
            provenance: HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE,
            isPrimary: parsed.isPrimary ?? false,
            createdByUserId: parsed.actorUserId ?? null,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("host address insert returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.host_address.declare",
          resourceType: HOST_ADDRESS_RESOURCE_TYPE,
          resourceId: row.id,
          after: {
            hostingTargetId,
            kind: row.kind,
            family: row.family,
            isPrimary: row.isPrimary,
          },
        });

        return row;
      });
    },

    async classify(id, input) {
      const parsed = classifySchema.parse(input);
      return db.transaction(async (tx) => {
        const before = await requireRow(tx, id);
        const leavesWanDeclared =
          before.kind === "wan" &&
          before.provenance === HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE &&
          parsed.kind !== "wan";
        if (leavesWanDeclared) {
          await assertAddressabilityPreserved(
            tx,
            before.hostingTargetId,
            before.id,
          );
        }

        const rows = await tx
          .update(hostAddresses)
          .set({ kind: parsed.kind, updatedAt: new Date() })
          .where(eq(hostAddresses.id, id))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("host address update returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.host_address.classify",
          resourceType: HOST_ADDRESS_RESOURCE_TYPE,
          resourceId: id,
          before: { kind: before.kind },
          after: { kind: row.kind },
        });

        return row;
      });
    },

    async setPrimary(id, setPrimaryOptions) {
      return db.transaction(async (tx) => {
        const before = await requireRow(tx, id);

        await tx
          .update(hostAddresses)
          .set({ isPrimary: false, updatedAt: new Date() })
          .where(
            and(
              eq(hostAddresses.hostingTargetId, before.hostingTargetId),
              eq(hostAddresses.kind, before.kind),
              eq(hostAddresses.family, before.family),
              ne(hostAddresses.id, id),
            ),
          );

        const rows = await tx
          .update(hostAddresses)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(hostAddresses.id, id))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("host address update returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: setPrimaryOptions?.actorUserId ?? null,
          action: "infrastructure.host_address.set_primary",
          resourceType: HOST_ADDRESS_RESOURCE_TYPE,
          resourceId: id,
          after: {
            hostingTargetId: row.hostingTargetId,
            kind: row.kind,
            family: row.family,
          },
        });

        return row;
      });
    },

    async remove(id, removeOptions) {
      await db.transaction(async (tx) => {
        const before = await requireRow(tx, id);
        const isWanDeclared =
          before.kind === "wan" &&
          before.provenance === HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE;
        if (isWanDeclared) {
          await assertAddressabilityPreserved(
            tx,
            before.hostingTargetId,
            before.id,
          );
        }

        await tx.delete(hostAddresses).where(eq(hostAddresses.id, id));

        await createAuditService({ db: tx }).append({
          actorUserId: removeOptions?.actorUserId ?? null,
          action: "infrastructure.host_address.remove",
          resourceType: HOST_ADDRESS_RESOURCE_TYPE,
          resourceId: id,
          before: {
            hostingTargetId: before.hostingTargetId,
            kind: before.kind,
            family: before.family,
            provenance: before.provenance,
          },
        });
      });
    },

    async upsertObserved(input) {
      const parsed = upsertObservedSchema.parse(input);
      const provenance = observedProvenance(parsed.provider);

      return db.transaction(async (tx) => {
        await requireTarget(tx, parsed.hostingTargetId);

        const existing = await tx
          .select()
          .from(hostAddresses)
          .where(
            and(
              eq(hostAddresses.hostingTargetId, parsed.hostingTargetId),
              eq(hostAddresses.kind, parsed.kind),
              eq(hostAddresses.family, parsed.family),
              eq(hostAddresses.provenance, provenance),
            ),
          );
        const current = existing[0];
        const now = new Date();

        if (parsed.isPrimary === true) {
          await tx
            .update(hostAddresses)
            .set({ isPrimary: false, updatedAt: now })
            .where(
              and(
                eq(hostAddresses.hostingTargetId, parsed.hostingTargetId),
                eq(hostAddresses.kind, parsed.kind),
                eq(hostAddresses.family, parsed.family),
              ),
            );
        }

        if (current === undefined) {
          const rows = await tx
            .insert(hostAddresses)
            .values({
              hostingTargetId: parsed.hostingTargetId,
              kind: parsed.kind,
              family: parsed.family,
              value: parsed.value,
              provenance,
              isPrimary: parsed.isPrimary ?? false,
              observedAt: now,
            })
            .returning();
          const row = rows[0];
          if (row === undefined) {
            throw new Error("host address insert returned no row");
          }
          return row;
        }

        const rows = await tx
          .update(hostAddresses)
          .set({
            value: parsed.value,
            observedAt: now,
            updatedAt: now,
            ...(parsed.isPrimary === undefined
              ? {}
              : { isPrimary: parsed.isPrimary }),
          })
          .where(eq(hostAddresses.id, current.id))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("host address update returned no row");
        }
        return row;
      });
    },
  };
}

/**
 * The structural quarantine (loxep-bub): the PURE filter that builds the DNS
 * materializer's `HostingTargetNode.addressV4`/`addressV6` pair from a
 * target's full `host_addresses` list. Only `kind = 'wan' AND provenance =
 * 'operator_declared'` rows are ever read — a `tailnet`/`lan`/`other` row,
 * or an OBSERVED `wan` row, cannot influence the output no matter what is
 * stored, because the filter runs before either field is populated.
 *
 * When more than one qualifying row exists for a family, the row marked
 * `isPrimary` wins; absent a primary, the first one found does (an operator
 * with two declared WAN v4 addresses and no primary set gets a stable but
 * unspecified pick — `setPrimary` exists precisely so this ambiguity is the
 * operator's to resolve, not the materializer's).
 *
 * `resolveHostingAddress`'s CGNAT/ULA publish-guard (`tailnet-address.ts`)
 * stays as defense in depth for the one case this filter cannot catch: an
 * operator hand-typing a private-range VALUE into a `wan`-kind,
 * `operator_declared` row.
 */
export function wanAddressPair(
  addresses: readonly Pick<
    HostAddressRow,
    "kind" | "family" | "value" | "provenance" | "isPrimary"
  >[],
): { addressV4: string | null; addressV6: string | null } {
  const declaredWan = addresses.filter(
    (address) =>
      address.kind === "wan" &&
      address.provenance === HOST_ADDRESS_OPERATOR_DECLARED_PROVENANCE,
  );
  const pick = (family: HostAddressFamily): string | null => {
    const candidates = declaredWan.filter((address) => address.family === family);
    const primary = candidates.find((address) => address.isPrimary);
    return (primary ?? candidates[0])?.value ?? null;
  };
  return { addressV4: pick("v4"), addressV6: pick("v6") };
}

export type { HostAddressFamily, HostAddressKind };
