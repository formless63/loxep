/**
 * The inventory location tree. A tree, not a warehouse management system.
 *
 * Two design rules are enforced here rather than in the database, both
 * deliberately:
 *
 * 1. **Cycles.** `check(parent_location_id is distinct from id)` stops only the
 *    one-node case; a parent-of-my-ancestor cycle needs a recursive walk, and
 *    the design recommends a SERVICE-level check plus an integrity test over a
 *    trigger, with the depth cap making an accidental cycle self-limiting in
 *    the meantime. {@link LocationsService.setParent} walks the ancestors.
 * 2. **`path`.** The slash-joined ancestor-code string is a CACHE maintained
 *    here on insert and on re-parent, so "everything under the garage" is a
 *    prefix scan instead of a recursive CTE in every read path. The tree is the
 *    truth and a mismatch is a reconciliation finding —
 *    {@link LocationsService.reconcilePaths} is that finding.
 *
 * **Disposition is not a location.** "Sold", "discarded", and "returned to
 * vendor" are movement kinds and item statuses, never locations. `in_transit`
 * is the one virtual kind that earns its place, because goods genuinely are
 * somewhere-not-here between a `transfer_out` and a `transfer_in`.
 *
 * No `economic_entity_id` anywhere in this module. A shelf does not belong to
 * an LLC; the stock on it does.
 */
import type { LoxepDb } from "@loxep/db";
import { inventoryLocations } from "@loxep/db/schema";
import { MAX_LOCATION_DEPTH } from "@loxep/db/schema";
import { z } from "zod";
import {
  InventoryConflictError,
  InventoryNotFoundError,
  InventoryValidationError,
} from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

export type InventoryLocationRow = typeof inventoryLocations.$inferSelect;

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "a location code is a scannable label: letters, digits, dot, dash, underscore",
  )
  .refine(
    (value) => !value.includes("/"),
    "a location code may not contain '/': it is the path separator",
  );

const createLocationSchema = z.strictObject({
  code: codeSchema,
  name: z.string().trim().min(1),
  kind: z.enum([
    "site",
    "room",
    "area",
    "shelf",
    "bin",
    "container",
    "vehicle",
    "in_transit",
  ]),
  parentLocationId: z.uuid().nullish(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
  notes: z.string().nullish(),
});

export type CreateLocationInput = z.input<typeof createLocationSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InventoryValidationError(`invalid location input: ${issues}`);
  }
  return parsed.data;
}

export interface LocationsService {
  create: (input: CreateLocationInput) => Promise<InventoryLocationRow>;
  get: (id: string) => Promise<InventoryLocationRow>;
  /** Re-parent a subtree, rewriting every descendant's `path` and `depth`. */
  setParent: (input: {
    locationId: string;
    parentLocationId: string | null;
  }) => Promise<InventoryLocationRow>;
  /** Every location whose `path` is at or under this one's, by prefix scan. */
  subtree: (locationId: string) => Promise<InventoryLocationRow[]>;
  /** The installation default, if one has been marked. */
  getDefault: () => Promise<InventoryLocationRow | null>;
  /**
   * Recompute `path` and `depth` from the tree and report every row that
   * disagreed. `apply` rewrites them; the default only reports, because a
   * silently repaired cache hides the write path that broke it.
   */
  reconcilePaths: (options?: { apply?: boolean }) => Promise<{
    checked: number;
    mismatched: {
      locationId: string;
      code: string;
      storedPath: string;
      computedPath: string;
      storedDepth: number;
      computedDepth: number;
    }[];
    repaired: boolean;
  }>;
}

export function createLocationsService(options: {
  db: LoxepDb;
}): LocationsService {
  const { db } = options;

  async function get(id: string): Promise<InventoryLocationRow> {
    const row = await db.query.inventoryLocations.findFirst({
      where: (table, { eq }) => eq(table.id, id),
    });
    if (row === undefined) {
      throw new InventoryNotFoundError(`unknown inventory location "${id}"`);
    }
    return row;
  }

  return {
    get,

    create: async (input) => {
      const value = parse(createLocationSchema, input);
      let path = value.code;
      let depth = 0;
      if (value.parentLocationId !== undefined && value.parentLocationId !== null) {
        const parent = await get(value.parentLocationId);
        path = `${parent.path}/${value.code}`;
        depth = parent.depth + 1;
        if (depth > MAX_LOCATION_DEPTH) {
          throw new InventoryConflictError(
            `location depth ${depth} exceeds the cap of ${MAX_LOCATION_DEPTH}; ` +
              "the tree is a tree, not a filing system",
          );
        }
      }
      const rows = await db
        .insert(inventoryLocations)
        .values({
          code: value.code,
          name: value.name,
          kind: value.kind,
          parentLocationId: value.parentLocationId ?? null,
          path,
          depth,
          isDefault: value.isDefault ?? false,
          active: value.active ?? true,
          notes: value.notes ?? null,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new InventoryConflictError("location insert returned no row");
      }
      return row;
    },

    setParent: async (input) =>
      db.transaction(async (tx) => {
        const location = await tx.query.inventoryLocations.findFirst({
          where: (table, { eq }) => eq(table.id, input.locationId),
        });
        if (location === undefined) {
          throw new InventoryNotFoundError(
            `unknown inventory location "${input.locationId}"`,
          );
        }

        let parentPath = "";
        let parentDepth = -1;
        if (input.parentLocationId !== null) {
          if (input.parentLocationId === input.locationId) {
            throw new InventoryConflictError(
              "a location cannot be its own parent",
            );
          }
          // The service-level cycle check the design prescribes: walk up from
          // the proposed parent and refuse if we meet ourselves. A `CHECK`
          // cannot express this, and the depth cap only bounds the damage.
          const ancestors = await tx.execute(
            `with recursive up as (
                 select id, parent_location_id, 0 as level
                   from inventory_locations
                  where id = ${uuidLiteral(input.parentLocationId)}
                 union all
                 select p.id, p.parent_location_id, up.level + 1
                   from inventory_locations p
                   join up on p.id = up.parent_location_id
                  where up.level < ${MAX_LOCATION_DEPTH + 2}
               )
               select id::text as id from up`,
          );
          const chain = ancestors.rows.map((row) => row["id"] as string);
          if (chain.length === 0) {
            throw new InventoryNotFoundError(
              `unknown inventory location "${input.parentLocationId}"`,
            );
          }
          if (chain.includes(input.locationId)) {
            throw new InventoryConflictError(
              "re-parenting there would create a cycle in the location tree",
            );
          }
          const parent = await tx.query.inventoryLocations.findFirst({
            where: (table, { eq }) => eq(table.id, input.parentLocationId ?? ""),
          });
          if (parent === undefined) {
            throw new InventoryNotFoundError(
              `unknown inventory location "${input.parentLocationId}"`,
            );
          }
          parentPath = parent.path;
          parentDepth = parent.depth;
        }

        const newPath =
          parentPath === "" ? location.code : `${parentPath}/${location.code}`;
        const newDepth = parentDepth + 1;

        // Deepest descendant after the move must still fit under the cap.
        const deepest = await tx.execute(
          `select coalesce(max(depth), ${location.depth})::int as d
             from inventory_locations
            where path = ${textLiteral(location.path)}
               or path like ${textLiteral(`${location.path}/`)} || '%'`,
        );
        const subtreeDepth = Number(deepest.rows[0]?.["d"] ?? location.depth);
        if (newDepth + (subtreeDepth - location.depth) > MAX_LOCATION_DEPTH) {
          throw new InventoryConflictError(
            `re-parenting would push the subtree past the depth cap of ${MAX_LOCATION_DEPTH}`,
          );
        }

        await tx.execute(
          `update inventory_locations
              set parent_location_id = ${
                input.parentLocationId === null
                  ? "null"
                  : uuidLiteral(input.parentLocationId)
              },
                  path = ${textLiteral(newPath)},
                  depth = ${newDepth},
                  updated_at = now()
            where id = ${uuidLiteral(location.id)}`,
        );
        // Rewrite the subtree's cached paths and depths in one statement: every
        // descendant keeps its own suffix and swaps the moved node's prefix.
        await tx.execute(
          `update inventory_locations
              set path = ${textLiteral(newPath)}
                         || substring(path from ${location.path.length + 1}),
                  depth = depth + ${newDepth - location.depth},
                  updated_at = now()
            where path like ${textLiteral(`${location.path}/`)} || '%'`,
        );

        const updated = await tx.query.inventoryLocations.findFirst({
          where: (table, { eq }) => eq(table.id, location.id),
        });
        if (updated === undefined) {
          throw new InventoryNotFoundError("location vanished during re-parent");
        }
        return updated;
      }),

    subtree: async (locationId) => {
      const location = await get(locationId);
      const rows = await db.execute(
        `select id::text as id from inventory_locations
          where path = ${textLiteral(location.path)}
             or path like ${textLiteral(`${location.path}/`)} || '%'
          order by path`,
      );
      const ids = rows.rows.map((row) => row["id"] as string);
      if (ids.length === 0) return [];
      return db.query.inventoryLocations.findMany({
        where: (table, { inArray }) => inArray(table.id, ids),
        orderBy: (table, { asc }) => [asc(table.path)],
      });
    },

    getDefault: async () => {
      const row = await db.query.inventoryLocations.findFirst({
        where: (table, { and, eq }) =>
          and(eq(table.isDefault, true), eq(table.active, true)),
        orderBy: (table, { asc }) => [asc(table.path)],
      });
      return row ?? null;
    },

    reconcilePaths: async (reconcileOptions) => {
      const rows = await db.execute(
        `with recursive tree as (
             select id, parent_location_id, code, path, depth,
                    code as computed_path, 0 as computed_depth
               from inventory_locations
              where parent_location_id is null
             union all
             select c.id, c.parent_location_id, c.code, c.path, c.depth,
                    t.computed_path || '/' || c.code, t.computed_depth + 1
               from inventory_locations c
               join tree t on c.parent_location_id = t.id
           )
           select id::text as id, code, path, depth,
                  computed_path, computed_depth
             from tree
            where path <> computed_path or depth <> computed_depth
            order by computed_path`,
      );
      const counted = await db.execute(
        "select count(*)::int as n from inventory_locations",
      );
      const mismatched = rows.rows.map((row) => ({
        locationId: row["id"] as string,
        code: row["code"] as string,
        storedPath: row["path"] as string,
        computedPath: row["computed_path"] as string,
        storedDepth: Number(row["depth"]),
        computedDepth: Number(row["computed_depth"]),
      }));
      if (reconcileOptions?.apply === true && mismatched.length > 0) {
        await db.transaction(async (tx) => {
          for (const entry of mismatched) {
            await tx.execute(
              `update inventory_locations
                  set path = ${textLiteral(entry.computedPath)},
                      depth = ${entry.computedDepth},
                      updated_at = now()
                where id = ${uuidLiteral(entry.locationId)}`,
            );
          }
        });
      }
      return {
        checked: Number(counted.rows[0]?.["n"] ?? 0),
        mismatched,
        repaired: reconcileOptions?.apply === true && mismatched.length > 0,
      };
    },
  };
}
