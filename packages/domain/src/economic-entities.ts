/**
 * Economic entities service over `economic_entities` (ADR-0017,
 * foundation-schema "Economic entities").
 *
 * Economic entities are minimal attribution/business-context records — a
 * person, business, or operating identity whose activity Loxep may attribute
 * and analyze. They are NOT users, NOT permission containers, and NOT
 * accounting books: this service carries no user/ACL columns and never
 * filters by user. Rows are soft-deactivated (`active = false`), never
 * deleted, because attributed data may reference them indefinitely.
 *
 * `kind` is descriptive application state validated against the ADR-0017
 * text union — it encodes no tax/legal conclusion. `parent_entity_id`
 * expresses relationships such as an assumed name beneath an LLC; the
 * hierarchy is validated (parent exists, no self-parenting, no cycles,
 * bounded depth).
 *
 * Queries go through the Drizzle relational query API and primary-key
 * upserts so `@loxep/domain` needs no direct `drizzle-orm` dependency.
 */
import { ECONOMIC_ENTITY_KINDS, economicEntities } from "@loxep/db/schema";
import type { EconomicEntityKind } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import { createAuditService } from "./audit.ts";
import {
  DomainValidationError,
  EntityHierarchyError,
  EntityNotFoundError,
} from "./errors.ts";

/**
 * Maximum ancestor-chain length walked during parent validation. Real
 * hierarchies (assumed name → LLC → …) are shallow; hitting the cap means
 * the data is wrong, so it fails loudly instead of looping.
 */
const MAX_PARENT_DEPTH = 32;

const kindSchema = z.enum(ECONOMIC_ENTITY_KINDS);

const createEntitySchema = z.strictObject({
  name: z.string().trim().min(1),
  kind: kindSchema,
  parentEntityId: z.uuid().nullish(),
  legalName: z.string().trim().min(1).nullish(),
});

const updateEntitySchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  kind: kindSchema.optional(),
  parentEntityId: z.uuid().nullable().optional(),
  legalName: z.string().trim().min(1).nullable().optional(),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export interface EconomicEntity {
  id: string;
  name: string;
  kind: EconomicEntityKind;
  parentEntityId: string | null;
  legalName: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface EconomicEntityListEntry extends EconomicEntity {
  /** Number of entities whose `parent_entity_id` points at this entity. */
  childCount: number;
}

export interface EconomicEntityTreeNode {
  entity: EconomicEntity;
  children: EconomicEntityTreeNode[];
}

export interface EntityMutationOptions {
  actorUserId?: string | null;
  requestId?: string | null;
}

export interface EconomicEntitiesService {
  createEntity: (
    input: {
      name: string;
      kind: EconomicEntityKind;
      parentEntityId?: string | null;
      legalName?: string | null;
    },
    options?: EntityMutationOptions,
  ) => Promise<EconomicEntity>;
  updateEntity: (
    id: string,
    patch: {
      name?: string;
      kind?: EconomicEntityKind;
      parentEntityId?: string | null;
      legalName?: string | null;
    },
    options?: EntityMutationOptions,
  ) => Promise<EconomicEntity>;
  getEntity: (id: string) => Promise<EconomicEntity>;
  /** All entities (active and inactive) with child counts; never filtered by user. */
  listEntities: (options?: {
    includeInactive?: boolean;
  }) => Promise<EconomicEntityListEntry[]>;
  /** Parent/child forest assembled from all rows, roots and children sorted by name. */
  listTree: () => Promise<EconomicEntityTreeNode[]>;
  /** Soft-deactivation: sets `active = false`; rows are never deleted. Idempotent. */
  deactivateEntity: (
    id: string,
    options?: EntityMutationOptions,
  ) => Promise<EconomicEntity>;
}

type EntityRow = typeof economicEntities.$inferSelect;

function toEntity(row: EntityRow): EconomicEntity {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as EconomicEntityKind,
    parentEntityId: row.parentEntityId,
    legalName: row.legalName,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function entitySnapshot(row: EntityRow): Record<string, unknown> {
  return {
    name: row.name,
    kind: row.kind,
    parentEntityId: row.parentEntityId,
    legalName: row.legalName,
    active: row.active,
  };
}

export function createEconomicEntitiesService(options: {
  db: LoxepDb;
}): EconomicEntitiesService {
  const { db } = options;

  /**
   * Validates a proposed parent: it must exist, must not be the entity
   * itself, and walking its ancestor chain must neither revisit the entity
   * (cycle) nor exceed {@link MAX_PARENT_DEPTH}.
   */
  async function assertParentValid(
    executor: Pick<LoxepDb, "query">,
    entityId: string | null,
    parentEntityId: string,
  ): Promise<void> {
    if (entityId !== null && parentEntityId === entityId) {
      throw new EntityHierarchyError(
        `economic entity ${entityId} cannot be its own parent`,
      );
    }
    let current: string | null = parentEntityId;
    let depth = 0;
    while (current !== null) {
      depth += 1;
      if (depth > MAX_PARENT_DEPTH) {
        throw new EntityHierarchyError(
          `parent chain above entity ${parentEntityId} exceeds the maximum depth of ${MAX_PARENT_DEPTH}`,
        );
      }
      const currentId: string = current;
      const row: { id: string; parentEntityId: string | null } | undefined =
        await executor.query.economicEntities.findFirst({
          where: (table, { eq }) => eq(table.id, currentId),
          columns: { id: true, parentEntityId: true },
        });
      if (row === undefined) {
        // Only reachable on the first hop; deeper rows are FK-guaranteed.
        throw new EntityNotFoundError(
          `parent economic entity ${currentId} does not exist`,
        );
      }
      if (entityId !== null && row.parentEntityId === entityId) {
        throw new EntityHierarchyError(
          `setting parent ${parentEntityId} on entity ${entityId} would create a cycle`,
        );
      }
      current = row.parentEntityId;
    }
  }

  async function requireEntity(
    executor: Pick<LoxepDb, "query">,
    id: string,
  ): Promise<EntityRow> {
    const row = await executor.query.economicEntities.findFirst({
      where: (table, { eq }) => eq(table.id, id),
    });
    if (row === undefined) {
      throw new EntityNotFoundError(`economic entity ${id} does not exist`);
    }
    return row;
  }

  async function createEntity(
    input: {
      name: string;
      kind: EconomicEntityKind;
      parentEntityId?: string | null;
      legalName?: string | null;
    },
    mutationOptions?: EntityMutationOptions,
  ): Promise<EconomicEntity> {
    const result = createEntitySchema.safeParse(input);
    if (!result.success) {
      throw new DomainValidationError(
        `invalid economic entity: ${formatIssues(result.error)}`,
      );
    }
    const parsed = result.data;
    const actorUserId = mutationOptions?.actorUserId ?? null;

    return db.transaction(async (tx) => {
      if (parsed.parentEntityId != null) {
        await assertParentValid(tx, null, parsed.parentEntityId);
      }
      const inserted = await tx
        .insert(economicEntities)
        .values({
          name: parsed.name,
          kind: parsed.kind,
          parentEntityId: parsed.parentEntityId ?? null,
          legalName: parsed.legalName ?? null,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new Error("economic entity insert returned no row");
      }

      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId,
        action: "economic_entity.create",
        resourceType: "economic_entity",
        resourceId: row.id,
        before: null,
        after: entitySnapshot(row),
        requestId: mutationOptions?.requestId ?? null,
        metadata: { name: row.name, kind: row.kind },
      });
      return toEntity(row);
    });
  }

  async function updateEntity(
    id: string,
    patch: {
      name?: string;
      kind?: EconomicEntityKind;
      parentEntityId?: string | null;
      legalName?: string | null;
    },
    mutationOptions?: EntityMutationOptions,
  ): Promise<EconomicEntity> {
    const result = updateEntitySchema.safeParse(patch);
    if (!result.success) {
      throw new DomainValidationError(
        `invalid economic entity patch: ${formatIssues(result.error)}`,
      );
    }
    const parsed = result.data;
    const actorUserId = mutationOptions?.actorUserId ?? null;

    return db.transaction(async (tx) => {
      const existing = await requireEntity(tx, id);
      if (
        parsed.parentEntityId !== undefined &&
        parsed.parentEntityId !== null
      ) {
        await assertParentValid(tx, id, parsed.parentEntityId);
      }

      const next = {
        name: parsed.name ?? existing.name,
        kind: parsed.kind ?? existing.kind,
        parentEntityId:
          parsed.parentEntityId === undefined
            ? existing.parentEntityId
            : parsed.parentEntityId,
        legalName:
          parsed.legalName === undefined
            ? existing.legalName
            : parsed.legalName,
        updatedAt: new Date(),
      };
      // Primary-key upsert (row is known to exist) — no direct drizzle-orm import.
      const updated = await tx
        .insert(economicEntities)
        .values({ id, name: next.name, kind: next.kind })
        .onConflictDoUpdate({ target: economicEntities.id, set: next })
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new Error("economic entity update returned no row");
      }

      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId,
        action: "economic_entity.update",
        resourceType: "economic_entity",
        resourceId: id,
        before: entitySnapshot(existing),
        after: entitySnapshot(row),
        requestId: mutationOptions?.requestId ?? null,
        metadata: { name: row.name, kind: row.kind },
      });
      return toEntity(row);
    });
  }

  async function getEntity(id: string): Promise<EconomicEntity> {
    const row = await requireEntity(db, id);
    return toEntity(row);
  }

  async function listEntities(listOptions?: {
    includeInactive?: boolean;
  }): Promise<EconomicEntityListEntry[]> {
    const includeInactive = listOptions?.includeInactive ?? true;
    const rows = await db.query.economicEntities.findMany({
      orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
    });
    const childCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.parentEntityId !== null) {
        childCounts.set(
          row.parentEntityId,
          (childCounts.get(row.parentEntityId) ?? 0) + 1,
        );
      }
    }
    return rows
      .filter((row) => includeInactive || row.active)
      .map((row) => ({
        ...toEntity(row),
        childCount: childCounts.get(row.id) ?? 0,
      }));
  }

  async function listTree(): Promise<EconomicEntityTreeNode[]> {
    const rows = await db.query.economicEntities.findMany({
      orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
    });
    const nodes = new Map<string, EconomicEntityTreeNode>(
      rows.map((row) => [row.id, { entity: toEntity(row), children: [] }]),
    );
    const roots: EconomicEntityTreeNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id);
      if (node === undefined) continue;
      const parent =
        row.parentEntityId === null
          ? undefined
          : nodes.get(row.parentEntityId);
      if (parent === undefined) {
        roots.push(node);
      } else {
        parent.children.push(node);
      }
    }
    return roots;
  }

  async function deactivateEntity(
    id: string,
    mutationOptions?: EntityMutationOptions,
  ): Promise<EconomicEntity> {
    const actorUserId = mutationOptions?.actorUserId ?? null;
    return db.transaction(async (tx) => {
      const existing = await requireEntity(tx, id);
      if (!existing.active) {
        // Idempotent: already deactivated, no state change, no audit noise.
        return toEntity(existing);
      }
      const updated = await tx
        .insert(economicEntities)
        .values({ id, name: existing.name, kind: existing.kind })
        .onConflictDoUpdate({
          target: economicEntities.id,
          set: { active: false, updatedAt: new Date() },
        })
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new Error("economic entity deactivate returned no row");
      }

      const audit = createAuditService({ db: tx });
      await audit.append({
        actorUserId,
        action: "economic_entity.deactivate",
        resourceType: "economic_entity",
        resourceId: id,
        before: entitySnapshot(existing),
        after: entitySnapshot(row),
        requestId: mutationOptions?.requestId ?? null,
        metadata: { name: row.name, kind: row.kind },
      });
      return toEntity(row);
    });
  }

  return {
    createEntity,
    updateEntity,
    getEntity,
    listEntities,
    listTree,
    deactivateEntity,
  };
}
