/**
 * The counterparty record: create, update, declare a mirror, and every read
 * path that must resolve the survivor pointer.
 *
 * ## The boundary this service exists to keep
 *
 * A counterparty is an outside party. An economic entity is one of ours. The
 * database says so in three places — no `economic_entity_id` column, a
 * `tax_identifier` permitted only on organizations, and roles as the single
 * one-directional meeting point — and this service says so in a fourth: the
 * only way to relate the two concepts through this API is
 * {@link CounterpartiesService.declareMirror}, which is deliberately named
 * after what it is rather than reading like an ownership assignment.
 *
 * ## Every list here resolves the pointer or excludes merged rows
 *
 * The design's stated cost of the survivor-pointer merge is that *"every
 * counterparty read path has to resolve the pointer, and a path that forgets to
 * will under-count."* The mitigation is that resolution lives in one place, so
 * this module never writes `coalesce(...)` by hand: it calls
 * `resolvedIdExpression()` and `pickerPredicate()` from `merge.ts`.
 *
 * ## PROVISIONAL
 *
 * Implemented per the Phase 6 design's own recommendations under an owner
 * directive, pending review. The contestable ones this module touches are the
 * declared mirror (open question 12) and the merge posture (open question 3).
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { counterparties } from "@loxep/db/schema";
import { z } from "zod";
import { counterpartyReferenceCode, withCodeRetry } from "./codes.ts";
import {
  CounterpartyBoundaryError,
  CounterpartyConflictError,
  CounterpartyNotFoundError,
  CounterpartyValidationError,
} from "./errors.ts";
import { pickerPredicate, resolvedIdExpression } from "./merge.ts";
import { normalizeName } from "./normalize.ts";
import { textLiteral, toDate, toDateOrNull, uuidLiteral } from "./sql.ts";

export type CounterpartyRow = typeof counterparties.$inferSelect;

type Executor = Pick<LoxepDb, "insert" | "execute" | "query">;

const createSchema = z
  .strictObject({
    kind: z.enum(["person", "organization"]),
    displayName: z.string().trim().min(1),
    legalName: z.string().trim().min(1).nullish(),
    /** Generated as `CP-<year>-NNNN` when omitted. */
    referenceCode: z.string().trim().min(1).optional(),
    status: z.enum(["active", "inactive", "archived"]).default("active"),
    defaultCurrency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code")
      .nullish(),
    taxIdentifierKind: z
      .enum(["vat", "gst", "abn", "ein", "company_number", "other"])
      .nullish(),
    taxIdentifier: z.string().trim().min(1).nullish(),
    notes: z.string().trim().min(1).nullish(),
    mirrorsEconomicEntityId: z.uuid().nullish(),
    createdByUserId: z.string().min(1).nullish(),
    requestId: z.string().min(1).nullish(),
  })
  .refine(
    (input) =>
      (input.taxIdentifier === undefined || input.taxIdentifier === null) ===
      (input.taxIdentifierKind === undefined ||
        input.taxIdentifierKind === null),
    {
      message:
        "taxIdentifier and taxIdentifierKind are recorded together or not at " +
        "all (counterparties_tax_identifier_pair_check)",
      path: ["taxIdentifierKind"],
    },
  );

export type CreateCounterpartyInput = z.input<typeof createSchema>;

const updateSchema = z.strictObject({
  counterpartyId: z.uuid(),
  displayName: z.string().trim().min(1).optional(),
  legalName: z.string().trim().min(1).nullish(),
  status: z.enum(["active", "inactive", "archived"]).optional(),
  defaultCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code")
    .nullish(),
  taxIdentifierKind: z
    .enum(["vat", "gst", "abn", "ein", "company_number", "other"])
    .nullish(),
  taxIdentifier: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish(),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type UpdateCounterpartyInput = z.input<typeof updateSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new CounterpartyValidationError(`invalid counterparty: ${issues}`);
  }
  return parsed.data;
}

export interface CounterpartyListFilter {
  /** Free-text over `normalized_name`; normalized the same way stored names are. */
  search?: string;
  kind?: "person" | "organization";
  statuses?: string[];
  /** Default `false`. Merged rows are never returned unless asked for. */
  includeMerged?: boolean;
  limit?: number;
}

export interface CounterpartiesService {
  create: (input: CreateCounterpartyInput) => Promise<CounterpartyRow>;
  get: (counterpartyId: string) => Promise<CounterpartyRow>;
  /**
   * `get`, but following the survivor pointer first.
   *
   * This is what a read path that holds a possibly-stale id should call. It
   * returns the SURVIVING row, so a caller that merged two customers last week
   * and is now rendering a historical reference sees the row that is current.
   */
  getResolved: (counterpartyId: string) => Promise<CounterpartyRow>;
  getByReferenceCode: (referenceCode: string) => Promise<CounterpartyRow>;
  update: (input: UpdateCounterpartyInput) => Promise<CounterpartyRow>;
  list: (filter?: CounterpartyListFilter) => Promise<CounterpartyRow[]>;
  /**
   * The picker: never a merged row, never an archived one.
   *
   * A separate function rather than a flag on `list`, because "which rows may
   * accumulate NEW references" is a different question from "which rows exist",
   * and a boolean would let a caller get the wrong answer by omission.
   */
  listForPicker: (filter?: {
    search?: string;
    kind?: "person" | "organization";
    limit?: number;
  }) => Promise<CounterpartyRow[]>;
  /**
   * Declare that this outside record mirrors an installation-owned entity.
   *
   * The door in ADR-0017's wall, opened deliberately and audibly. Passing
   * `null` withdraws the declaration.
   */
  declareMirror: (input: {
    counterpartyId: string;
    economicEntityId: string | null;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<CounterpartyRow>;
  /**
   * Every counterparty that declares a mirror.
   *
   * This is the read model the mirror column exists to make possible: revenue
   * and receivables against these parties are intercompany, and a report that
   * cannot name them will quietly overstate both.
   */
  mirrors: () => Promise<
    {
      counterpartyId: string;
      referenceCode: string;
      displayName: string;
      economicEntityId: string;
      economicEntityName: string;
    }[]
  >;
}

export function createCounterpartiesService(options: {
  db: LoxepDb;
}): CounterpartiesService {
  const { db } = options;

  function toRow(row: Record<string, unknown>): CounterpartyRow {
    return {
      id: row["id"] as string,
      referenceCode: row["reference_code"] as string,
      kind: row["kind"] as string,
      displayName: row["display_name"] as string,
      legalName: (row["legal_name"] as string | null) ?? null,
      normalizedName: row["normalized_name"] as string,
      status: row["status"] as string,
      defaultCurrency: (row["default_currency"] as string | null) ?? null,
      taxIdentifierKind: (row["tax_identifier_kind"] as string | null) ?? null,
      taxIdentifier: (row["tax_identifier"] as string | null) ?? null,
      notes: (row["notes"] as string | null) ?? null,
      mirrorsEconomicEntityId:
        (row["mirrors_economic_entity_id"] as string | null) ?? null,
      mergedIntoCounterpartyId:
        (row["merged_into_counterparty_id"] as string | null) ?? null,
      mergedAt: toDateOrNull(row["merged_at"]),
      mergedByUserId: (row["merged_by_user_id"] as string | null) ?? null,
      createdByUserId: (row["created_by_user_id"] as string | null) ?? null,
      createdAt: toDate(row["created_at"]),
      updatedAt: toDate(row["updated_at"]),
    };
  }

  async function load(
    executor: Executor,
    counterpartyId: string,
  ): Promise<CounterpartyRow> {
    const result = await executor.execute(
      `select * from counterparties where id = ${uuidLiteral(counterpartyId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CounterpartyNotFoundError(
        `unknown counterparty "${counterpartyId}"`,
      );
    }
    return toRow(row);
  }

  async function generateReferenceCode(
    executor: Executor,
    year: number,
  ): Promise<string> {
    const result = await executor.execute(
      `select coalesce(max(
                (substring(reference_code from '^CP-[0-9]{4}-([0-9]+)$'))::integer
              ), 0)::text as max_seq
         from counterparties
        where reference_code like ${textLiteral(`CP-${year}-%`)}`,
    );
    const next = Number(result.rows[0]?.["max_seq"] ?? "0") + 1;
    return counterpartyReferenceCode(year, next);
  }

  function listQuery(
    predicates: string[],
    limit: number | undefined,
  ): string {
    const where = predicates.length === 0 ? "" : `where ${predicates.join(" and ")}`;
    const cap =
      limit === undefined ? "" : ` limit ${Math.max(1, Math.trunc(limit))}`;
    return `select c.* from counterparties c ${where}
             order by c.display_name, c.reference_code${cap}`;
  }

  return {
    get: async (counterpartyId) => load(db, counterpartyId),

    getResolved: async (counterpartyId) => {
      const result = await db.execute(
        `select s.* from counterparties c
           join counterparties s on s.id = ${resolvedIdExpression("c")}
          where c.id = ${uuidLiteral(counterpartyId)}`,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new CounterpartyNotFoundError(
          `unknown counterparty "${counterpartyId}"`,
        );
      }
      return toRow(row);
    },

    getByReferenceCode: async (referenceCode) => {
      const result = await db.execute(
        `select * from counterparties
          where reference_code = ${textLiteral(referenceCode)}`,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new CounterpartyNotFoundError(
          `unknown counterparty reference code "${referenceCode}"`,
        );
      }
      return toRow(row);
    },

    create: async (input) => {
      const value = parse(createSchema, input);
      if (
        value.taxIdentifier !== undefined &&
        value.taxIdentifier !== null &&
        value.kind !== "organization"
      ) {
        // The database enforces this too. Raising here converts a constraint
        // name into the reason: a person's tax number is a payroll artefact,
        // and payroll is a permanent non-goal.
        throw new CounterpartyBoundaryError(
          "a tax identifier may be recorded only on an organization " +
            "(counterparties_tax_identifier_org_check). Personal tax " +
            "identifiers are out of scope permanently, not pending a feature.",
        );
      }
      const year = new Date().getUTCFullYear();
      return withCodeRetry(
        async () =>
          db.transaction(async (tx) => {
            const referenceCode =
              value.referenceCode ?? (await generateReferenceCode(tx, year));
            const inserted = await tx
              .insert(counterparties)
              .values({
                referenceCode,
                kind: value.kind,
                displayName: value.displayName,
                legalName: value.legalName ?? null,
                normalizedName: normalizeName(
                  value.legalName ?? value.displayName,
                ),
                status: value.status,
                defaultCurrency:
                  value.defaultCurrency?.toUpperCase() ?? null,
                taxIdentifierKind: value.taxIdentifierKind ?? null,
                taxIdentifier: value.taxIdentifier ?? null,
                notes: value.notes ?? null,
                mirrorsEconomicEntityId: value.mirrorsEconomicEntityId ?? null,
                createdByUserId: value.createdByUserId ?? null,
              })
              .returning();
            const row = inserted[0];
            if (row === undefined) {
              throw new CounterpartyConflictError(
                "counterparties insert returned no row",
              );
            }
            await createAuditService({ db: tx }).append({
              actorUserId: value.createdByUserId ?? null,
              action: "counterparty.created",
              resourceType: "counterparty",
              resourceId: row.id,
              after: {
                referenceCode: row.referenceCode,
                kind: row.kind,
                displayName: row.displayName,
                status: row.status,
                // Recorded because declaring a mirror at creation is the same
                // act as declaring one later, and both must be visible.
                mirrorsEconomicEntityId: row.mirrorsEconomicEntityId,
              },
              requestId: value.requestId ?? null,
              metadata: { normalizedName: row.normalizedName },
            });
            return row;
          }),
        { label: "counterparty reference code" },
      );
    },

    update: async (input) => {
      const value = parse(updateSchema, input);
      return db.transaction(async (tx) => {
        const before = await load(tx, value.counterpartyId);

        const nextTaxIdentifier =
          value.taxIdentifier === undefined
            ? before.taxIdentifier
            : value.taxIdentifier;
        if (nextTaxIdentifier !== null && before.kind !== "organization") {
          throw new CounterpartyBoundaryError(
            "a tax identifier may be recorded only on an organization " +
              "(counterparties_tax_identifier_org_check)",
          );
        }

        const assignments = ["updated_at = now()"];
        if (value.displayName !== undefined) {
          assignments.push(`display_name = ${textLiteral(value.displayName)}`);
        }
        if (value.legalName !== undefined) {
          assignments.push(
            `legal_name = ${value.legalName === null ? "null" : textLiteral(value.legalName)}`,
          );
        }
        // The normalized name follows whichever of the two names is
        // authoritative, recomputed on every write so it can never drift from
        // the name it is derived from.
        if (value.displayName !== undefined || value.legalName !== undefined) {
          const legal =
            value.legalName === undefined ? before.legalName : value.legalName;
          const display = value.displayName ?? before.displayName;
          assignments.push(
            `normalized_name = ${textLiteral(normalizeName(legal ?? display))}`,
          );
        }
        if (value.status !== undefined) {
          assignments.push(`status = ${textLiteral(value.status)}`);
        }
        if (value.defaultCurrency !== undefined) {
          assignments.push(
            `default_currency = ${
              value.defaultCurrency === null
                ? "null"
                : textLiteral(value.defaultCurrency.toUpperCase())
            }`,
          );
        }
        if (value.taxIdentifier !== undefined) {
          assignments.push(
            `tax_identifier = ${value.taxIdentifier === null ? "null" : textLiteral(value.taxIdentifier)}`,
          );
        }
        if (value.taxIdentifierKind !== undefined) {
          assignments.push(
            `tax_identifier_kind = ${value.taxIdentifierKind === null ? "null" : textLiteral(value.taxIdentifierKind)}`,
          );
        }
        if (value.notes !== undefined) {
          assignments.push(
            `notes = ${value.notes === null ? "null" : textLiteral(value.notes)}`,
          );
        }

        await tx.execute(
          `update counterparties set ${assignments.join(", ")}
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await load(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "counterparty.updated",
          resourceType: "counterparty",
          resourceId: before.id,
          before: {
            displayName: before.displayName,
            legalName: before.legalName,
            status: before.status,
            taxIdentifierKind: before.taxIdentifierKind,
          },
          after: {
            displayName: after.displayName,
            legalName: after.legalName,
            status: after.status,
            taxIdentifierKind: after.taxIdentifierKind,
          },
          requestId: value.requestId ?? null,
          metadata: { referenceCode: before.referenceCode },
        });
        return after;
      });
    },

    list: async (filter) => {
      const predicates: string[] = [];
      if (filter?.includeMerged !== true) {
        predicates.push("c.merged_into_counterparty_id is null");
      }
      if (filter?.kind !== undefined) {
        predicates.push(`c.kind = ${textLiteral(filter.kind)}`);
      }
      if (filter?.statuses !== undefined && filter.statuses.length > 0) {
        predicates.push(
          `c.status in (${filter.statuses.map(textLiteral).join(", ")})`,
        );
      }
      if (filter?.search !== undefined && filter.search.trim() !== "") {
        // Normalized on both sides: a search for "Acme Ltd." must find the row
        // stored as `acme ltd`.
        predicates.push(
          `c.normalized_name like ${textLiteral(`%${normalizeName(filter.search)}%`)}`,
        );
      }
      const result = await db.execute(listQuery(predicates, filter?.limit));
      return result.rows.map(toRow);
    },

    listForPicker: async (filter) => {
      const predicates = [pickerPredicate("c")];
      if (filter?.kind !== undefined) {
        predicates.push(`c.kind = ${textLiteral(filter.kind)}`);
      }
      if (filter?.search !== undefined && filter.search.trim() !== "") {
        predicates.push(
          `c.normalized_name like ${textLiteral(`%${normalizeName(filter.search)}%`)}`,
        );
      }
      const result = await db.execute(listQuery(predicates, filter?.limit));
      return result.rows.map(toRow);
    },

    declareMirror: async (input) =>
      db.transaction(async (tx) => {
        const before = await load(tx, input.counterpartyId);
        if (input.economicEntityId !== null) {
          const entity = await tx.execute(
            `select id from economic_entities
              where id = ${uuidLiteral(input.economicEntityId)}`,
          );
          if (entity.rows.length === 0) {
            throw new CounterpartyBoundaryError(
              `cannot mirror unknown economic entity ` +
                `"${input.economicEntityId}"`,
            );
          }
        }
        await tx.execute(
          `update counterparties
              set mirrors_economic_entity_id = ${
                input.economicEntityId === null
                  ? "null"
                  : uuidLiteral(input.economicEntityId)
              },
                  updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await load(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action:
            input.economicEntityId === null
              ? "counterparty.mirror_withdrawn"
              : "counterparty.mirror_declared",
          resourceType: "counterparty",
          resourceId: before.id,
          before: { mirrorsEconomicEntityId: before.mirrorsEconomicEntityId },
          after: { mirrorsEconomicEntityId: after.mirrorsEconomicEntityId },
          requestId: input.requestId ?? null,
          metadata: {
            referenceCode: before.referenceCode,
            // Spelled out in the audit trail because this is the one place the
            // counterparty/entity wall is deliberately crossed.
            note:
              "a declared mirror is an intercompany relationship, not " +
              "ownership: the counterparty remains an outside record",
          },
        });
        return after;
      }),

    mirrors: async () => {
      const result = await db.execute(
        `select c.id::text as id, c.reference_code, c.display_name,
                e.id::text as entity_id, e.name as entity_name
           from counterparties c
           join economic_entities e on e.id = c.mirrors_economic_entity_id
          where c.merged_into_counterparty_id is null
          order by c.display_name`,
      );
      return result.rows.map((row) => ({
        counterpartyId: row["id"] as string,
        referenceCode: row["reference_code"] as string,
        displayName: row["display_name"] as string,
        economicEntityId: row["entity_id"] as string,
        economicEntityName: row["entity_name"] as string,
      }));
    },
  };
}
