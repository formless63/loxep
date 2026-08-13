/**
 * The two statements: income statement and balance sheet.
 *
 * Read models in this package, **not database views**. Volumes are small, the
 * shapes will change, and a view definition inside a migration hides business
 * logic from the type system and the test suite. Both are built on the same
 * `sum(functional_amount)` grouping the trial balance uses, so a statement can
 * never disagree with the trial balance about what is in the books:
 *
 * ```text
 * draft     excluded
 * void      excluded
 * posted    INCLUDED
 * reversed  INCLUDED — its lines are untouched and its reversal's lines are
 *           what net them out. Excluding either half would leave every total
 *           wrong by exactly the amount of the correction.
 * ```
 *
 * ## Signs, once, here
 *
 * `journal_lines.amount` is signed: positive is a debit. Revenue and liability
 * accounts therefore carry NEGATIVE balances, and every figure a human reads on
 * a statement is a presentation flip of that one column:
 *
 * ```text
 * revenue line   -sum(functional_amount)      credits are positive income
 * expense line    sum(functional_amount)      debits are positive cost
 * net income     revenue - expense  ==  -(sum over revenue AND expense lines)
 * asset          sum(functional_amount)
 * liability      -sum(functional_amount)
 * equity         -sum(functional_amount)
 * ```
 *
 * A contra account (`sales_returns`) is NOT flipped again: it is a negative
 * revenue by construction, and flipping it twice is the classic way a returns
 * figure ends up increasing revenue.
 *
 * ## Retained earnings is computed, never stored
 *
 * There are no closing entries and no retained-earnings account. The balance
 * sheet computes:
 *
 * ```text
 * retained earnings   net income of every fiscal year BEFORE the one `asOf`
 *                     falls in
 * current earnings    net income of the current fiscal year, up to `asOf`
 * ```
 *
 * Storing closing entries would double a small book's entry count, make the
 * trial balance depend on whether a close job had run, and need reversing every
 * time a prior year is legitimately corrected. The cost is that "equity" on this
 * statement is three numbers rather than one — which is more informative anyway.
 *
 * ## The balance sheet balances, or the report says so
 *
 * `difference` is `assets − (liabilities + equity)` in exact decimal
 * arithmetic. It is zero for every book whose entries are balanced, because the
 * signed column makes that an algebraic identity rather than a coincidence — the
 * sum of every line in the book is zero, and this report only partitions those
 * lines by `account_type`. A non-zero difference means a line reached the table
 * without going through the journal service AND without tripping the deferred
 * balance trigger, which is worth surfacing rather than hiding.
 *
 * ## The entity filter, and the trap the design names
 *
 * An entity-filtered income statement is exactly what ADR-0017 promised. An
 * entity-filtered BALANCE SHEET is only meaningful when every line in the book
 * carries the entity — including the opening bank balance and equity
 * contributions nobody thinks about — so it is gated on
 * `accounting_books.requires_entity_dimension` AND on complete coverage, and
 * refused with the reason otherwise. A plausible statement that does not balance
 * is worse than an honest refusal.
 */
import type { LoxepDb } from "@loxep/db";
import type { LedgerAccountType } from "@loxep/db/schema";
import { negateDecimal, sumDecimals } from "./decimal.ts";
import { AccountingNotFoundError, AccountingValidationError } from "./errors.ts";
import { fiscalYearFor, fiscalYearStartDate } from "./periods.ts";
import { dateLiteral, textList, uuidLiteral } from "./sql.ts";

/** Entry statuses whose lines are in the books. */
const IN_THE_BOOKS = ["posted", "reversed"];

export interface StatementLine {
  ledgerAccountId: string;
  code: string;
  name: string;
  accountType: LedgerAccountType;
  accountSubtype: string | null;
  isContra: boolean;
  systemKey: string | null;
  /** Presentation-signed: positive is the direction a reader expects. */
  amount: string;
}

export interface StatementSection {
  lines: StatementLine[];
  total: string;
}

export interface IncomeStatement {
  accountingBookId: string;
  functionalCurrency: string;
  from: string;
  to: string;
  economicEntityId: string | null;
  revenue: StatementSection;
  expense: StatementSection;
  /** Revenue − expense, in the book's functional currency. */
  netIncome: string;
}

export interface BalanceSheet {
  accountingBookId: string;
  functionalCurrency: string;
  asOf: string;
  economicEntityId: string | null;
  assets: StatementSection;
  liabilities: StatementSection;
  /** Contributed/opening equity only — the accounts that exist as rows. */
  equityAccounts: StatementSection;
  /** Net income of every fiscal year before the one `asOf` falls in. */
  retainedEarnings: string;
  /** Net income of the current fiscal year, through `asOf`. */
  currentEarnings: string;
  /** `equityAccounts.total + retainedEarnings + currentEarnings`. */
  totalEquity: string;
  /** `assets − (liabilities + equity)`. Zero for a healthy book. */
  difference: string;
  balanced: boolean;
}

export interface StatementFilter {
  economicEntityId?: string;
  /** Include accounts with no activity in the window. Default false. */
  includeEmptyAccounts?: boolean;
}

export interface Statements {
  incomeStatement: (input: {
    accountingBookId: string;
    from: string;
    to: string;
    filter?: StatementFilter;
  }) => Promise<IncomeStatement>;
  balanceSheet: (input: {
    accountingBookId: string;
    asOf: string;
    filter?: StatementFilter;
  }) => Promise<BalanceSheet>;
}

interface BookMeta {
  code: string;
  functionalCurrency: string;
  requiresEntityDimension: boolean;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
}

export function createStatements(options: { db: LoxepDb }): Statements {
  const { db } = options;

  async function loadBook(accountingBookId: string): Promise<BookMeta> {
    const result = await db.execute(
      `select code, functional_currency, requires_entity_dimension,
              fiscal_year_start_month, fiscal_year_start_day
         from accounting_books where id = ${uuidLiteral(accountingBookId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AccountingNotFoundError(
        `unknown accounting book "${accountingBookId}"`,
      );
    }
    return {
      code: row["code"] as string,
      functionalCurrency: row["functional_currency"] as string,
      requiresEntityDimension: row["requires_entity_dimension"] as boolean,
      fiscalYearStartMonth: Number(row["fiscal_year_start_month"]),
      fiscalYearStartDay: Number(row["fiscal_year_start_day"]),
    };
  }

  function entryPredicates(input: {
    from?: string;
    to?: string;
    economicEntityId?: string;
  }): string {
    const predicates = [`e.status in (${textList(IN_THE_BOOKS)})`];
    if (input.from !== undefined) {
      predicates.push(`e.entry_date >= ${dateLiteral(input.from)}`);
    }
    if (input.to !== undefined) {
      predicates.push(`e.entry_date <= ${dateLiteral(input.to)}`);
    }
    if (input.economicEntityId !== undefined) {
      predicates.push(
        `l.economic_entity_id = ${uuidLiteral(input.economicEntityId)}`,
      );
    }
    return predicates.join(" and ");
  }

  /** `sum(functional_amount)` per account, for one window and one book. */
  async function balancesByAccount(input: {
    accountingBookId: string;
    accountTypes: readonly LedgerAccountType[];
    from?: string;
    to?: string;
    economicEntityId?: string;
    includeEmptyAccounts: boolean;
  }): Promise<StatementLine[]> {
    const accountPredicates = [
      `a.accounting_book_id = ${uuidLiteral(input.accountingBookId)}`,
      `a.account_type in (${textList(input.accountTypes)})`,
      "a.is_postable = true",
    ];
    if (!input.includeEmptyAccounts) {
      accountPredicates.push("agg.ledger_account_id is not null");
    }
    // The aggregate is a SUBQUERY joined onto the chart, never a filtered left
    // join: an entry predicate in an `on` clause leaves the LINE attached while
    // dropping its entry, and a draft's amounts would silently reach a total.
    const result = await db.execute(
      `select a.id::text as id, a.code, a.name, a.account_type,
              a.account_subtype, a.is_contra, a.system_key,
              coalesce(agg.balance, 0)::numeric(20, 6)::text as balance
         from ledger_accounts a
         left join (
           select l.ledger_account_id,
                  sum(l.functional_amount) as balance
             from journal_lines l
             join journal_entries e on e.id = l.journal_entry_id
            where l.accounting_book_id = ${uuidLiteral(input.accountingBookId)}
              and ${entryPredicates(input)}
            group by l.ledger_account_id
         ) agg on agg.ledger_account_id = a.id
        where ${accountPredicates.join(" and ")}
        order by a.code`,
    );
    return result.rows.map((row) => ({
      ledgerAccountId: row["id"] as string,
      code: row["code"] as string,
      name: row["name"] as string,
      accountType: row["account_type"] as LedgerAccountType,
      accountSubtype: (row["account_subtype"] as string | null) ?? null,
      isContra: row["is_contra"] as boolean,
      systemKey: (row["system_key"] as string | null) ?? null,
      amount: row["balance"] as string,
    }));
  }

  /** Revenue and expense lines net to `-(net income)` because debits are positive. */
  async function netIncomeBetween(input: {
    accountingBookId: string;
    from?: string;
    to: string;
    economicEntityId?: string;
  }): Promise<string> {
    const result = await db.execute(
      `select coalesce(sum(l.functional_amount), 0)::numeric(20, 6)::text as total
         from journal_lines l
         join journal_entries e on e.id = l.journal_entry_id
         join ledger_accounts a on a.id = l.ledger_account_id
        where l.accounting_book_id = ${uuidLiteral(input.accountingBookId)}
          and a.account_type in ('revenue', 'expense')
          and ${entryPredicates(input)}`,
    );
    return negateDecimal((result.rows[0]?.["total"] as string | undefined) ?? "0");
  }

  function section(
    lines: StatementLine[],
    flip: boolean,
  ): StatementSection {
    const presented = lines.map((line) => ({
      ...line,
      amount: flip ? negateDecimal(line.amount) : line.amount,
    }));
    return {
      lines: presented,
      total: sumDecimals(presented.map((line) => line.amount)),
    };
  }

  return {
    incomeStatement: async (input) => {
      const book = await loadBook(input.accountingBookId);
      const common = {
        accountingBookId: input.accountingBookId,
        from: input.from,
        to: input.to,
        includeEmptyAccounts: input.filter?.includeEmptyAccounts === true,
        ...(input.filter?.economicEntityId === undefined
          ? {}
          : { economicEntityId: input.filter.economicEntityId }),
      };
      const revenue = section(
        await balancesByAccount({ ...common, accountTypes: ["revenue"] }),
        true,
      );
      const expense = section(
        await balancesByAccount({ ...common, accountTypes: ["expense"] }),
        false,
      );
      return {
        accountingBookId: input.accountingBookId,
        functionalCurrency: book.functionalCurrency,
        from: input.from,
        to: input.to,
        economicEntityId: input.filter?.economicEntityId ?? null,
        revenue,
        expense,
        netIncome: sumDecimals([revenue.total, negateDecimal(expense.total)]),
      };
    },

    balanceSheet: async (input) => {
      const book = await loadBook(input.accountingBookId);
      const entityId = input.filter?.economicEntityId;

      if (entityId !== undefined) {
        // The design's own gate, both halves of it.
        if (!book.requiresEntityDimension) {
          throw new AccountingValidationError(
            `book ${book.code} does not require the entity dimension, so an ` +
              "entity-filtered balance sheet cannot be trusted to balance: " +
              "the lines nobody thinks about (an opening bank balance, an " +
              "equity contribution) carry no entity and would silently drop " +
              "out. The entity-filtered INCOME STATEMENT is meaningful and is " +
              "what ADR-0017 promises; this one is offered only for a book " +
              "that requires the dimension.",
          );
        }
        const coverage = await db.execute(
          `select count(*)::text as total,
                  count(l.economic_entity_id)::text as with_entity
             from journal_lines l
             join journal_entries e on e.id = l.journal_entry_id
            where l.accounting_book_id = ${uuidLiteral(input.accountingBookId)}
              and e.status in (${textList(IN_THE_BOOKS)})`,
        );
        const total = Number(coverage.rows[0]?.["total"] ?? "0");
        const withEntity = Number(coverage.rows[0]?.["with_entity"] ?? "0");
        if (total !== withEntity) {
          throw new AccountingValidationError(
            `book ${book.code} has ${total - withEntity} of ${total} posted ` +
              "lines without an entity: an entity-filtered balance sheet over " +
              "them would not balance, and would look like a bug in the " +
              "accounting rather than a gap in the data",
          );
        }
      }

      const common = {
        accountingBookId: input.accountingBookId,
        to: input.asOf,
        includeEmptyAccounts: input.filter?.includeEmptyAccounts === true,
        ...(entityId === undefined ? {} : { economicEntityId: entityId }),
      };
      const assets = section(
        await balancesByAccount({ ...common, accountTypes: ["asset"] }),
        false,
      );
      const liabilities = section(
        await balancesByAccount({ ...common, accountTypes: ["liability"] }),
        true,
      );
      const equityAccounts = section(
        await balancesByAccount({ ...common, accountTypes: ["equity"] }),
        true,
      );

      // The fiscal year `asOf` falls in, from the book's own start month/day —
      // a January year is an assumption, not a fact.
      const yearStart = fiscalYearStartDate(
        fiscalYearFor(
          input.asOf,
          book.fiscalYearStartMonth,
          book.fiscalYearStartDay,
        ),
        book.fiscalYearStartMonth,
        book.fiscalYearStartDay,
      );
      const priorEnd = previousDay(yearStart);
      const retainedEarnings = await netIncomeBetween({
        accountingBookId: input.accountingBookId,
        to: priorEnd,
        ...(entityId === undefined ? {} : { economicEntityId: entityId }),
      });
      const currentEarnings = await netIncomeBetween({
        accountingBookId: input.accountingBookId,
        from: yearStart,
        to: input.asOf,
        ...(entityId === undefined ? {} : { economicEntityId: entityId }),
      });

      const totalEquity = sumDecimals([
        equityAccounts.total,
        retainedEarnings,
        currentEarnings,
      ]);
      const difference = sumDecimals([
        assets.total,
        negateDecimal(liabilities.total),
        negateDecimal(totalEquity),
      ]);
      return {
        accountingBookId: input.accountingBookId,
        functionalCurrency: book.functionalCurrency,
        asOf: input.asOf,
        economicEntityId: entityId ?? null,
        assets,
        liabilities,
        equityAccounts,
        retainedEarnings,
        currentEarnings,
        totalEquity,
        difference,
        balanced: difference === "0.000000",
      };
    },
  };
}

/** The calendar day before an ISO date, without touching a timezone. */
function previousDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  return new Date(utc - 86_400_000).toISOString().slice(0, 10);
}
