/**
 * Time-entry recording against a project, with rate resolution — migration
 * 0011's `time_entries` table, physical schema only until this slice
 * (`bd show loxep-nw0`). See `rates.ts` for the resolution ladder itself.
 *
 * ## `minutes` is the authority
 *
 * `minutes` is required and is what everything computes from; `startedAt`/
 * `endedAt` are optional, all-or-nothing evidence for timer-driven entry, per
 * the design's "Duration: minutes are the authority, instants are optional
 * evidence". Nothing here derives `minutes` from the instant pair.
 *
 * ## Rate resolution happens ONCE, at record time, and is FROZEN
 *
 * `recordTimeEntry` resolves both `rate_kind = 'bill'` and `rate_kind =
 * 'cost'` through the ladder in `rates.ts` and stores the result on the row.
 * Nothing in this module re-resolves an existing entry's rate as a side
 * effect of an unrelated edit — {@link TimeService.update} never touches the
 * rate columns, exactly because "raising the shop rate in July must not
 * rewrite what June's hours were worth." {@link TimeService.reresolveRates}
 * is the sole, deliberate, explicit exception (a backfill/admin action).
 *
 * ## One `billing_rate_id` column, two resolutions
 *
 * `time_entries.billing_rate_id` is a single nullable FK, but the design
 * resolves BILL and COST rates independently ("Cost rates are the same table
 * with `rate_kind = 'cost'`... resolve through the identical ladder against
 * separate rows"). The schema does not say which resolution the one column
 * points at. This module's reading: `billing_rate_id` records the BILL
 * resolution's `billing_rates.id` (the column's name says "billing", not
 * "costing"); the cost resolution's source rung is fully recorded in
 * `cost_rate_source` even though its own `billing_rates` row id is not
 * separately stored. Worth a reviewer's attention if a use for the cost
 * rate's row id ever surfaces.
 *
 * ## Currency: one column for two rates
 *
 * `currency` is a single column shared by `bill_rate_amount` and
 * `cost_rate_amount`. If both the bill and cost ladders resolve to rates
 * priced in different currencies, there is no column to hold both truths;
 * this module treats that as a validation failure ("bill/cost rate currency
 * mismatch") rather than silently picking one and losing the other. In
 * practice a single installation's rate card is one currency, so this should
 * never fire outside a misconfigured multi-currency rate card — see the
 * currency-mismatch test in `test/time.test.ts`.
 */
import type { LoxepDb } from "@loxep/db";
import { timeEntries } from "@loxep/db/schema";
import { z } from "zod";
import { divideByInteger, multiplyDecimals } from "./decimal.ts";
import { WorkBoundaryError, WorkNotFoundError, WorkValidationError } from "./errors.ts";
import { resolveRate } from "./rates.ts";
import type { RateResolutionResult } from "./rates.ts";

/** Either a `resolveRate` result or a manual override normalized to the same shape. */
type RateOutcome = RateResolutionResult;
import {
  dateLiteral,
  decimalLiteral,
  nullable,
  textLiteral,
  toDate,
  toDateOrNull,
  uuidLiteral,
} from "./sql.ts";

export type TimeEntryRow = typeof timeEntries.$inferSelect;

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const currencyCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const recordSchema = z
  .strictObject({
    projectId: z.uuid().nullish(),
    counterpartyId: z.uuid().nullish(),
    economicEntityId: z.uuid().nullish(),
    workedByUserId: z.string().min(1).nullish(),
    workedByCounterpartyId: z.uuid().nullish(),
    workedByLabel: z.string().trim().min(1),
    activityCode: z.string().trim().min(1).nullish(),
    description: z.string().trim().min(1).nullish(),
    workedOn: isoDate,
    startedAt: z.date().nullish(),
    endedAt: z.date().nullish(),
    minutes: z.number().int().positive(),
    billable: z.boolean().default(true),
    /** Defaults to `minutes` when billable, `0` otherwise. See the module doc. */
    billableMinutes: z.number().int().nonnegative().optional(),
    /** Manual override for the bill rate. Requires `currency`. */
    billRateAmount: decimalString.nullish(),
    /** Manual override for the cost rate. Requires `currency`. */
    costRateAmount: decimalString.nullish(),
    /** Required if either manual rate is given; otherwise taken from whichever ladder rung resolves. */
    currency: currencyCode.nullish(),
    createdByUserId: z.string().min(1).nullish(),
  })
  .refine((input) => (input.startedAt == null) === (input.endedAt == null), {
    message: "startedAt and endedAt are recorded together or not at all (time_entries_instant_pair_check)",
    path: ["endedAt"],
  })
  .refine(
    (input) =>
      input.startedAt == null || input.endedAt == null || input.endedAt >= input.startedAt,
    {
      message: "endedAt must not precede startedAt (time_entries_instant_order_check)",
      path: ["endedAt"],
    },
  )
  .refine(
    (input) => input.workedByUserId == null || input.workedByCounterpartyId == null,
    {
      message:
        "workedByUserId and workedByCounterpartyId are mutually exclusive " +
        "(time_entries_worked_by_exclusive_check)",
      path: ["workedByCounterpartyId"],
    },
  )
  .refine(
    (input) =>
      !input.billable || input.projectId != null || input.counterpartyId != null,
    {
      message:
        "a billable entry needs a project or a counterparty " +
        "(time_entries_billable_target_check)",
      path: ["billable"],
    },
  )
  .refine(
    (input) =>
      input.billableMinutes === undefined ||
      input.billable ||
      input.billableMinutes === 0,
    {
      message:
        "billableMinutes must be 0 when billable is false " +
        "(time_entries_billable_zero_check)",
      path: ["billableMinutes"],
    },
  )
  .refine(
    (input) =>
      (input.billRateAmount == null && input.costRateAmount == null) ||
      input.currency != null,
    {
      message: "currency is required when a manual rate is given",
      path: ["currency"],
    },
  );

export type RecordTimeEntryInput = z.input<typeof recordSchema>;

const updateSchema = z.strictObject({
  timeEntryId: z.uuid(),
  description: z.string().trim().min(1).nullish(),
  activityCode: z.string().trim().min(1).nullish(),
  minutes: z.number().int().positive().optional(),
  billable: z.boolean().optional(),
  billableMinutes: z.number().int().nonnegative().optional(),
  startedAt: z.date().nullish(),
  endedAt: z.date().nullish(),
});

export type UpdateTimeEntryInput = z.input<typeof updateSchema>;

export interface TimeEntryListFilter {
  billableOnly?: boolean;
  unlockedOnly?: boolean;
  fromWorkedOn?: string;
  toWorkedOn?: string;
  limit?: number;
}

export interface TimeService {
  record: (input: RecordTimeEntryInput) => Promise<TimeEntryRow>;
  get: (timeEntryId: string) => Promise<TimeEntryRow>;
  update: (input: UpdateTimeEntryInput) => Promise<TimeEntryRow>;
  approve: (input: {
    timeEntryId: string;
    approvedByUserId: string;
  }) => Promise<TimeEntryRow>;
  /**
   * Explicitly re-runs the rate-resolution ladder against the entry's own
   * `worked_on` date using whatever `billing_rates` exist NOW, and overwrites
   * the frozen rate columns. A deliberate backfill/admin action — never called
   * automatically. Refused on a locked entry.
   */
  reresolveRates: (timeEntryId: string) => Promise<TimeEntryRow>;
  listForProject: (
    projectId: string,
    filter?: TimeEntryListFilter,
  ) => Promise<TimeEntryRow[]>;
  listForWorker: (
    workedByUserId: string,
    filter?: TimeEntryListFilter,
  ) => Promise<TimeEntryRow[]>;
}

/**
 * The billable value of an entry: `billable_minutes / 60 * bill_rate_amount`,
 * exact decimal-string arithmetic. `null` when there is nothing to compute
 * from (not billable, zero billable minutes, or an unresolved bill rate) —
 * never a silent zero, per the design's "unrated billable work" posture.
 */
export function timeEntryBillableAmount(row: TimeEntryRow): string | null {
  if (!row.billable || row.billableMinutes <= 0 || row.billRateAmount === null) {
    return null;
  }
  const scaled = multiplyDecimals(String(row.billableMinutes), row.billRateAmount, 6);
  return divideByInteger(scaled.value, 60).value;
}

/** The costed value of an entry: `minutes / 60 * cost_rate_amount`. `null` when the cost rate is unresolved. */
export function timeEntryCostAmount(row: TimeEntryRow): string | null {
  if (row.costRateAmount === null) return null;
  const scaled = multiplyDecimals(String(row.minutes), row.costRateAmount, 6);
  return divideByInteger(scaled.value, 60).value;
}

/**
 * Maps a raw `db.execute` row from `time_entries` to a {@link TimeEntryRow}.
 * Exported (not just an internal closure) so `unbilled.ts` reads this table
 * through the identical mapping rather than a second, driftable copy.
 */
export function mapTimeEntryRow(row: Record<string, unknown>): TimeEntryRow {
  return {
    id: row["id"] as string,
    projectId: (row["project_id"] as string | null) ?? null,
    counterpartyId: (row["counterparty_id"] as string | null) ?? null,
    economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
    workedByUserId: (row["worked_by_user_id"] as string | null) ?? null,
    workedByCounterpartyId:
      (row["worked_by_counterparty_id"] as string | null) ?? null,
    workedByLabel: row["worked_by_label"] as string,
    activityCode: (row["activity_code"] as string | null) ?? null,
    description: (row["description"] as string | null) ?? null,
    workedOn: row["worked_on"] as string,
    startedAt: toDateOrNull(row["started_at"]),
    endedAt: toDateOrNull(row["ended_at"]),
    minutes: Number(row["minutes"]),
    billable: row["billable"] as boolean,
    billableMinutes: Number(row["billable_minutes"]),
    currency: (row["currency"] as string | null) ?? null,
    billRateAmount: (row["bill_rate_amount"] as string | null) ?? null,
    billRateSource: row["bill_rate_source"] as string,
    costRateAmount: (row["cost_rate_amount"] as string | null) ?? null,
    costRateSource: row["cost_rate_source"] as string,
    billingRateId: (row["billing_rate_id"] as string | null) ?? null,
    approvedAt: toDateOrNull(row["approved_at"]),
    approvedByUserId: (row["approved_by_user_id"] as string | null) ?? null,
    lockedAt: toDateOrNull(row["locked_at"]),
    createdByUserId: (row["created_by_user_id"] as string | null) ?? null,
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
  };
}

export function createTimeService(options: { db: LoxepDb }): TimeService {
  const { db } = options;
  const toRow = mapTimeEntryRow;

  async function load(
    executor: Pick<LoxepDb, "execute">,
    timeEntryId: string,
  ): Promise<TimeEntryRow> {
    const result = await executor.execute(
      `select * from time_entries where id = ${uuidLiteral(timeEntryId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WorkNotFoundError(`unknown time entry "${timeEntryId}"`);
    }
    return toRow(row);
  }

  async function loadProjectDefaults(
    executor: Pick<LoxepDb, "execute">,
    projectId: string,
  ): Promise<{ counterpartyId: string | null; economicEntityId: string | null }> {
    const result = await executor.execute(
      `select counterparty_id, economic_entity_id from projects
        where id = ${uuidLiteral(projectId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WorkNotFoundError(`unknown project "${projectId}"`);
    }
    return {
      counterpartyId: (row["counterparty_id"] as string | null) ?? null,
      economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
    };
  }

  return {
    get: async (timeEntryId) => load(db, timeEntryId),

    record: async (input) => {
      const parsed = recordSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new WorkValidationError(`invalid time entry: ${issues}`);
      }
      const value = parsed.data;

      return db.transaction(async (tx) => {
        // Convenience: a project-scoped entry with no explicit client
        // inherits the project's own attribution, so `counterparty`-scope
        // rate rows and the project timesheet still resolve without the
        // caller repeating what the project already knows.
        let counterpartyId = value.counterpartyId ?? null;
        let economicEntityId = value.economicEntityId ?? null;
        if (value.projectId != null && counterpartyId === null) {
          const defaults = await loadProjectDefaults(tx, value.projectId);
          counterpartyId = defaults.counterpartyId;
          if (economicEntityId === null) economicEntityId = defaults.economicEntityId;
        }

        const billableMinutes =
          value.billableMinutes ?? (value.billable ? value.minutes : 0);

        const ladderInput = {
          projectId: value.projectId ?? null,
          counterpartyId,
          workedByUserId: value.workedByUserId ?? null,
          workedByCounterpartyId: value.workedByCounterpartyId ?? null,
          activityCode: value.activityCode ?? null,
          workedOn: value.workedOn,
        };

        const bill: RateOutcome =
          value.billRateAmount != null
            ? {
                amount: value.billRateAmount,
                currency: value.currency ?? null,
                source: "manual",
                billingRateId: null,
              }
            : await resolveRate(tx, { ...ladderInput, rateKind: "bill" });
        const cost: RateOutcome =
          value.costRateAmount != null
            ? {
                amount: value.costRateAmount,
                currency: value.currency ?? null,
                source: "manual",
                billingRateId: null,
              }
            : await resolveRate(tx, { ...ladderInput, rateKind: "cost" });

        if (bill.currency !== null && cost.currency !== null && bill.currency !== cost.currency) {
          throw new WorkValidationError(
            `bill/cost rate currency mismatch: bill resolved in ` +
              `"${bill.currency}", cost resolved in "${cost.currency}" — one ` +
              `time_entries.currency column cannot hold both`,
          );
        }
        const currency = bill.currency ?? cost.currency ?? null;
        if ((bill.amount !== null || cost.amount !== null) && currency === null) {
          throw new WorkValidationError("currency could not be determined for a resolved rate");
        }

        const inserted = await tx
          .insert(timeEntries)
          .values({
            projectId: value.projectId ?? null,
            counterpartyId,
            economicEntityId,
            workedByUserId: value.workedByUserId ?? null,
            workedByCounterpartyId: value.workedByCounterpartyId ?? null,
            workedByLabel: value.workedByLabel,
            activityCode: value.activityCode ?? null,
            description: value.description ?? null,
            workedOn: value.workedOn,
            startedAt: value.startedAt ?? null,
            endedAt: value.endedAt ?? null,
            minutes: value.minutes,
            billable: value.billable,
            billableMinutes,
            currency,
            billRateAmount: bill.amount,
            billRateSource: bill.source,
            costRateAmount: cost.amount,
            costRateSource: cost.source,
            billingRateId: bill.billingRateId,
            createdByUserId: value.createdByUserId ?? null,
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new WorkValidationError("time_entries insert returned no row");
        }
        return row;
      });
    },

    update: async (input) => {
      const parsed = updateSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new WorkValidationError(`invalid time entry update: ${issues}`);
      }
      const value = parsed.data;

      return db.transaction(async (tx) => {
        const before = await load(tx, value.timeEntryId);
        if (before.lockedAt !== null) {
          throw new WorkBoundaryError(
            `time entry "${before.id}" is locked (attached to an issued invoice ` +
              "line) and cannot be edited",
          );
        }

        const nextBillable = value.billable ?? before.billable;
        const nextBillableMinutes =
          value.billableMinutes ?? (value.billable === false ? 0 : before.billableMinutes);
        if (!nextBillable && nextBillableMinutes !== 0) {
          throw new WorkValidationError(
            "billableMinutes must be 0 when billable is false " +
              "(time_entries_billable_zero_check)",
          );
        }
        const nextStartedAt = value.startedAt === undefined ? before.startedAt : value.startedAt;
        const nextEndedAt = value.endedAt === undefined ? before.endedAt : value.endedAt;
        if ((nextStartedAt === null) !== (nextEndedAt === null)) {
          throw new WorkValidationError(
            "startedAt and endedAt are recorded together or not at all " +
              "(time_entries_instant_pair_check)",
          );
        }
        if (nextStartedAt !== null && nextEndedAt !== null && nextEndedAt < nextStartedAt) {
          throw new WorkValidationError(
            "endedAt must not precede startedAt (time_entries_instant_order_check)",
          );
        }

        const assignments = ["updated_at = now()"];
        if (value.description !== undefined) {
          assignments.push(`description = ${nullable(value.description, textLiteral)}`);
        }
        if (value.activityCode !== undefined) {
          assignments.push(`activity_code = ${nullable(value.activityCode, textLiteral)}`);
        }
        if (value.minutes !== undefined) assignments.push(`minutes = ${value.minutes}`);
        if (value.billable !== undefined) assignments.push(`billable = ${value.billable}`);
        if (value.billableMinutes !== undefined || value.billable === false) {
          assignments.push(`billable_minutes = ${nextBillableMinutes}`);
        }
        if (value.startedAt !== undefined) {
          assignments.push(
            value.startedAt === null
              ? "started_at = null"
              : `started_at = '${value.startedAt.toISOString()}'`,
          );
        }
        if (value.endedAt !== undefined) {
          assignments.push(
            value.endedAt === null ? "ended_at = null" : `ended_at = '${value.endedAt.toISOString()}'`,
          );
        }

        await tx.execute(
          `update time_entries set ${assignments.join(", ")} where id = ${uuidLiteral(before.id)}`,
        );
        return load(tx, before.id);
      });
    },

    approve: async (input) =>
      db.transaction(async (tx) => {
        const before = await load(tx, input.timeEntryId);
        if (before.lockedAt !== null) {
          throw new WorkBoundaryError(`time entry "${before.id}" is locked and cannot be re-approved`);
        }
        await tx.execute(
          `update time_entries
              set approved_at = now(), approved_by_user_id = ${textLiteral(input.approvedByUserId)},
                  updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        return load(tx, before.id);
      }),

    reresolveRates: async (timeEntryId) =>
      db.transaction(async (tx) => {
        const before = await load(tx, timeEntryId);
        if (before.lockedAt !== null) {
          throw new WorkBoundaryError(`time entry "${before.id}" is locked and cannot be re-resolved`);
        }
        const ladderInput = {
          projectId: before.projectId,
          counterpartyId: before.counterpartyId,
          workedByUserId: before.workedByUserId,
          workedByCounterpartyId: before.workedByCounterpartyId,
          activityCode: before.activityCode,
          workedOn: before.workedOn,
        };
        const bill = await resolveRate(tx, { ...ladderInput, rateKind: "bill" });
        const cost = await resolveRate(tx, { ...ladderInput, rateKind: "cost" });
        if (
          bill.amount !== null &&
          cost.amount !== null &&
          bill.currency !== cost.currency
        ) {
          throw new WorkValidationError(
            `bill/cost rate currency mismatch on re-resolution: bill in ` +
              `"${bill.currency}", cost in "${cost.currency}"`,
          );
        }
        const currency = bill.currency ?? cost.currency ?? null;
        await tx.execute(
          `update time_entries
              set bill_rate_amount = ${nullable(bill.amount, decimalLiteral)},
                  bill_rate_source = ${textLiteral(bill.source)},
                  cost_rate_amount = ${nullable(cost.amount, decimalLiteral)},
                  cost_rate_source = ${textLiteral(cost.source)},
                  billing_rate_id = ${nullable(bill.billingRateId, uuidLiteral)},
                  currency = ${nullable(currency, textLiteral)},
                  updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        return load(tx, before.id);
      }),

    listForProject: async (projectId, filter) => {
      const predicates = [`project_id = ${uuidLiteral(projectId)}`];
      applyListFilter(predicates, filter);
      const result = await db.execute(
        `select * from time_entries where ${predicates.join(" and ")} order by worked_on desc, created_at desc${limitClause(filter?.limit)}`,
      );
      return result.rows.map(toRow);
    },

    listForWorker: async (workedByUserId, filter) => {
      const predicates = [`worked_by_user_id = ${textLiteral(workedByUserId)}`];
      applyListFilter(predicates, filter);
      const result = await db.execute(
        `select * from time_entries where ${predicates.join(" and ")} order by worked_on desc, created_at desc${limitClause(filter?.limit)}`,
      );
      return result.rows.map(toRow);
    },
  };
}

function applyListFilter(predicates: string[], filter?: TimeEntryListFilter): void {
  if (filter?.billableOnly === true) predicates.push("billable");
  if (filter?.unlockedOnly === true) predicates.push("locked_at is null");
  if (filter?.fromWorkedOn !== undefined) {
    predicates.push(`worked_on >= ${dateLiteral(filter.fromWorkedOn)}`);
  }
  if (filter?.toWorkedOn !== undefined) {
    predicates.push(`worked_on <= ${dateLiteral(filter.toWorkedOn)}`);
  }
}

function limitClause(limit: number | undefined): string {
  return limit === undefined ? "" : ` limit ${Math.max(1, Math.trunc(limit))}`;
}
