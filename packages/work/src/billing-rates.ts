/**
 * The rate CARD itself: create, end-date, and list `billing_rates` rows.
 *
 * `rates.ts` is the READ side — the resolution ladder a time entry consults.
 * This module is the WRITE side: without it nothing could ever populate the
 * table the ladder reads, so "billing-rate resolution... per the design's
 * precedence" (the task this package exists to close) is unusable without a
 * way to define the rates in the first place.
 *
 * No pricing engine, no formulas, no volume tiers, no currency conversion —
 * per the design's "A rate card is not a pricing engine": this is CRUD over
 * one flat table with the scope-consistency checks the schema already
 * enforces, restated here for a friendlier error than a bare constraint name.
 *
 * Rates are never deleted in normal operation (history — a past time entry's
 * `bill_rate_source`/`billing_rate_id` may still point at one) and there is
 * deliberately no `update` of `amount`/`scope`/`effective_from`: correcting a
 * live rate is `endDate` the old row and `create` a new one, which is exactly
 * the effective-dated-row model the design specifies.
 */
import type { LoxepDb } from "@loxep/db";
import { billingRates } from "@loxep/db/schema";
import { z } from "zod";
import { WorkNotFoundError, WorkValidationError } from "./errors.ts";
import { dateLiteral, toDate, uuidLiteral } from "./sql.ts";

export type BillingRateRow = typeof billingRates.$inferSelect;

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const currencyCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const SCOPE_KINDS = [
  "project_person",
  "project",
  "counterparty",
  "person",
  "activity",
  "installation",
] as const;
const RATE_KINDS = ["bill", "cost"] as const;
const UNITS = ["hour", "day", "fixed"] as const;

const createSchema = z
  .strictObject({
    scopeKind: z.enum(SCOPE_KINDS),
    projectId: z.uuid().nullish(),
    counterpartyId: z.uuid().nullish(),
    subjectUserId: z.string().min(1).nullish(),
    subjectCounterpartyId: z.uuid().nullish(),
    activityCode: z.string().trim().min(1).nullish(),
    economicEntityId: z.uuid().nullish(),
    rateKind: z.enum(RATE_KINDS),
    currency: currencyCode,
    amount: decimalString.refine((v) => Number(v) >= 0, {
      message: "amount must be >= 0 (billing_rates_amount_check)",
    }),
    unit: z.enum(UNITS).default("hour"),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullish(),
    note: z.string().trim().min(1).nullish(),
    createdByUserId: z.string().min(1).nullish(),
  })
  .refine(
    (input) =>
      (input.scopeKind === "project_person" || input.scopeKind === "project") ===
      (input.projectId != null),
    {
      message:
        "projectId is required for, and only for, scopeKind 'project_person'/'project' " +
        "(billing_rates_project_scope_check)",
      path: ["projectId"],
    },
  )
  .refine((input) => (input.scopeKind === "counterparty") === (input.counterpartyId != null), {
    message:
      "counterpartyId is required for, and only for, scopeKind 'counterparty' " +
      "(billing_rates_counterparty_scope_check)",
    path: ["counterpartyId"],
  })
  .refine(
    (input) => {
      const hasSubject =
        (input.subjectUserId != null ? 1 : 0) + (input.subjectCounterpartyId != null ? 1 : 0);
      const needsSubject = input.scopeKind === "project_person" || input.scopeKind === "person";
      return needsSubject ? hasSubject === 1 : hasSubject === 0;
    },
    {
      message:
        "exactly one of subjectUserId/subjectCounterpartyId is required for scopeKind " +
        "'project_person'/'person', and neither may be set otherwise " +
        "(billing_rates_subject_scope_check)",
      path: ["subjectUserId"],
    },
  )
  .refine((input) => (input.scopeKind === "activity") === (input.activityCode != null), {
    message:
      "activityCode is required for, and only for, scopeKind 'activity' " +
      "(billing_rates_activity_scope_check)",
    path: ["activityCode"],
  })
  .refine(
    (input) => input.effectiveTo == null || input.effectiveTo >= input.effectiveFrom,
    {
      message: "effectiveTo must not precede effectiveFrom (billing_rates_effective_range_check)",
      path: ["effectiveTo"],
    },
  );

export type CreateBillingRateInput = z.input<typeof createSchema>;

export interface BillingRateListFilter {
  scopeKind?: (typeof SCOPE_KINDS)[number];
  rateKind?: (typeof RATE_KINDS)[number];
  projectId?: string;
  counterpartyId?: string;
  limit?: number;
}

export interface BillingRatesService {
  create: (input: CreateBillingRateInput) => Promise<BillingRateRow>;
  get: (billingRateId: string) => Promise<BillingRateRow>;
  /** Sets `effective_to`, closing the rate out without deleting it (history may still reference it). */
  endDate: (input: { billingRateId: string; effectiveTo: string }) => Promise<BillingRateRow>;
  list: (filter?: BillingRateListFilter) => Promise<BillingRateRow[]>;
}

export function createBillingRatesService(options: { db: LoxepDb }): BillingRatesService {
  const { db } = options;

  function toRow(row: Record<string, unknown>): BillingRateRow {
    return {
      id: row["id"] as string,
      scopeKind: row["scope_kind"] as string,
      projectId: (row["project_id"] as string | null) ?? null,
      counterpartyId: (row["counterparty_id"] as string | null) ?? null,
      subjectUserId: (row["subject_user_id"] as string | null) ?? null,
      subjectCounterpartyId: (row["subject_counterparty_id"] as string | null) ?? null,
      activityCode: (row["activity_code"] as string | null) ?? null,
      economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
      rateKind: row["rate_kind"] as string,
      currency: row["currency"] as string,
      amount: row["amount"] as string,
      unit: row["unit"] as string,
      effectiveFrom: row["effective_from"] as string,
      effectiveTo: (row["effective_to"] as string | null) ?? null,
      note: (row["note"] as string | null) ?? null,
      createdByUserId: (row["created_by_user_id"] as string | null) ?? null,
      createdAt: toDate(row["created_at"]),
      updatedAt: toDate(row["updated_at"]),
    };
  }

  async function load(
    executor: Pick<LoxepDb, "execute">,
    billingRateId: string,
  ): Promise<BillingRateRow> {
    const result = await executor.execute(
      `select * from billing_rates where id = ${uuidLiteral(billingRateId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WorkNotFoundError(`unknown billing rate "${billingRateId}"`);
    }
    return toRow(row);
  }

  return {
    get: async (billingRateId) => load(db, billingRateId),

    create: async (input) => {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new WorkValidationError(`invalid billing rate: ${issues}`);
      }
      const value = parsed.data;
      const inserted = await db
        .insert(billingRates)
        .values({
          scopeKind: value.scopeKind,
          projectId: value.projectId ?? null,
          counterpartyId: value.counterpartyId ?? null,
          subjectUserId: value.subjectUserId ?? null,
          subjectCounterpartyId: value.subjectCounterpartyId ?? null,
          activityCode: value.activityCode ?? null,
          economicEntityId: value.economicEntityId ?? null,
          rateKind: value.rateKind,
          currency: value.currency.toUpperCase(),
          amount: value.amount,
          unit: value.unit,
          effectiveFrom: value.effectiveFrom,
          effectiveTo: value.effectiveTo ?? null,
          note: value.note ?? null,
          createdByUserId: value.createdByUserId ?? null,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new WorkValidationError("billing_rates insert returned no row");
      }
      return row;
    },

    endDate: async (input) => {
      const billingRateId = z.uuid().parse(input.billingRateId);
      const effectiveTo = isoDate.parse(input.effectiveTo);
      return db.transaction(async (tx) => {
        const before = await load(tx, billingRateId);
        if (effectiveTo < before.effectiveFrom) {
          throw new WorkValidationError(
            "effectiveTo must not precede effectiveFrom (billing_rates_effective_range_check)",
          );
        }
        await tx.execute(
          `update billing_rates set effective_to = ${dateLiteral(effectiveTo)}, updated_at = now()
            where id = ${uuidLiteral(billingRateId)}`,
        );
        return load(tx, billingRateId);
      });
    },

    list: async (filter) => {
      const predicates: string[] = [];
      if (filter?.scopeKind !== undefined) predicates.push(`scope_kind = '${filter.scopeKind}'`);
      if (filter?.rateKind !== undefined) predicates.push(`rate_kind = '${filter.rateKind}'`);
      if (filter?.projectId !== undefined) {
        predicates.push(`project_id = ${uuidLiteral(filter.projectId)}`);
      }
      if (filter?.counterpartyId !== undefined) {
        predicates.push(`counterparty_id = ${uuidLiteral(filter.counterpartyId)}`);
      }
      const where = predicates.length === 0 ? "" : `where ${predicates.join(" and ")}`;
      const limit =
        filter?.limit === undefined ? "" : ` limit ${Math.max(1, Math.trunc(filter.limit))}`;
      const result = await db.execute(
        `select * from billing_rates ${where} order by scope_kind, effective_from desc${limit}`,
      );
      return result.rows.map(toRow);
    },
  };
}
