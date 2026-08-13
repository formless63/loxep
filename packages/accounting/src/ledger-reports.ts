/**
 * Ledger read models: the trial balance, account balances, and account
 * activity.
 *
 * Statements are **read models in this package, not database views**. Volumes
 * are small, the shapes will change, and a view definition inside a migration
 * hides business logic from the type system and the test suite. If query
 * complexity ever justifies one it is a plain non-materialized view in its own
 * late migration, droppable and recreatable without touching base tables — and
 * never a Timescale continuous aggregate, because these are transactional
 * tables and not a time series.
 *
 * ## What counts as "in the books"
 *
 * ```text
 * draft     excluded — legitimately unbalanced, not yet asserted
 * void      excluded — an abandoned draft
 * posted    INCLUDED
 * reversed  INCLUDED, and this is the part people get wrong
 * ```
 *
 * A reversed entry's lines are untouched and still count. Its reversal's lines
 * are what net them out, and excluding either half would leave the trial
 * balance non-zero by exactly the amount of the correction. `reversed` is a
 * marker saying "a reversal exists", never a filter.
 *
 * ## Debit and credit exist only here
 *
 * `journal_lines.amount` is one signed column — positive debit, negative credit
 * — so every balance is `sum(amount)` rather than a two-column difference over
 * nullable values. Accountants read debit and credit, so the presentation
 * boundary is where the split happens: `debit = greatest(amount, 0)`,
 * `credit = greatest(-amount, 0)`, written once, here, and tested once.
 *
 * ## Every figure is in the book's functional currency
 *
 * Balances sum `functional_amount`, which is the one place in Loxep where
 * cross-currency summation is correct — and it is correct precisely because the
 * conversion is a stored, frozen, per-line fact rather than a report-time
 * guess. Under the USD-only answer `functional_amount` equals `amount` on every
 * row; the queries are written against the functional column anyway, so that
 * enabling a second currency changes no report.
 *
 * ## The entity filter, and the trap
 *
 * An entity-filtered **profit and loss** is exactly what ADR-0017 promised: one
 * book, one chart, and each operating identity still gets its own income
 * statement, because every revenue and expense line carries
 * `economic_entity_id`.
 *
 * An entity-filtered **trial balance or balance sheet** is only meaningful when
 * EVERY line in the book carries the dimension — including the ones nobody
 * thinks about, like the opening bank balance and equity contributions. Filter
 * a partially-dimensioned book and assets will not equal liabilities plus
 * equity, and the report will look like a bug in the accounting rather than a
 * gap in the data. {@link LedgerReports.entityDimensionCoverage} is what a
 * caller checks before offering one, and `accounting_books.requires_entity_dimension`
 * is what an installation sets when it intends to.
 */
import type { LoxepDb } from "@loxep/db";
import type { LedgerAccountType } from "@loxep/db/schema";
import { sumDecimals } from "./decimal.ts";
import { dateLiteral, textList, textLiteral, uuidLiteral } from "./sql.ts";

/** Entry statuses whose lines are in the books. */
const IN_THE_BOOKS = ["posted", "reversed"];

export interface TrialBalanceRow {
  ledgerAccountId: string;
  code: string;
  name: string;
  accountType: LedgerAccountType;
  accountSubtype: string | null;
  isContra: boolean;
  systemKey: string | null;
  /** `sum(functional_amount)`, signed: positive is a net debit. */
  balance: string;
  debit: string;
  credit: string;
  lineCount: number;
}

export interface TrialBalance {
  accountingBookId: string;
  functionalCurrency: string;
  rows: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  /** Zero for a healthy book. Non-zero is a bug in this code, not in the data. */
  difference: string;
}

export interface AccountBalance {
  ledgerAccountId: string;
  code: string;
  name: string;
  accountType: LedgerAccountType;
  isContra: boolean;
  normalBalance: "debit" | "credit";
  functionalCurrency: string;
  balance: string;
  debit: string;
  credit: string;
  lineCount: number;
}

export interface AccountActivityRow {
  journalLineId: string;
  journalEntryId: string;
  entryNumber: number | null;
  entryDate: string;
  entryStatus: string;
  description: string | null;
  economicEntityId: string | null;
  currency: string;
  amount: string;
  functionalAmount: string;
}

export interface LedgerReportFilter {
  /** Inclusive calendar-date bounds on `journal_entries.entry_date`. */
  from?: string;
  to?: string;
  /** The reporting slice ADR-0017 promises. See the module note about the trap. */
  economicEntityId?: string;
  /** Include archived accounts that still carry lines. Default true — history does not disappear. */
  includeArchivedAccounts?: boolean;
  /** Include accounts with no activity in the window. Default false. */
  includeEmptyAccounts?: boolean;
}

export interface LedgerReports {
  trialBalance: (
    accountingBookId: string,
    filter?: LedgerReportFilter,
  ) => Promise<TrialBalance>;
  accountBalance: (input: {
    accountingBookId: string;
    ledgerAccountId?: string;
    systemKey?: string;
    filter?: LedgerReportFilter;
  }) => Promise<AccountBalance>;
  accountActivity: (input: {
    accountingBookId: string;
    ledgerAccountId?: string;
    systemKey?: string;
    filter?: LedgerReportFilter;
    limit?: number;
  }) => Promise<AccountActivityRow[]>;
  /**
   * How much of a book's posted activity carries the entity dimension.
   *
   * The gate on an entity-filtered balance sheet, expressed as a number rather
   * than a boolean so the caller can say "412 of 418 lines" instead of "no".
   */
  entityDimensionCoverage: (
    accountingBookId: string,
  ) => Promise<{ total: number; withEntity: number; complete: boolean }>;
}

function entryPredicates(filter: LedgerReportFilter | undefined): string[] {
  const predicates = [`e.status in (${textList(IN_THE_BOOKS)})`];
  if (filter?.from !== undefined) {
    predicates.push(`e.entry_date >= ${dateLiteral(filter.from)}`);
  }
  if (filter?.to !== undefined) {
    predicates.push(`e.entry_date <= ${dateLiteral(filter.to)}`);
  }
  if (filter?.economicEntityId !== undefined) {
    predicates.push(
      `l.economic_entity_id = ${uuidLiteral(filter.economicEntityId)}`,
    );
  }
  return predicates;
}

export function createLedgerReports(options: { db: LoxepDb }): LedgerReports {
  const { db } = options;

  async function bookCurrency(accountingBookId: string): Promise<string> {
    const result = await db.execute(
      `select functional_currency from accounting_books
        where id = ${uuidLiteral(accountingBookId)}`,
    );
    return (result.rows[0]?.["functional_currency"] as string | undefined) ?? "";
  }

  function accountPredicate(input: {
    ledgerAccountId?: string;
    systemKey?: string;
  }): string {
    if (input.ledgerAccountId !== undefined) {
      return `a.id = ${uuidLiteral(input.ledgerAccountId)}`;
    }
    if (input.systemKey !== undefined) {
      return `a.system_key = ${textLiteral(input.systemKey)}`;
    }
    throw new Error("name either ledgerAccountId or systemKey");
  }

  return {
    trialBalance: async (accountingBookId, filter) => {
      const accountPredicates = [
        `a.accounting_book_id = ${uuidLiteral(accountingBookId)}`,
      ];
      if (filter?.includeArchivedAccounts === false) {
        accountPredicates.push(`a.status = 'active'`);
      }
      if (filter?.includeEmptyAccounts !== true) {
        accountPredicates.push("agg.ledger_account_id is not null");
      }
      // The aggregate is a SUBQUERY joined onto the chart rather than a join
      // filtered in a `where` clause: with a left join, an entry predicate in
      // the `on` clause leaves the LINE attached while dropping its entry, and
      // a draft's amounts would silently reach the totals.
      const result = await db.execute(
        `select a.id::text as id, a.code, a.name, a.account_type,
                a.account_subtype, a.is_contra, a.system_key,
                coalesce(agg.balance, 0)::numeric(20, 6)::text as balance,
                coalesce(agg.debit, 0)::numeric(20, 6)::text as debit,
                coalesce(agg.credit, 0)::numeric(20, 6)::text as credit,
                coalesce(agg.line_count, 0)::text as line_count
           from ledger_accounts a
           left join (
             select l.ledger_account_id,
                    sum(l.functional_amount) as balance,
                    sum(greatest(l.functional_amount, 0)) as debit,
                    sum(greatest(-l.functional_amount, 0)) as credit,
                    count(*) as line_count
               from journal_lines l
               join journal_entries e on e.id = l.journal_entry_id
              where l.accounting_book_id = ${uuidLiteral(accountingBookId)}
                and ${entryPredicates(filter).join(" and ")}
              group by l.ledger_account_id
           ) agg on agg.ledger_account_id = a.id
          where ${accountPredicates.join(" and ")}
          order by a.code`,
      );

      const rows: TrialBalanceRow[] = result.rows.map((row) => ({
        ledgerAccountId: row["id"] as string,
        code: row["code"] as string,
        name: row["name"] as string,
        accountType: row["account_type"] as LedgerAccountType,
        accountSubtype: (row["account_subtype"] as string | null) ?? null,
        isContra: row["is_contra"] as boolean,
        systemKey: (row["system_key"] as string | null) ?? null,
        balance: row["balance"] as string,
        debit: row["debit"] as string,
        credit: row["credit"] as string,
        lineCount: Number(row["line_count"]),
      }));

      const totalDebit = sumDecimals(rows.map((row) => row.debit));
      const totalCredit = sumDecimals(rows.map((row) => row.credit));
      return {
        accountingBookId,
        functionalCurrency: await bookCurrency(accountingBookId),
        rows,
        totalDebit,
        totalCredit,
        // Exact decimal arithmetic, never Number: a trial balance that "looks
        // like zero" is the one number in the product that must actually be it.
        difference: sumDecimals([totalDebit, `-${totalCredit}`]),
      };
    },

    accountBalance: async (input) => {
      const result = await db.execute(
        `select a.id::text as id, a.code, a.name, a.account_type, a.is_contra,
                coalesce(agg.balance, 0)::numeric(20, 6)::text as balance,
                coalesce(agg.debit, 0)::numeric(20, 6)::text as debit,
                coalesce(agg.credit, 0)::numeric(20, 6)::text as credit,
                coalesce(agg.line_count, 0)::text as line_count
           from ledger_accounts a
           left join (
             select l.ledger_account_id,
                    sum(l.functional_amount) as balance,
                    sum(greatest(l.functional_amount, 0)) as debit,
                    sum(greatest(-l.functional_amount, 0)) as credit,
                    count(*) as line_count
               from journal_lines l
               join journal_entries e on e.id = l.journal_entry_id
              where l.accounting_book_id = ${uuidLiteral(input.accountingBookId)}
                and ${entryPredicates(input.filter).join(" and ")}
              group by l.ledger_account_id
           ) agg on agg.ledger_account_id = a.id
          where a.accounting_book_id = ${uuidLiteral(input.accountingBookId)}
            and ${accountPredicate(input)}`,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(
          `no such account in book ${input.accountingBookId}: ` +
            `${input.ledgerAccountId ?? input.systemKey}`,
        );
      }
      const accountType = row["account_type"] as LedgerAccountType;
      const isContra = row["is_contra"] as boolean;
      const natural =
        accountType === "asset" || accountType === "expense"
          ? "debit"
          : "credit";
      return {
        ledgerAccountId: row["id"] as string,
        code: row["code"] as string,
        name: row["name"] as string,
        accountType,
        isContra,
        normalBalance: isContra
          ? natural === "debit"
            ? "credit"
            : "debit"
          : natural,
        functionalCurrency: await bookCurrency(input.accountingBookId),
        balance: row["balance"] as string,
        debit: row["debit"] as string,
        credit: row["credit"] as string,
        lineCount: Number(row["line_count"]),
      };
    },

    accountActivity: async (input) => {
      const limit =
        input.limit === undefined
          ? ""
          : ` limit ${Math.max(1, Math.trunc(input.limit))}`;
      const result = await db.execute(
        `select l.id::text as line_id, e.id::text as entry_id,
                e.entry_number::text as entry_number,
                e.entry_date::text as entry_date, e.status as entry_status,
                coalesce(l.description, e.description) as description,
                l.economic_entity_id::text as economic_entity_id,
                l.currency, l.amount::text as amount,
                l.functional_amount::text as functional_amount
           from journal_lines l
           join journal_entries e on e.id = l.journal_entry_id
           join ledger_accounts a on a.id = l.ledger_account_id
          where l.accounting_book_id = ${uuidLiteral(input.accountingBookId)}
            and ${accountPredicate(input)}
            and ${entryPredicates(input.filter).join(" and ")}
          order by e.entry_date, e.entry_number, l.line_number${limit}`,
      );
      return result.rows.map((row) => ({
        journalLineId: row["line_id"] as string,
        journalEntryId: row["entry_id"] as string,
        entryNumber:
          row["entry_number"] === null ? null : Number(row["entry_number"]),
        entryDate: row["entry_date"] as string,
        entryStatus: row["entry_status"] as string,
        description: (row["description"] as string | null) ?? null,
        economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
        currency: row["currency"] as string,
        amount: row["amount"] as string,
        functionalAmount: row["functional_amount"] as string,
      }));
    },

    entityDimensionCoverage: async (accountingBookId) => {
      const result = await db.execute(
        `select count(*)::text as total,
                count(l.economic_entity_id)::text as with_entity
           from journal_lines l
           join journal_entries e on e.id = l.journal_entry_id
          where l.accounting_book_id = ${uuidLiteral(accountingBookId)}
            and e.status in (${textList(IN_THE_BOOKS)})`,
      );
      const total = Number(result.rows[0]?.["total"] ?? "0");
      const withEntity = Number(result.rows[0]?.["with_entity"] ?? "0");
      return { total, withEntity, complete: total === withEntity };
    },
  };
}
