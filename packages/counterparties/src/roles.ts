/**
 * Roles: how a counterparty becomes a customer *of one of our entities*.
 *
 * ## Why a relationship row and not a flag
 *
 * ```text
 * (a) A COLUMN ON THE PARTY          (c) A RELATIONSHIP ROW  <- implemented
 * counterparties.kind = 'customer'   counterparty_entity_roles
 * or is_customer / is_vendor           (counterparty, entity, role)
 *
 * one party, one label               one party, many relationships
 * cannot express both at once        terms live on the relationship
 * says nothing about WHICH entity    entity is explicit
 * ```
 *
 * Option (a) fails on the first estate-sale dealer who both sells you pallets
 * and buys a repaired lamp back. It also fails ADR-0017 sideways: a bare
 * `is_customer` says a party is a customer *of the installation*, and an
 * installation is not a party to anything — its entities are.
 *
 * Deriving the role from activity instead (option b) fails for two specific
 * reasons: a customer exists before their first transaction (you take a
 * deposit, set net-30, agree a rate — all before an invoice exists), and a
 * vendor relationship may generate no Loxep-owned document at all, because
 * Phase 4 deliberately keeps `acquisitions.vendor_name` as text.
 *
 * ## The nullable entity, and the unique that makes it safe
 *
 * `economic_entity_id` is nullable and reads as *"this relationship holds for
 * the installation generally"* — the same reading `orders.economic_entity_id is
 * null` already has. It exists because an operator who has attributed nothing
 * yet still has customers, which is the dominant early state under Phase 3's
 * `unattributed` ladder.
 *
 * `unique nulls not distinct (counterparty_id, economic_entity_id, role)` makes
 * the null a real value for uniqueness, so a party cannot hold two
 * installation-wide `customer` rows. Without `NULLS NOT DISTINCT` that
 * constraint would be silently inert for exactly the rows it most needs to
 * govern — which is why the test for it asserts the null case specifically.
 *
 * ## Terms live on the relationship
 *
 * Net-30 with the LLC and cash on delivery with the personal side is a real
 * arrangement, and `payment_terms_days` on `counterparties` would force one of
 * them to be wrong. Same reasoning that put `dimension_label` on
 * `book_entity_links` rather than renaming the entity.
 *
 * ## Not effective-dated, on purpose
 *
 * `since_on`/`until_on` are descriptive and there is no exclusion constraint,
 * because nothing ROUTES on a role the way postings route on a book link. A
 * lapsed customer relationship does not make historical invoices
 * unexplainable; the invoice carries its own counterparty and entity.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { counterpartyEntityRoles } from "@loxep/db/schema";
import type { CounterpartyRole } from "@loxep/db/schema";
import { z } from "zod";
import {
  CounterpartyNotFoundError,
  CounterpartyValidationError,
} from "./errors.ts";
import { pickerPredicate } from "./merge.ts";
import { dateLiteral, textLiteral, toDate, uuidLiteral } from "./sql.ts";

export type CounterpartyRoleRow = typeof counterpartyEntityRoles.$inferSelect;

const ROLES = [
  "customer",
  "vendor",
  "payer",
  "payee",
  "consignor",
  "subcontractor",
  "partner",
  "other",
] as const satisfies readonly CounterpartyRole[];

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a calendar date as YYYY-MM-DD");

const grantSchema = z
  .strictObject({
    counterpartyId: z.uuid(),
    /** `null` (or omitted) means the relationship holds installation-wide. */
    economicEntityId: z.uuid().nullish(),
    role: z.enum(ROLES),
    status: z.enum(["active", "inactive"]).default("active"),
    sinceOn: calendarDate.nullish(),
    untilOn: calendarDate.nullish(),
    paymentTermsDays: z.number().int().min(0).nullish(),
    defaultCurrency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code")
      .nullish(),
    /** Open set: recorded, never calculated. */
    taxTreatment: z.string().trim().min(1).nullish(),
    billingContactId: z.uuid().nullish(),
    note: z.string().trim().min(1).nullish(),
    createdByUserId: z.string().min(1).nullish(),
    requestId: z.string().min(1).nullish(),
  })
  .refine(
    (input) =>
      input.untilOn === undefined ||
      input.untilOn === null ||
      input.sinceOn === undefined ||
      input.sinceOn === null ||
      input.untilOn >= input.sinceOn,
    {
      message:
        "untilOn must not precede sinceOn (counterparty_entity_roles_dates_check)",
      path: ["untilOn"],
    },
  );

export type GrantRoleInput = z.input<typeof grantSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new CounterpartyValidationError(`invalid role: ${issues}`);
  }
  return parsed.data;
}

export interface RolesService {
  /**
   * Grant a role, or update the terms of one that already exists.
   *
   * Upsert rather than insert, keyed on the same triple the unique governs, so
   * "make them a customer of the LLC on net-30" is idempotent — the at-least-
   * once rule applied to an operator action rather than a job.
   */
  grant: (input: GrantRoleInput) => Promise<CounterpartyRoleRow>;
  revoke: (input: {
    roleId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<CounterpartyRoleRow>;
  remove: (input: {
    roleId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<void>;
  listForCounterparty: (
    counterpartyId: string,
  ) => Promise<CounterpartyRoleRow[]>;
  /**
   * Parties holding `role` with respect to `economicEntityId`.
   *
   * `economicEntityId: null` asks for installation-wide relationships only.
   * Merged and archived counterparties are excluded, because this is a picker
   * in every use it has ("who can I invoice as the LLC?").
   */
  listByEntityRole: (input: {
    role: CounterpartyRole;
    economicEntityId?: string | null;
    /** Include installation-wide rows alongside the entity's own. Default true. */
    includeInstallationWide?: boolean;
    statuses?: string[];
  }) => Promise<
    {
      roleId: string;
      counterpartyId: string;
      referenceCode: string;
      displayName: string;
      economicEntityId: string | null;
      role: string;
      status: string;
      paymentTermsDays: number | null;
      defaultCurrency: string | null;
      taxTreatment: string | null;
    }[]
  >;
}

export function createRolesService(options: { db: LoxepDb }): RolesService {
  const { db } = options;

  function toRow(row: Record<string, unknown>): CounterpartyRoleRow {
    return {
      id: row["id"] as string,
      counterpartyId: row["counterparty_id"] as string,
      economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
      role: row["role"] as string,
      status: row["status"] as string,
      sinceOn: (row["since_on"] as string | null) ?? null,
      untilOn: (row["until_on"] as string | null) ?? null,
      paymentTermsDays: (row["payment_terms_days"] as number | null) ?? null,
      defaultCurrency: (row["default_currency"] as string | null) ?? null,
      taxTreatment: (row["tax_treatment"] as string | null) ?? null,
      billingContactId: (row["billing_contact_id"] as string | null) ?? null,
      note: (row["note"] as string | null) ?? null,
      createdByUserId: (row["created_by_user_id"] as string | null) ?? null,
      createdAt: toDate(row["created_at"]),
      updatedAt: toDate(row["updated_at"]),
    };
  }

  async function loadRole(
    executor: Pick<LoxepDb, "execute">,
    roleId: string,
  ): Promise<CounterpartyRoleRow> {
    const result = await executor.execute(
      `select * from counterparty_entity_roles where id = ${uuidLiteral(roleId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CounterpartyNotFoundError(`unknown role "${roleId}"`);
    }
    return toRow(row);
  }

  return {
    grant: async (input) => {
      const value = parse(grantSchema, input);
      const entityId = value.economicEntityId ?? null;
      return db.transaction(async (tx) => {
        // `is not distinct from` is the query-side counterpart of the
        // constraint's NULLS NOT DISTINCT: a plain `=` would never match the
        // installation-wide row and this upsert would insert a duplicate that
        // the unique then rejects.
        const existing = await tx.execute(
          `select id::text as id from counterparty_entity_roles
            where counterparty_id = ${uuidLiteral(value.counterpartyId)}
              and economic_entity_id is not distinct from ${
                entityId === null ? "null" : uuidLiteral(entityId)
              }
              and role = ${textLiteral(value.role)}`,
        );
        const existingId = existing.rows[0]?.["id"] as string | undefined;

        const assignments = [
          `status = ${textLiteral(value.status)}`,
          "updated_at = now()",
        ];
        if (value.sinceOn !== undefined) {
          assignments.push(
            `since_on = ${value.sinceOn === null ? "null" : dateLiteral(value.sinceOn)}`,
          );
        }
        if (value.untilOn !== undefined) {
          assignments.push(
            `until_on = ${value.untilOn === null ? "null" : dateLiteral(value.untilOn)}`,
          );
        }
        if (value.paymentTermsDays !== undefined) {
          assignments.push(
            `payment_terms_days = ${value.paymentTermsDays === null ? "null" : Math.trunc(value.paymentTermsDays)}`,
          );
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
        if (value.taxTreatment !== undefined) {
          assignments.push(
            `tax_treatment = ${value.taxTreatment === null ? "null" : textLiteral(value.taxTreatment)}`,
          );
        }
        if (value.billingContactId !== undefined) {
          assignments.push(
            `billing_contact_id = ${value.billingContactId === null ? "null" : uuidLiteral(value.billingContactId)}`,
          );
        }
        if (value.note !== undefined) {
          assignments.push(
            `note = ${value.note === null ? "null" : textLiteral(value.note)}`,
          );
        }

        let row: CounterpartyRoleRow;
        let before: CounterpartyRoleRow | null = null;
        if (existingId === undefined) {
          const inserted = await tx
            .insert(counterpartyEntityRoles)
            .values({
              counterpartyId: value.counterpartyId,
              economicEntityId: entityId,
              role: value.role,
              status: value.status,
              sinceOn: value.sinceOn ?? null,
              untilOn: value.untilOn ?? null,
              paymentTermsDays: value.paymentTermsDays ?? null,
              defaultCurrency: value.defaultCurrency?.toUpperCase() ?? null,
              taxTreatment: value.taxTreatment ?? null,
              billingContactId: value.billingContactId ?? null,
              note: value.note ?? null,
              createdByUserId: value.createdByUserId ?? null,
            })
            .returning();
          const created = inserted[0];
          if (created === undefined) {
            throw new CounterpartyValidationError(
              "counterparty_entity_roles insert returned no row",
            );
          }
          row = created;
        } else {
          before = await loadRole(tx, existingId);
          await tx.execute(
            `update counterparty_entity_roles set ${assignments.join(", ")}
              where id = ${uuidLiteral(existingId)}`,
          );
          row = await loadRole(tx, existingId);
        }

        await createAuditService({ db: tx }).append({
          actorUserId: value.createdByUserId ?? null,
          action:
            before === null
              ? "counterparty.role_granted"
              : "counterparty.role_updated",
          resourceType: "counterparty",
          resourceId: value.counterpartyId,
          before:
            before === null
              ? undefined
              : {
                  role: before.role,
                  economicEntityId: before.economicEntityId,
                  status: before.status,
                  paymentTermsDays: before.paymentTermsDays,
                },
          after: {
            roleId: row.id,
            role: row.role,
            economicEntityId: row.economicEntityId,
            status: row.status,
            paymentTermsDays: row.paymentTermsDays,
          },
          requestId: value.requestId ?? null,
        });
        return row;
      });
    },

    revoke: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadRole(tx, input.roleId);
        await tx.execute(
          `update counterparty_entity_roles
              set status = 'inactive', updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadRole(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.role_revoked",
          resourceType: "counterparty",
          resourceId: before.counterpartyId,
          before: { status: before.status },
          after: { status: after.status },
          requestId: input.requestId ?? null,
          metadata: { roleId: before.id, role: before.role },
        });
        return after;
      }),

    remove: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadRole(tx, input.roleId);
        await tx.execute(
          `delete from counterparty_entity_roles where id = ${uuidLiteral(before.id)}`,
        );
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.role_removed",
          resourceType: "counterparty",
          resourceId: before.counterpartyId,
          before: {
            roleId: before.id,
            role: before.role,
            economicEntityId: before.economicEntityId,
          },
          requestId: input.requestId ?? null,
        });
      }),

    listForCounterparty: async (counterpartyId) => {
      const result = await db.execute(
        `select * from counterparty_entity_roles
          where counterparty_id = ${uuidLiteral(counterpartyId)}
          order by role, economic_entity_id nulls first`,
      );
      return result.rows.map(toRow);
    },

    listByEntityRole: async (input) => {
      const includeWide = input.includeInstallationWide !== false;
      const entityPredicate =
        input.economicEntityId === undefined || input.economicEntityId === null
          ? "r.economic_entity_id is null"
          : includeWide
            ? `(r.economic_entity_id = ${uuidLiteral(input.economicEntityId)} or r.economic_entity_id is null)`
            : `r.economic_entity_id = ${uuidLiteral(input.economicEntityId)}`;
      const statuses =
        input.statuses === undefined || input.statuses.length === 0
          ? ["active"]
          : input.statuses;
      const result = await db.execute(
        `select r.id::text as role_id, c.id::text as counterparty_id,
                c.reference_code, c.display_name,
                r.economic_entity_id::text as economic_entity_id,
                r.role, r.status, r.payment_terms_days, r.default_currency,
                r.tax_treatment
           from counterparty_entity_roles r
           join counterparties c on c.id = r.counterparty_id
          where r.role = ${textLiteral(input.role)}
            and ${entityPredicate}
            and r.status in (${statuses.map(textLiteral).join(", ")})
            and ${pickerPredicate("c")}
          order by c.display_name`,
      );
      return result.rows.map((row) => ({
        roleId: row["role_id"] as string,
        counterpartyId: row["counterparty_id"] as string,
        referenceCode: row["reference_code"] as string,
        displayName: row["display_name"] as string,
        economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
        role: row["role"] as string,
        status: row["status"] as string,
        paymentTermsDays: (row["payment_terms_days"] as number | null) ?? null,
        defaultCurrency: (row["default_currency"] as string | null) ?? null,
        taxTreatment: (row["tax_treatment"] as string | null) ?? null,
      }));
    },
  };
}
