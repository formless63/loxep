/**
 * Fiscal periods: generation, resolution, and the four-state close.
 *
 * ## Periods are generated, never auto-created on demand
 *
 * Book creation generates one fiscal year of monthly periods from the book's
 * `fiscal_year_start_month`/`_day`, and a later call extends forward. Posting
 * into a date with no period is an **unpostable-backlog condition**, not an
 * implicit `INSERT`, because auto-creating a period silently reopens a year the
 * operator believed was finished — and the moment a period appears out of
 * nowhere, "is this month closed?" stops having an answer.
 *
 * ## Soft close, and why it is the default
 *
 * ```text
 * open          ordinary posting; anything goes
 * soft_closed   ordinary posting BLOCKED; an explicitly authorized, audited
 *               backdated posting is permitted and is FLAGGED on the entry
 * closed        all posting blocked; reopening is an explicit audited action
 * locked        all posting blocked; no application path reopens it
 * ```
 *
 * Provider facts arrive late and that is normal, not exceptional: an eBay
 * final-value-fee adjustment three days after month end, a payout statement on
 * the 4th covering the 28th–31st, a carrier post-audit reweigh a week later —
 * which Phase 4 called one of the most reliably underestimated costs in resale.
 * A hard close makes those unpostable; "post it to the next open period" moves
 * a March fee into April and quietly misstates both months. Soft close keeps
 * the fact in its own month and puts `is_backdated = true` on the entry, so the
 * delta between the statement someone printed on the 1st and the statement
 * today is answerable by query.
 *
 * ## PROVISIONAL (design open question 5)
 *
 * The design asks the owner one further question this package cannot answer:
 * whether backdating is `admin`-only or available to `member`. `@loxep/accounting`
 * models no roles — it takes an explicit `allowBackdated` opt-in and records
 * who acted. Gating that flag by deployment role is the web layer's decision,
 * and `admin`-only is the recommendation carried forward.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { fiscalPeriods } from "@loxep/db/schema";
import type { FiscalPeriodStatus } from "@loxep/db/schema";
import { z } from "zod";
import {
  AccountingConflictError,
  AccountingNotFoundError,
  AccountingValidationError,
  FiscalPeriodClosedError,
  LedgerImmutableError,
} from "./errors.ts";
import { dateLiteral, textLiteral, uuidLiteral } from "./sql.ts";

export type FiscalPeriodRow = typeof fiscalPeriods.$inferSelect;

type Executor = Pick<LoxepDb, "insert" | "execute" | "query">;

/** Periods a posting may never enter, whatever authorization the caller holds. */
const HARD_CLOSED: readonly FiscalPeriodStatus[] = ["closed", "locked"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The first day of a fiscal year, with the day clamped into the month.
 *
 * A book whose fiscal year starts on the 31st has no January 31st equivalent in
 * February, and a book starting on the 29th has none in a common year. Clamping
 * in TypeScript keeps the anchor a single unambiguous date instead of pushing
 * the question into PostgreSQL's month arithmetic, where `+ 1 month` would
 * silently produce a different answer than the caller expected.
 */
export function fiscalYearStartDate(
  fiscalYear: number,
  month: number,
  day: number,
): string {
  const lastDayOfMonth = new Date(Date.UTC(fiscalYear, month, 0)).getUTCDate();
  return `${fiscalYear}-${pad(month)}-${pad(Math.min(day, lastDayOfMonth))}`;
}

/**
 * Which fiscal year a calendar date falls in, for a book with this start.
 *
 * PROVISIONAL: a fiscal year is labelled by the CALENDAR YEAR IT STARTS IN. A
 * book whose year runs July 2026 → June 2027 calls that `FY2026`. Both
 * conventions exist in the wild — some jurisdictions label by the ending year —
 * and the design does not choose. Starting-year labelling is chosen because it
 * makes `fiscal_year` derivable from `starts_on` without knowing the book's
 * configuration, and because it degrades to the obvious answer for the
 * overwhelmingly common January start.
 */
export function fiscalYearFor(
  isoDate: string,
  fiscalYearStartMonth: number,
  fiscalYearStartDay: number,
): number {
  const year = Number(isoDate.slice(0, 4));
  return isoDate >= fiscalYearStartDate(year, fiscalYearStartMonth, fiscalYearStartDay)
    ? year
    : year - 1;
}

/** `FY2026-P03`. */
export function periodCodeFor(fiscalYear: number, sequence: number): string {
  return `FY${fiscalYear}-P${pad(sequence)}`;
}

const generateSchema = z.strictObject({
  accountingBookId: z.uuid(),
  fiscalYear: z.number().int().min(1900).max(9999),
  /** Twelve monthly periods is the default; 13-period and quarterly books are not modelled. */
  periodCount: z.number().int().min(1).max(12).default(12),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type GenerateFiscalYearInput = z.input<typeof generateSchema>;

const setStatusSchema = z.strictObject({
  fiscalPeriodId: z.uuid(),
  status: z.enum(["open", "soft_closed", "closed", "locked"]),
  note: z.string().trim().min(1).nullish(),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AccountingValidationError(`invalid fiscal period input: ${issues}`);
  }
  return parsed.data;
}

export interface FiscalPeriodsService {
  /**
   * Generate one fiscal year of monthly periods. Idempotent: re-running it for
   * a year that already exists creates nothing, because at-least-once jobs and
   * impatient operators both press the button twice.
   */
  generateFiscalYear: (
    input: GenerateFiscalYearInput,
  ) => Promise<{ created: number; periods: FiscalPeriodRow[] }>;
  getPeriod: (fiscalPeriodId: string) => Promise<FiscalPeriodRow>;
  listPeriods: (
    accountingBookId: string,
    options?: { fiscalYear?: number },
  ) => Promise<FiscalPeriodRow[]>;
  /** The period containing a date, or null. A lookup, not a judgement — the exclusion constraint guarantees it. */
  resolvePeriod: (
    accountingBookId: string,
    isoDate: string,
  ) => Promise<FiscalPeriodRow | null>;
  /** {@link resolvePeriod}, raising the unpostable-backlog error when there is none. */
  requirePeriod: (
    accountingBookId: string,
    isoDate: string,
  ) => Promise<FiscalPeriodRow>;
  setStatus: (
    input: z.input<typeof setStatusSchema>,
  ) => Promise<FiscalPeriodRow>;
  /** Convenience for the ordinary month-end action. */
  closePeriod: (input: {
    fiscalPeriodId: string;
    status?: "soft_closed" | "closed" | "locked";
    note?: string | null;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<FiscalPeriodRow>;
  /** Explicit and audited; refused for `locked`. */
  reopenPeriod: (input: {
    fiscalPeriodId: string;
    note?: string | null;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<FiscalPeriodRow>;
}

export function createFiscalPeriodsService(options: {
  db: LoxepDb;
}): FiscalPeriodsService {
  const { db } = options;

  async function loadPeriod(
    executor: Executor,
    fiscalPeriodId: string,
  ): Promise<FiscalPeriodRow> {
    const row = await executor.query.fiscalPeriods.findFirst({
      where: (table, { eq }) => eq(table.id, fiscalPeriodId),
    });
    if (row === undefined) {
      throw new AccountingNotFoundError(
        `unknown fiscal period "${fiscalPeriodId}"`,
      );
    }
    return row;
  }

  async function resolvePeriod(
    executor: Executor,
    accountingBookId: string,
    isoDate: string,
  ): Promise<FiscalPeriodRow | null> {
    const result = await executor.execute(
      `select id::text as id from fiscal_periods
        where accounting_book_id = ${uuidLiteral(accountingBookId)}
          and starts_on <= ${dateLiteral(isoDate)}
          and ends_on >= ${dateLiteral(isoDate)}
        limit 1`,
    );
    const id = result.rows[0]?.["id"];
    if (typeof id !== "string") return null;
    return loadPeriod(executor, id);
  }

  async function setStatus(
    input: z.input<typeof setStatusSchema>,
  ): Promise<FiscalPeriodRow> {
    const value = parse(setStatusSchema, input);
    return db.transaction(async (tx) => {
      const before = await loadPeriod(tx, value.fiscalPeriodId);
      if (before.status === value.status) return before;
      if (before.status === "locked") {
        throw new LedgerImmutableError(
          `fiscal period ${before.periodCode} is locked: no application ` +
            "path reopens it. Locking is for years old enough that even an " +
            "authorized reopen is a mistake.",
        );
      }
      const closing = value.status !== "open";
      const assignments = [
        `status = ${textLiteral(value.status)}`,
        closing ? "closed_at = now()" : "closed_at = null",
        closing
          ? `closed_by_user_id = ${value.actorUserId === undefined || value.actorUserId === null ? "null" : textLiteral(value.actorUserId)}`
          : "closed_by_user_id = null",
        "updated_at = now()",
      ];
      if (value.note !== undefined) {
        assignments.push(
          `note = ${value.note === null ? "null" : textLiteral(value.note)}`,
        );
      }
      await tx.execute(
        `update fiscal_periods set ${assignments.join(", ")}
          where id = ${uuidLiteral(before.id)}`,
      );
      const after = await loadPeriod(tx, before.id);
      await createAuditService({ db: tx }).append({
        actorUserId: value.actorUserId ?? null,
        action:
          value.status === "open"
            ? "accounting.period.reopened"
            : "accounting.period.closed",
        resourceType: "fiscal_period",
        resourceId: before.id,
        before: { status: before.status },
        after: { status: after.status },
        requestId: value.requestId ?? null,
        metadata: {
          accountingBookId: before.accountingBookId,
          periodCode: before.periodCode,
          note: value.note ?? null,
        },
      });
      return after;
    });
  }

  return {
    generateFiscalYear: async (input) => {
      const value = parse(generateSchema, input);
      return db.transaction(async (tx) => {
        const book = await tx.query.accountingBooks.findFirst({
          where: (table, { eq }) => eq(table.id, value.accountingBookId),
        });
        if (book === undefined) {
          throw new AccountingNotFoundError(
            `unknown accounting book "${value.accountingBookId}"`,
          );
        }
        const start = fiscalYearStartDate(
          value.fiscalYear,
          book.fiscalYearStartMonth,
          book.fiscalYearStartDay,
        );

        // Generated in SQL so that month-end arithmetic is PostgreSQL's:
        // anchoring every boundary on the same start date keeps the periods
        // contiguous and non-overlapping even when the anchor is the 31st,
        // because `+ n months` clamps and `- 1 day` steps back from the NEXT
        // clamped boundary rather than from a locally computed one.
        let created: string[] = [];
        try {
          const result = await tx.execute(
            `insert into fiscal_periods
               (accounting_book_id, period_code, fiscal_year, sequence, starts_on, ends_on)
             select ${uuidLiteral(value.accountingBookId)},
                    'FY' || ${value.fiscalYear} || '-P' || lpad((gs.i + 1)::text, 2, '0'),
                    ${value.fiscalYear}, gs.i + 1,
                    (${dateLiteral(start)} + (gs.i || ' months')::interval)::date,
                    ((${dateLiteral(start)} + ((gs.i + 1) || ' months')::interval)::date - 1)
               from generate_series(0, ${value.periodCount - 1}) as gs(i)
             on conflict on constraint fiscal_periods_book_year_sequence_uq do nothing
             returning id::text as id`,
          );
          created = result.rows.map((row) => row["id"] as string);
        } catch (error) {
          if (isExclusionViolation(error)) {
            throw new AccountingConflictError(
              `fiscal year ${value.fiscalYear} for this book would overlap a ` +
                "period that already exists. Periods never overlap — that " +
                "invariant is what makes 'the period containing this date' a " +
                "lookup — so this is a fiscal-year-start misconfiguration, " +
                "not a duplicate run.",
            );
          }
          throw error;
        }

        const periods = await tx.query.fiscalPeriods.findMany({
          where: (table, { and, eq }) =>
            and(
              eq(table.accountingBookId, value.accountingBookId),
              eq(table.fiscalYear, value.fiscalYear),
            ),
          orderBy: (table, { asc }) => [asc(table.sequence)],
        });

        if (created.length > 0) {
          await createAuditService({ db: tx }).append({
            actorUserId: value.actorUserId ?? null,
            action: "accounting.period.generated",
            resourceType: "accounting_book",
            resourceId: value.accountingBookId,
            after: {
              fiscalYear: value.fiscalYear,
              created: created.length,
              startsOn: periods[0]?.startsOn ?? null,
              endsOn: periods[periods.length - 1]?.endsOn ?? null,
            },
            requestId: value.requestId ?? null,
          });
        }
        return { created: created.length, periods };
      });
    },

    getPeriod: async (fiscalPeriodId) => loadPeriod(db, fiscalPeriodId),

    listPeriods: async (accountingBookId, listOptions) =>
      db.query.fiscalPeriods.findMany({
        where: (table, { and, eq }) => {
          const predicates = [eq(table.accountingBookId, accountingBookId)];
          if (listOptions?.fiscalYear !== undefined) {
            predicates.push(eq(table.fiscalYear, listOptions.fiscalYear));
          }
          return and(...predicates);
        },
        orderBy: (table, { asc }) => [asc(table.startsOn)],
      }),

    resolvePeriod: async (accountingBookId, isoDate) =>
      resolvePeriod(db, accountingBookId, isoDate),

    requirePeriod: async (accountingBookId, isoDate) => {
      const period = await resolvePeriod(db, accountingBookId, isoDate);
      if (period === null) throw noPeriodError(isoDate);
      return period;
    },

    setStatus,

    closePeriod: async (input) =>
      setStatus({
        fiscalPeriodId: input.fiscalPeriodId,
        status: input.status ?? "soft_closed",
        note: input.note ?? null,
        actorUserId: input.actorUserId ?? null,
        requestId: input.requestId ?? null,
      }),

    reopenPeriod: async (input) =>
      setStatus({
        fiscalPeriodId: input.fiscalPeriodId,
        status: "open",
        note: input.note ?? null,
        actorUserId: input.actorUserId ?? null,
        requestId: input.requestId ?? null,
      }),
  };
}

/** The unpostable-backlog condition, phrased as the design phrases it. */
export function noPeriodError(isoDate: string): FiscalPeriodClosedError {
  return new FiscalPeriodClosedError(
    `no fiscal period contains ${isoDate}. Periods are generated, never ` +
      "auto-created on demand, because inventing one silently reopens a year " +
      "the operator believed was finished. Generate the fiscal year first; " +
      "until then the fact belongs in the unpostable backlog.",
  );
}

/**
 * Whether a period accepts an ordinary posting, and what it demands otherwise.
 *
 * Shared with `journal.ts` so the service and the database trigger cannot
 * disagree about what a soft close means.
 */
export function assertPeriodAcceptsPosting(
  period: FiscalPeriodRow,
  options: { allowBackdated: boolean },
): { isBackdated: boolean } {
  if (HARD_CLOSED.includes(period.status as FiscalPeriodStatus)) {
    throw new FiscalPeriodClosedError(
      `fiscal period ${period.periodCode} is ${period.status}: posting into ` +
        "it is blocked. Post the correction into an open period instead — " +
        "reversal-and-repost degrades gracefully to the current period, which " +
        "is what an accountant would do by hand.",
    );
  }
  if (period.status === "soft_closed") {
    if (!options.allowBackdated) {
      throw new FiscalPeriodClosedError(
        `fiscal period ${period.periodCode} is soft_closed: ordinary posting ` +
          "is blocked. A late provider fact may still be posted into its own " +
          "month through the explicit authorized path (allowBackdated), which " +
          "flags the entry is_backdated so the restatement is visible rather " +
          "than silent.",
      );
    }
    return { isBackdated: true };
  }
  return { isBackdated: false };
}

/** PostgreSQL `23P01 exclusion_violation`, however the driver wrapped it. */
export function isExclusionViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "23P01") return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isExclusionViolation(cause);
}
