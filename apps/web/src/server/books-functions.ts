/**
 * Server functions for `/finance/books` (loxep-cmo): accounting books, the
 * effective-dated entity-to-book link and its roll-up rule, fiscal-year
 * generation, period open/close/reopen, and the trial balance.
 *
 * All of it sits directly over `@loxep/accounting`'s `books.ts`/`periods.ts`/
 * `ledger-reports.ts` — the same "services shipped complete with zero
 * callers" situation `expense-functions.ts` documents for `expenses.ts`.
 * `createBook` in particular is a THIN pass-through: the service itself
 * composes the book row, the code-owned starter chart
 * (`seedDefaultChart`), and the first fiscal year
 * (`generateFiscalYear`) inside one call when `seedChart`/`generatePeriods`
 * default `true`, precisely so this surface never has to remember the right
 * order. This file does not seed the chart or generate the first year
 * itself — asking `createBook` to do both is the intended composition.
 *
 * Role gate, per ADR-0017: reads are `requireSession` (any authenticated
 * member — a trial balance is ordinary product data); every write here is
 * `requireAdmin` — creating a book, linking/unlinking an entity, and closing
 * or reopening a period are administrative actions on the ledger itself, not
 * ordinary operator work the way recording an expense is.
 *
 * Handlers dynamically import `@/server/admin` so `@loxep/accounting` stays
 * out of the client bundle, matching `expense-functions.ts`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a calendar date as YYYY-MM-DD');

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface BookCurrentPeriodDto {
  code: string;
  status: string;
}

export interface BookListItemDto {
  id: string;
  code: string;
  name: string;
  functionalCurrency: string;
  accountingBasis: string;
  status: string;
  /** Entity links whose effective range covers today — the roll-up an operator can see right now. */
  activeEntityLinkCount: number;
  periodCount: number;
  /** The fiscal period covering today, or null when none has been generated for it. */
  currentPeriod: BookCurrentPeriodDto | null;
}

export const fetchBooks = createServerFn({ method: 'GET' }).handler(
  async (): Promise<BookListItemDto[]> => {
    const { requireSession, getBooksService, getFiscalPeriodsService } =
      await import('@/server/admin');
    await requireSession();
    const booksService = getBooksService();
    const periodsService = getFiscalPeriodsService();
    const today = new Date().toISOString().slice(0, 10);

    const books = await booksService.listBooks({ includeArchived: true });
    return Promise.all(
      books.map(async (book): Promise<BookListItemDto> => {
        const [links, periods] = await Promise.all([
          booksService.listLinks({ accountingBookId: book.id }),
          periodsService.listPeriods(book.id)
        ]);
        const activeEntityLinkCount = links.filter(
          (link) =>
            link.effectiveFrom <= today && (link.effectiveTo === null || link.effectiveTo >= today)
        ).length;
        const current = periods.find(
          (period) => period.startsOn <= today && period.endsOn >= today
        );
        return {
          id: book.id,
          code: book.code,
          name: book.name,
          functionalCurrency: book.functionalCurrency,
          accountingBasis: book.accountingBasis,
          status: book.status,
          activeEntityLinkCount,
          periodCount: periods.length,
          currentPeriod: current ? { code: current.periodCode, status: current.status } : null
        };
      })
    );
  }
);

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface BookEntityLinkDto {
  id: string;
  economicEntityId: string;
  entityName: string;
  linkRole: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  dimensionLabel: string | null;
  note: string | null;
}

export interface FiscalPeriodDto {
  id: string;
  periodCode: string;
  fiscalYear: number;
  sequence: number;
  startsOn: string;
  endsOn: string;
  status: string;
  note: string | null;
}

export interface BookDetailDto {
  id: string;
  code: string;
  name: string;
  functionalCurrency: string;
  accountingBasis: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  requiresEntityDimension: boolean;
  status: string;
  openedOn: string;
  notes: string | null;
  links: BookEntityLinkDto[];
  periods: FiscalPeriodDto[];
}

export const fetchBookDetail = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<BookDetailDto> => {
    const { requireSession, getBooksService, getFiscalPeriodsService, getAdminServices } =
      await import('@/server/admin');
    await requireSession();
    const booksService = getBooksService();
    const [book, links, periods] = await Promise.all([
      booksService.getBook(data.id),
      booksService.listLinks({ accountingBookId: data.id }),
      getFiscalPeriodsService().listPeriods(data.id)
    ]);

    const { handle } = getAdminServices();
    const entityIds = [...new Set(links.map((link) => link.economicEntityId))];
    const entities =
      entityIds.length === 0
        ? []
        : await handle.db.query.economicEntities.findMany({
            where: (table, { inArray }) => inArray(table.id, entityIds)
          });
    const nameById = new Map(entities.map((entity) => [entity.id, entity.name]));

    return {
      id: book.id,
      code: book.code,
      name: book.name,
      functionalCurrency: book.functionalCurrency,
      accountingBasis: book.accountingBasis,
      fiscalYearStartMonth: book.fiscalYearStartMonth,
      fiscalYearStartDay: book.fiscalYearStartDay,
      requiresEntityDimension: book.requiresEntityDimension,
      status: book.status,
      openedOn: book.openedOn,
      notes: book.notes,
      links: links.map((link) => ({
        id: link.id,
        economicEntityId: link.economicEntityId,
        entityName: nameById.get(link.economicEntityId) ?? link.economicEntityId,
        linkRole: link.linkRole,
        effectiveFrom: link.effectiveFrom,
        effectiveTo: link.effectiveTo,
        dimensionLabel: link.dimensionLabel,
        note: link.note
      })),
      // `listPeriods` already orders by `startsOn` ascending
      // (`@loxep/accounting/periods.ts`), so no re-sort is needed here.
      periods: periods.map((period) => ({
        id: period.id,
        periodCode: period.periodCode,
        fiscalYear: period.fiscalYear,
        sequence: period.sequence,
        startsOn: period.startsOn,
        endsOn: period.endsOn,
        status: period.status,
        note: period.note
      }))
    };
  });

// ---------------------------------------------------------------------------
// Create / archive
// ---------------------------------------------------------------------------

const createBookInput = z.strictObject({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  openedOn: calendarDate,
  accountingBasis: z.enum(['cash', 'accrual']).default('accrual'),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  fiscalYearStartDay: z.number().int().min(1).max(31).default(1),
  requiresEntityDimension: z.boolean().default(false),
  notes: z.string().trim().min(1).nullish()
});

export interface CreateBookResultDto {
  id: string;
  code: string;
  accountCount: number;
  periodCount: number;
}

export const createBook = createServerFn({ method: 'POST' })
  .inputValidator(createBookInput)
  .handler(async ({ data }): Promise<CreateBookResultDto> => {
    const { requireAdmin, getBooksService } = await import('@/server/admin');
    const session = await requireAdmin();
    // `functionalCurrency` is deliberately omitted: the service defaults it
    // to `DEFAULT_FUNCTIONAL_CURRENCY` (USD), which is the only currency this
    // build accepts (`@loxep/accounting/currency.ts`, owner answer 3). The
    // multi-currency seam already lives in the schema (`journal_lines`'
    // transaction-vs-functional columns) and is unused; this surface does not
    // pretend otherwise by offering a picker with one option.
    // `seedChart`/`generatePeriods` are left at their service defaults
    // (`true`): `createBook` composes the starter chart and the first fiscal
    // year itself, in that order, as two separate idempotent transactions.
    const { book, accountCount, periodCount } = await getBooksService().createBook({
      code: data.code,
      name: data.name,
      openedOn: data.openedOn,
      accountingBasis: data.accountingBasis,
      fiscalYearStartMonth: data.fiscalYearStartMonth,
      fiscalYearStartDay: data.fiscalYearStartDay,
      requiresEntityDimension: data.requiresEntityDimension,
      notes: data.notes ?? null,
      createdByUserId: session.user.id
    });
    return { id: book.id, code: book.code, accountCount, periodCount };
  });

export const archiveBook = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ accountingBookId: z.uuid() }))
  .handler(async ({ data }): Promise<{ status: string }> => {
    const { requireAdmin, getBooksService } = await import('@/server/admin');
    const session = await requireAdmin();
    const after = await getBooksService().archiveBook({
      accountingBookId: data.accountingBookId,
      actorUserId: session.user.id
    });
    return { status: after.status };
  });

// ---------------------------------------------------------------------------
// Entity links — the roll-up rule's UI surface
// ---------------------------------------------------------------------------

const linkEntityInput = z.strictObject({
  accountingBookId: z.uuid(),
  economicEntityId: z.uuid(),
  linkRole: z.enum(['posting_primary', 'reporting_only']),
  effectiveFrom: calendarDate,
  effectiveTo: calendarDate.nullish(),
  dimensionLabel: z.string().trim().min(1).nullish(),
  note: z.string().trim().min(1).nullish()
});

export const linkEntity = createServerFn({ method: 'POST' })
  .inputValidator(linkEntityInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getBooksService } = await import('@/server/admin');
    const session = await requireAdmin();
    const link = await getBooksService().linkEntity({
      accountingBookId: data.accountingBookId,
      economicEntityId: data.economicEntityId,
      linkRole: data.linkRole,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo ?? null,
      dimensionLabel: data.dimensionLabel ?? null,
      note: data.note ?? null,
      createdByUserId: session.user.id
    });
    return { id: link.id };
  });

export const endEntityLink = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ bookEntityLinkId: z.uuid(), effectiveTo: calendarDate }))
  .handler(async ({ data }): Promise<{ id: string; effectiveTo: string | null }> => {
    const { requireAdmin, getBooksService } = await import('@/server/admin');
    const session = await requireAdmin();
    const after = await getBooksService().endLink({
      bookEntityLinkId: data.bookEntityLinkId,
      effectiveTo: data.effectiveTo,
      actorUserId: session.user.id
    });
    return { id: after.id, effectiveTo: after.effectiveTo };
  });

// ---------------------------------------------------------------------------
// Fiscal years and periods
// ---------------------------------------------------------------------------

export const generateFiscalYear = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({ accountingBookId: z.uuid(), fiscalYear: z.number().int().min(1900).max(9999) })
  )
  .handler(async ({ data }): Promise<{ created: number; periodCount: number }> => {
    const { requireAdmin, getFiscalPeriodsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const result = await getFiscalPeriodsService().generateFiscalYear({
      accountingBookId: data.accountingBookId,
      fiscalYear: data.fiscalYear,
      actorUserId: session.user.id
    });
    return { created: result.created, periodCount: result.periods.length };
  });

/**
 * Covers open→soft_closed/closed/locked (Close) and any of those back to
 * open (Reopen) — `@loxep/accounting`'s `setStatus` refuses `locked` and a
 * no-op on the current status is a safe no-write return, so one function
 * covers every transition the UI offers.
 */
export const setPeriodStatus = createServerFn({ method: 'POST' })
  .inputValidator(
    z.strictObject({
      fiscalPeriodId: z.uuid(),
      status: z.enum(['open', 'soft_closed', 'closed', 'locked']),
      note: z.string().trim().min(1).nullish()
    })
  )
  .handler(async ({ data }): Promise<{ status: string }> => {
    const { requireAdmin, getFiscalPeriodsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const after = await getFiscalPeriodsService().setStatus({
      fiscalPeriodId: data.fiscalPeriodId,
      status: data.status,
      note: data.note ?? null,
      actorUserId: session.user.id
    });
    return { status: after.status };
  });

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export interface TrialBalanceRowDto {
  ledgerAccountId: string;
  code: string;
  name: string;
  accountType: string;
  accountSubtype: string | null;
  isContra: boolean;
  systemKey: string | null;
  balance: string;
  debit: string;
  credit: string;
  lineCount: number;
}

export interface TrialBalanceDto {
  accountingBookId: string;
  functionalCurrency: string;
  rows: TrialBalanceRowDto[];
  totalDebit: string;
  totalCredit: string;
  difference: string;
}

export const fetchTrialBalance = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ accountingBookId: z.uuid() }))
  .handler(async ({ data }): Promise<TrialBalanceDto> => {
    const { requireSession, getLedgerReports } = await import('@/server/admin');
    await requireSession();
    // `includeEmptyAccounts: true` — unlike `ledger-reports.ts`'s own default,
    // an admin trial balance should show the whole chart a freshly seeded
    // book carries, not disappear entirely until the first posting.
    return getLedgerReports().trialBalance(data.accountingBookId, {
      includeEmptyAccounts: true
    });
  });
