/**
 * The unbilled-work read model — the design's core Phase 6 capability
 * ("Only Loxep can know what has not been billed... the unbilled-work queue
 * is the join of `time_entries`, `project_material_uses`, `service_periods`,
 * and `expenses` against `invoice_line_sources`"), implemented for the first
 * time here.
 *
 * ## What this module can actually compute, honestly
 *
 * Of the four source tables the design names, only TWO physically exist as
 * something `@loxep/work` can read: `time_entries` and `project_material_uses`
 * (migration 0011). `service_periods` is design-only (Phase 6's
 * services/subscriptions milestone has not shipped). `expenses` exists
 * (Phase 5), but the `project_id` column the design plans for it
 * (`expenses.project_id`) is one of the ALTERs `bd show loxep-nw0` explicitly
 * deferred — there is no column to join through yet, so an expenses source is
 * not merely unbuilt here, it is unreachable until that ALTER ships. This
 * module therefore covers **time and materials only**, and says so in its own
 * return shape rather than silently reporting a partial total as if it were
 * whole.
 *
 * ## The "billed" side is an explicit, injected seam
 *
 * The other half of the join — `invoice_line_sources` — does not exist at
 * all (`invoices`, `invoice_lines`, `invoice_line_sources`, and
 * `invoice_payments` are all design-only; see the design's "The invoice
 * model" and OQ1). Rather than invent an `invoices` table (explicitly out of
 * scope for this slice) or silently pretend every fact is perpetually
 * unbilled with no way to override it, this module takes an injectable
 * {@link BilledResolver}. The default, {@link alwaysUnbilledResolver}, treats
 * every fact as unbilled — which is honestly correct today, since nothing
 * ships that could ever mark one billed — and is where a future
 * `invoice_line_sources`-backed resolver plugs in:
 *
 * ```text
 * TODO(invoice_line_sources): once a billing package creates that table,
 * replace alwaysUnbilledResolver with one that queries
 * `select 1 from invoice_line_sources
 *   where source_fact_type = $1 and source_fact_id = $2 and is_active`
 * — the exact anti-join the design names as "the most-run query in the phase".
 * ```
 */
import type { LoxepDb } from "@loxep/db";
import { mapTimeEntryRow, timeEntryBillableAmount } from "./time.ts";
import type { TimeEntryRow } from "./time.ts";
import { mapMaterialUseRow, materialUseLineAmount } from "./materials.ts";
import type { ProjectMaterialUseRow } from "./materials.ts";
import { sumDecimals } from "./decimal.ts";
import { uuidLiteral } from "./sql.ts";

export type SourceFactType = "time_entry" | "project_material_use";

/**
 * The seam onto `invoice_line_sources`. `isBilled` answers "does this fact
 * already have an ACTIVE invoice-line link" — the exact predicate the
 * design's partial unique index (`unique(source_fact_type, source_fact_id)
 * where is_active`) makes possible once it exists.
 */
export interface BilledResolver {
  isBilled: (sourceFactType: SourceFactType, sourceFactId: string) => Promise<boolean>;
}

/** The honest default: nothing has ever been billed, because nothing CAN be — `invoice_line_sources` does not exist. */
export const alwaysUnbilledResolver: BilledResolver = {
  isBilled: async () => false,
};

export interface UnbilledWorkFilter {
  projectId?: string;
  counterpartyId?: string;
  economicEntityId?: string;
  limit?: number;
}

export interface CurrencyTotal {
  currency: string;
  count: number;
  /** `null` when any row in this currency has nothing to compute an amount from — an honest gap beats a plausible wrong number. */
  totalAmount: string | null;
}

export interface UnbilledWorkSummary {
  time: {
    byCurrency: CurrencyTotal[];
    /** Billable, unbilled entries whose `bill_rate_source = 'unresolved'` — counted, never defaulted to zero. */
    unratedCount: number;
  };
  materials: {
    byCurrency: CurrencyTotal[];
    /** Billable, unbilled uses with no `unit_charge_amount` set. */
    unpricedCount: number;
  };
  /**
   * Named so a caller can never mistake this for the design's full
   * definition. See the module doc: `service_periods` and `expenses` are not
   * included because neither is reachable from this package today.
   */
  coversSourceTypes: readonly SourceFactType[];
}

export interface UnbilledWorkService {
  listUnbilledTime: (filter?: UnbilledWorkFilter) => Promise<TimeEntryRow[]>;
  listUnbilledMaterials: (filter?: UnbilledWorkFilter) => Promise<ProjectMaterialUseRow[]>;
  /** Billable, unbilled time entries with `bill_rate_source = 'unresolved'` — the design's "unrated billable work" read model. */
  listUnratedBillableTime: (filter?: UnbilledWorkFilter) => Promise<TimeEntryRow[]>;
  summarize: (filter?: UnbilledWorkFilter) => Promise<UnbilledWorkSummary>;
}

/** `time_entries` carries `project_id`, `counterparty_id`, AND `economic_entity_id`. */
function timeFilterPredicates(filter?: UnbilledWorkFilter): string[] {
  const predicates: string[] = [];
  if (filter?.projectId !== undefined) predicates.push(`project_id = ${uuidLiteral(filter.projectId)}`);
  if (filter?.counterpartyId !== undefined) {
    predicates.push(`counterparty_id = ${uuidLiteral(filter.counterpartyId)}`);
  }
  if (filter?.economicEntityId !== undefined) {
    predicates.push(`economic_entity_id = ${uuidLiteral(filter.economicEntityId)}`);
  }
  return predicates;
}

/**
 * `project_material_uses` carries only `project_id` — there is no
 * `counterparty_id`/`economic_entity_id` column on that table (a material use
 * is attributed only through the project it belongs to). A `counterpartyId`
 * or `economicEntityId` filter therefore has nothing to constrain here and is
 * silently ignored rather than producing a query against a column that does
 * not exist.
 */
function materialFilterPredicates(filter?: UnbilledWorkFilter): string[] {
  const predicates: string[] = [];
  if (filter?.projectId !== undefined) predicates.push(`project_id = ${uuidLiteral(filter.projectId)}`);
  return predicates;
}

function limitClause(limit: number | undefined): string {
  return limit === undefined ? "" : ` limit ${Math.max(1, Math.trunc(limit))}`;
}

export function createUnbilledWorkService(options: {
  db: LoxepDb;
  billedResolver?: BilledResolver;
}): UnbilledWorkService {
  const { db } = options;
  const billedResolver = options.billedResolver ?? alwaysUnbilledResolver;

  async function fetchCandidateTime(filter?: UnbilledWorkFilter): Promise<TimeEntryRow[]> {
    const predicates = ["billable", "locked_at is null", ...timeFilterPredicates(filter)];
    const result = await db.execute(
      `select * from time_entries where ${predicates.join(" and ")}
        order by worked_on desc, created_at desc${limitClause(filter?.limit)}`,
    );
    return result.rows.map(mapTimeEntryRow);
  }

  async function fetchCandidateMaterials(
    filter?: UnbilledWorkFilter,
  ): Promise<ProjectMaterialUseRow[]> {
    const predicates = ["billable", "locked_at is null", ...materialFilterPredicates(filter)];
    const result = await db.execute(
      `select * from project_material_uses where ${predicates.join(" and ")}
        order by consumed_on desc, created_at desc${limitClause(filter?.limit)}`,
    );
    return result.rows.map(mapMaterialUseRow);
  }

  async function excludeBilled<T extends { id: string }>(
    rows: T[],
    sourceFactType: SourceFactType,
  ): Promise<T[]> {
    const flags = await Promise.all(rows.map((row) => billedResolver.isBilled(sourceFactType, row.id)));
    return rows.filter((_, index) => flags[index] === false);
  }

  return {
    listUnbilledTime: async (filter) =>
      excludeBilled(await fetchCandidateTime(filter), "time_entry"),

    listUnbilledMaterials: async (filter) =>
      excludeBilled(await fetchCandidateMaterials(filter), "project_material_use"),

    listUnratedBillableTime: async (filter) => {
      const predicates = [
        "billable",
        "locked_at is null",
        "bill_rate_source = 'unresolved'",
        ...timeFilterPredicates(filter),
      ];
      const result = await db.execute(
        `select * from time_entries where ${predicates.join(" and ")}
          order by worked_on desc, created_at desc${limitClause(filter?.limit)}`,
      );
      return result.rows.map(mapTimeEntryRow);
    },

    summarize: async (filter) => {
      const [unbilledTime, unbilledMaterials] = await Promise.all([
        excludeBilled(await fetchCandidateTime(filter), "time_entry"),
        excludeBilled(await fetchCandidateMaterials(filter), "project_material_use"),
      ]);

      const timeByCurrency = new Map<string, { amounts: string[]; count: number; hasGap: boolean }>();
      let unratedCount = 0;
      for (const entry of unbilledTime) {
        if (entry.billRateSource === "unresolved") unratedCount += 1;
        const currency = entry.currency ?? "—";
        const bucket = timeByCurrency.get(currency) ?? { amounts: [], count: 0, hasGap: false };
        bucket.count += 1;
        const amount = timeEntryBillableAmount(entry);
        if (amount === null) bucket.hasGap = true;
        else bucket.amounts.push(amount);
        timeByCurrency.set(currency, bucket);
      }

      const materialsByCurrency = new Map<
        string,
        { amounts: string[]; count: number; hasGap: boolean }
      >();
      let unpricedCount = 0;
      for (const use of unbilledMaterials) {
        const amount = materialUseLineAmount(use);
        if (amount === null) unpricedCount += 1;
        const bucket = materialsByCurrency.get(use.currency) ?? {
          amounts: [],
          count: 0,
          hasGap: false,
        };
        bucket.count += 1;
        if (amount === null) bucket.hasGap = true;
        else bucket.amounts.push(amount);
        materialsByCurrency.set(use.currency, bucket);
      }

      const toTotals = (
        map: Map<string, { amounts: string[]; count: number; hasGap: boolean }>,
      ): CurrencyTotal[] =>
        Array.from(map.entries())
          .map(([currency, bucket]) => ({
            currency,
            count: bucket.count,
            // Never a plausible-but-wrong number: if any row in this currency
            // lacks a computable amount, the total is refused rather than
            // understated.
            totalAmount: bucket.hasGap ? null : sumDecimals(bucket.amounts, 6),
          }))
          .sort((a, b) => a.currency.localeCompare(b.currency));

      return {
        time: { byCurrency: toTotals(timeByCurrency), unratedCount },
        materials: { byCurrency: toTotals(materialsByCurrency), unpricedCount },
        coversSourceTypes: ["time_entry", "project_material_use"],
      };
    },
  };
}
