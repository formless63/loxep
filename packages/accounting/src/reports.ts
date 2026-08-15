/**
 * Expense read models.
 *
 * Four queries, one per named question, computed and never stored — the same
 * posture Phase 4 took for pro-rata fee allocation and Phase 5 takes for
 * retained earnings. There is no `expense_summaries` table and there should not
 * be one until a measured query is slow.
 *
 * ```text
 * listExpenses        the operator's grid: entity, period, category, status
 * expenseTotals       grouped sums — by month, entity, category, or payee
 * unallocatedExpenses the reconciliation report the design asks for by name
 * postingBacklog      what a ledger would have to post if one existed
 * ```
 *
 * ## Currency is never summed across currencies
 *
 * Every grouped total carries its `currency` in the grouping key, and there is
 * no conversion anywhere. Phase 5's design is unambiguous that conversion
 * happens *in the journal* at posting time with the rate frozen on the line,
 * and that operational tables keep exactly one currency forever; a read model
 * that added a EUR expense to a USD one would be inventing the rate the whole
 * design refuses to invent. A caller wanting one number for a mixed-currency
 * period gets several rows and has to decide, which is the honest answer.
 *
 * ## The unallocated report
 *
 * The design states the allocation invariant is *"a service rule and a
 * reconciliation report"*. `@loxep/accounting`'s expense service is the service
 * rule; {@link unallocatedExpenses} is the report. It deliberately includes
 * expenses with **no** allocations at all — an expense with none is valid and
 * complete, so the report's `allocationCount` distinguishes "not split" from
 * "partly split" rather than the query hiding one of them.
 */
import type { LoxepDb } from "@loxep/db";
import { subtractDecimals } from "./decimal.ts";
import { dateLiteral, textLiteral, textList, uuidLiteral } from "./sql.ts";

export interface ExpenseFilter {
  economicEntityId?: string | null;
  /** Inclusive calendar-date bounds, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
  category?: string;
  statuses?: string[];
  currency?: string;
  limit?: number;
}

export interface ExpenseListRow {
  expenseId: string;
  referenceCode: string;
  expenseDate: string;
  economicEntityId: string | null;
  entityAttributionSource: string;
  payeeName: string | null;
  /** Added migration 0024 (loxep-cd3.1) — the linked counterparty, unresolved (caller resolves the survivor pointer if it joins further). */
  payeeCounterpartyId: string | null;
  category: string;
  currency: string;
  amount: string;
  taxAmount: string;
  paymentMethod: string;
  status: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  allocationCount: number;
  receiptCount: number;
}

export interface ExpenseTotalRow {
  groupKey: string;
  currency: string;
  totalAmount: string;
  totalTaxAmount: string;
  expenseCount: number;
}

export interface UnallocatedExpenseRow {
  expenseId: string;
  referenceCode: string;
  expenseDate: string;
  currency: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  allocationCount: number;
  status: string;
}

export type ExpenseGrouping = "month" | "entity" | "category" | "payee";

function filterPredicates(filter: ExpenseFilter | undefined): string[] {
  const predicates: string[] = [];
  if (filter === undefined) return predicates;
  if (filter.economicEntityId === null) {
    predicates.push("e.economic_entity_id is null");
  } else if (filter.economicEntityId !== undefined) {
    predicates.push(
      `e.economic_entity_id = ${uuidLiteral(filter.economicEntityId)}`,
    );
  }
  if (filter.from !== undefined) {
    predicates.push(`e.expense_date >= ${dateLiteral(filter.from)}`);
  }
  if (filter.to !== undefined) {
    predicates.push(`e.expense_date <= ${dateLiteral(filter.to)}`);
  }
  if (filter.category !== undefined) {
    predicates.push(`e.category = ${textLiteral(filter.category)}`);
  }
  if (filter.currency !== undefined) {
    predicates.push(`e.currency = ${textLiteral(filter.currency.toUpperCase())}`);
  }
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    predicates.push(`e.status in (${textList(filter.statuses)})`);
  }
  return predicates;
}

function whereClause(predicates: string[]): string {
  return predicates.length === 0 ? "" : `where ${predicates.join(" and ")}`;
}

/**
 * The allocation roll-up, as a subquery rather than a join.
 *
 * A `left join` onto `expense_allocations` would multiply the expense row per
 * allocation and force every scalar to be wrapped in an aggregate; a scalar
 * subquery keeps the outer row singular and reads as what it is.
 */
const ALLOCATED_SUM = `(select coalesce(sum(a.amount), 0)
                          from expense_allocations a
                         where a.expense_id = e.id)`;
const ALLOCATION_COUNT = `(select count(*) from expense_allocations a
                            where a.expense_id = e.id)`;
const RECEIPT_COUNT = `(select count(*) from media_links m
                         where m.resource_type = 'expense'
                           and m.resource_id = e.id::text)`;

export interface ExpenseReports {
  listExpenses: (filter?: ExpenseFilter) => Promise<ExpenseListRow[]>;
  expenseTotals: (
    grouping: ExpenseGrouping,
    filter?: ExpenseFilter,
  ) => Promise<ExpenseTotalRow[]>;
  unallocatedExpenses: (
    filter?: ExpenseFilter,
  ) => Promise<UnallocatedExpenseRow[]>;
  /**
   * Recorded expenses no ledger has consumed.
   *
   * With no `journal_entries` table, "unposted" is exactly "recorded", and this
   * query is the seam's honest current form: it names the rows a posting engine
   * would take as source facts on its first run. It reads `status` only — never
   * a join to a table that does not exist.
   */
  postingBacklog: (filter?: ExpenseFilter) => Promise<
    {
      expenseId: string;
      referenceCode: string;
      expenseDate: string;
      currency: string;
      amount: string;
      category: string;
      economicEntityId: string | null;
      sourceFactType: string;
      sourceFactId: string;
    }[]
  >;
}

export function createExpenseReports(options: {
  db: LoxepDb;
}): ExpenseReports {
  const { db } = options;

  return {
    listExpenses: async (filter) => {
      const limit =
        filter?.limit === undefined ? "" : ` limit ${Math.max(1, Math.trunc(filter.limit))}`;
      const result = await db.execute(
        `select e.id::text as id, e.reference_code, e.expense_date::text as expense_date,
                e.economic_entity_id::text as economic_entity_id,
                e.entity_attribution_source, e.payee_name,
                e.payee_counterparty_id::text as payee_counterparty_id,
                e.category, e.currency,
                e.amount::text as amount, e.tax_amount::text as tax_amount,
                e.payment_method, e.status,
                ${ALLOCATED_SUM}::numeric(20, 6)::text as allocated,
                ${ALLOCATION_COUNT}::text as allocation_count,
                ${RECEIPT_COUNT}::text as receipt_count
           from expenses e
          ${whereClause(filterPredicates(filter))}
          order by e.expense_date desc, e.reference_code desc${limit}`,
      );
      return result.rows.map((row) => {
        const amount = row["amount"] as string;
        const allocated = row["allocated"] as string;
        return {
          expenseId: row["id"] as string,
          referenceCode: row["reference_code"] as string,
          expenseDate: row["expense_date"] as string,
          economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
          entityAttributionSource: row["entity_attribution_source"] as string,
          payeeName: (row["payee_name"] as string | null) ?? null,
          payeeCounterpartyId:
            (row["payee_counterparty_id"] as string | null) ?? null,
          category: row["category"] as string,
          currency: row["currency"] as string,
          amount,
          taxAmount: row["tax_amount"] as string,
          paymentMethod: row["payment_method"] as string,
          status: row["status"] as string,
          allocatedAmount: allocated,
          unallocatedAmount: subtractDecimals(amount, allocated),
          allocationCount: Number(row["allocation_count"]),
          receiptCount: Number(row["receipt_count"]),
        };
      });
    },

    expenseTotals: async (grouping, filter) => {
      // A closed set mapped to a fixed expression: the grouping never reaches
      // SQL as caller-supplied text.
      const expression =
        grouping === "month"
          ? "to_char(e.expense_date, 'YYYY-MM')"
          : grouping === "entity"
            ? "coalesce(e.economic_entity_id::text, 'unattributed')"
            : grouping === "category"
              ? "e.category"
              : "coalesce(e.payee_name, '(no payee)')";
      const result = await db.execute(
        `select ${expression} as group_key, e.currency,
                sum(e.amount)::numeric(20, 6)::text as total_amount,
                sum(e.tax_amount)::numeric(20, 6)::text as total_tax_amount,
                count(*)::text as expense_count
           from expenses e
          ${whereClause(filterPredicates(filter))}
          group by 1, e.currency
          order by 1, e.currency`,
      );
      return result.rows.map((row) => ({
        groupKey: row["group_key"] as string,
        currency: row["currency"] as string,
        totalAmount: row["total_amount"] as string,
        totalTaxAmount: row["total_tax_amount"] as string,
        expenseCount: Number(row["expense_count"]),
      }));
    },

    unallocatedExpenses: async (filter) => {
      const predicates = filterPredicates(filter);
      // Void rows are excluded unless the caller asked for them explicitly: a
      // retracted expense is not an allocation backlog item.
      if (filter?.statuses === undefined) {
        predicates.push("e.status <> 'void'");
      }
      predicates.push(`${ALLOCATED_SUM} <> e.amount`);
      const result = await db.execute(
        `select e.id::text as id, e.reference_code, e.expense_date::text as expense_date,
                e.currency, e.amount::text as amount, e.status,
                ${ALLOCATED_SUM}::numeric(20, 6)::text as allocated,
                ${ALLOCATION_COUNT}::text as allocation_count
           from expenses e
          ${whereClause(predicates)}
          order by e.expense_date desc, e.reference_code desc`,
      );
      return result.rows.map((row) => {
        const amount = row["amount"] as string;
        const allocated = row["allocated"] as string;
        return {
          expenseId: row["id"] as string,
          referenceCode: row["reference_code"] as string,
          expenseDate: row["expense_date"] as string,
          currency: row["currency"] as string,
          amount,
          allocatedAmount: allocated,
          unallocatedAmount: subtractDecimals(amount, allocated),
          allocationCount: Number(row["allocation_count"]),
          status: row["status"] as string,
        };
      });
    },

    postingBacklog: async (filter) => {
      const predicates = filterPredicates(filter);
      predicates.push("e.status = 'recorded'");
      const result = await db.execute(
        `select e.id::text as id, e.reference_code, e.expense_date::text as expense_date,
                e.currency, e.amount::text as amount, e.category,
                e.economic_entity_id::text as economic_entity_id
           from expenses e
          ${whereClause(predicates)}
          order by e.expense_date, e.reference_code`,
      );
      return result.rows.map((row) => ({
        expenseId: row["id"] as string,
        referenceCode: row["reference_code"] as string,
        expenseDate: row["expense_date"] as string,
        currency: row["currency"] as string,
        amount: row["amount"] as string,
        category: row["category"] as string,
        economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
        sourceFactType: "expense",
        sourceFactId: row["id"] as string,
      }));
    },
  };
}
