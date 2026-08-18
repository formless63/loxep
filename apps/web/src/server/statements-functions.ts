/**
 * Server functions for the Statements section on `/finance/books/$id`
 * (loxep-6ea, audit finding A12): `incomeStatement`/`balanceSheet`
 * (`packages/accounting/src/statements.ts`) had zero callers — there was no
 * balance sheet anywhere, and `dashboard-functions.ts` hand-copies this same
 * module's sign convention in raw SQL for its own dashboard band (see that
 * file's module doc for the drift risk, tracked but not fixed by this bead).
 * `LedgerAccountActivity` mounts the trial-balance drill-through the audit
 * named by number: a trial-balance row was previously a dead end.
 *
 * Role gate (ADR-0017): every read here is `requireSession`, matching
 * `books-functions.ts`'s own split — a statement is ordinary product data,
 * not an administrative action.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type {
  AccountActivityRow,
  BalanceSheet,
  IncomeStatement,
  StatementLine,
  StatementSection
} from '@loxep/accounting';

export type { AccountActivityRow, BalanceSheet, IncomeStatement, StatementLine, StatementSection };

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a calendar date as YYYY-MM-DD');

export const fetchIncomeStatement = createServerFn({ method: 'GET' })
  .inputValidator(
    z.strictObject({
      accountingBookId: z.uuid(),
      from: calendarDate,
      to: calendarDate
    })
  )
  .handler(async ({ data }): Promise<IncomeStatement> => {
    const { requireSession, getStatements } = await import('@/server/admin');
    await requireSession();
    return getStatements().incomeStatement({
      accountingBookId: data.accountingBookId,
      from: data.from,
      to: data.to
    });
  });

export const fetchBalanceSheet = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ accountingBookId: z.uuid(), asOf: calendarDate }))
  .handler(async ({ data }): Promise<BalanceSheet> => {
    const { requireSession, getStatements } = await import('@/server/admin');
    await requireSession();
    return getStatements().balanceSheet({
      accountingBookId: data.accountingBookId,
      asOf: data.asOf
    });
  });

/**
 * The trial-balance drill-through the audit named: every posted/reversed
 * journal line for one account, in the book's functional currency.
 */
export const fetchAccountActivity = createServerFn({ method: 'GET' })
  .inputValidator(
    z.strictObject({
      accountingBookId: z.uuid(),
      ledgerAccountId: z.uuid(),
      from: calendarDate.optional(),
      to: calendarDate.optional()
    })
  )
  .handler(async ({ data }): Promise<AccountActivityRow[]> => {
    const { requireSession, getLedgerReports } = await import('@/server/admin');
    await requireSession();
    return getLedgerReports().accountActivity({
      accountingBookId: data.accountingBookId,
      ledgerAccountId: data.ledgerAccountId,
      filter: {
        ...(data.from === undefined ? {} : { from: data.from }),
        ...(data.to === undefined ? {} : { to: data.to })
      },
      limit: 500
    });
  });
