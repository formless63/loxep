/**
 * Server functions for the Journal section on `/finance/books/$id`
 * (loxep-l49): `@loxep/accounting/journal.ts`'s `JournalService.listEntries`/
 * `getLines`, wired up for the first time — zero callers existed in
 * `apps/web` before this bead.
 *
 * ## READ ONLY, deliberately
 *
 * This file exposes exactly two reads: the entry list and one entry's lines.
 * It does not wrap `postEntry`/`createDraft`/`postDraft`/`voidDraft`/
 * `reverseEntry` — the posting engine (and, later, a dedicated manual-entry
 * surface if the product ever wants one) owns every write to the ledger.
 * `journal.ts`'s own module doc is explicit that posted entries are never
 * edited and deleted drafts are the only mutation path that exists at all;
 * building a "create journal entry" dialog here would invent a second,
 * unreviewed way to touch the double-entry ledger this bead was never asked
 * to build and the design doesn't call for. The book-journal component's own
 * caption repeats this so the constraint is visible in the product, not only
 * in code comments.
 *
 * ## The account filter `JournalEntryFilter` doesn't have
 *
 * `JournalEntryFilter` (`accountingBookId`, `economicEntityId`, `statuses`,
 * `from`, `to`, `limit`) has no account-level predicate — filtering by
 * account would mean filtering by LINE, and `listEntries` returns entries.
 * `fetchJournalEntries` therefore offers period (`from`/`to`) and status
 * filters only; an account filter is not offered because the service has no
 * verb for it and inventing a client-side join over every entry's lines
 * would defeat the whole point of a bounded, filtered read.
 *
 * ## The bounded aggregate this file adds
 *
 * Each entry's total (debit, which equals credit under the balance
 * invariant) is not a column on `journal_entries` — it is `sum(greatest(
 * amount, 0))` over that entry's lines. Computing it per row on the client
 * would mean fetching every entry's lines eagerly (N+1 against a table that
 * can grow arbitrarily large). Instead `fetchJournalEntries` runs ONE extra
 * aggregate query, grouped by `journal_entry_id`, over exactly the (already
 * bounded) set of entries the filter returned — the same "one bounded read,
 * no N+1" posture `partners-functions.ts` documents for its own bulk reads.
 * A single entry's LINES (for the row expander) are fetched only when a row
 * is actually expanded, via `fetchJournalEntryLines`.
 *
 * Role gate: `requireSession` throughout, matching `fetchTrialBalance` — a
 * journal is ordinary product data to read, same as a trial balance.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a calendar date as YYYY-MM-DD');

function uuidLiteral(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new Error('expected a UUID value');
  return `'${parsed.data}'`;
}

function uuidList(values: readonly string[]): string {
  return values.map(uuidLiteral).join(', ');
}

export interface JournalEntryListItemDto {
  id: string;
  entryNumber: number | null;
  entryDate: string;
  status: string;
  entrySource: string;
  description: string;
  memo: string | null;
  sourceFactType: string | null;
  sourceFactId: string | null;
  /** `sum(greatest(amount, 0))` over the entry's lines — equals total credit under the balance invariant. */
  totalAmount: string;
}

const fetchJournalEntriesInput = z.strictObject({
  accountingBookId: z.uuid(),
  from: calendarDate.nullish(),
  to: calendarDate.nullish(),
  statuses: z.array(z.enum(['draft', 'posted', 'reversed', 'void'])).nullish()
});

const JOURNAL_ENTRY_FETCH_LIMIT = 200;

export const fetchJournalEntries = createServerFn({ method: 'GET' })
  .inputValidator(fetchJournalEntriesInput)
  .handler(async ({ data }): Promise<JournalEntryListItemDto[]> => {
    const { requireSession, getAdminServices, getJournalService } = await import('@/server/admin');
    await requireSession();
    const entries = await getJournalService().listEntries({
      accountingBookId: data.accountingBookId,
      from: data.from ?? undefined,
      to: data.to ?? undefined,
      statuses: data.statuses ?? undefined,
      limit: JOURNAL_ENTRY_FETCH_LIMIT
    });
    if (entries.length === 0) return [];

    const { handle } = getAdminServices();
    const ids = entries.map((entry) => entry.id);
    const totals = await handle.db.execute(
      `select journal_entry_id::text as journal_entry_id,
              sum(greatest(amount, 0))::text as total_amount
         from journal_lines
        where journal_entry_id in (${uuidList(ids)})
        group by journal_entry_id`
    );
    const totalByEntry = new Map(
      totals.rows.map((row) => [row['journal_entry_id'] as string, row['total_amount'] as string])
    );

    return entries.map((entry) => ({
      id: entry.id,
      entryNumber: entry.entryNumber,
      entryDate: entry.entryDate,
      status: entry.status,
      entrySource: entry.entrySource,
      description: entry.description,
      memo: entry.memo,
      sourceFactType: entry.sourceFactType,
      sourceFactId: entry.sourceFactId,
      totalAmount: totalByEntry.get(entry.id) ?? '0'
    }));
  });

export interface JournalEntryLineDto {
  id: string;
  lineNumber: number;
  ledgerAccountId: string;
  economicEntityId: string | null;
  description: string | null;
  currency: string;
  amount: string;
}

export const fetchJournalEntryLines = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ journalEntryId: z.uuid() }))
  .handler(async ({ data }): Promise<JournalEntryLineDto[]> => {
    const { requireSession, getJournalService } = await import('@/server/admin');
    await requireSession();
    const lines = await getJournalService().getLines(data.journalEntryId);
    return lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      ledgerAccountId: line.ledgerAccountId,
      economicEntityId: line.economicEntityId,
      description: line.description,
      currency: line.currency,
      amount: line.amount
    }));
  });
