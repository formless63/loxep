import { queryOptions } from '@tanstack/react-query';
import {
  fetchBookDetail,
  fetchBooks,
  fetchSuspenseTrend,
  fetchTrialBalance
} from '@/server/books-functions';
import { fetchLedgerAccounts } from '@/server/ledger-accounts-functions';
import { fetchJournalEntries, fetchJournalEntryLines } from '@/server/journal-functions';

export const booksQuery = queryOptions({
  queryKey: ['finance', 'books'],
  queryFn: () => fetchBooks()
});

export const bookDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ['finance', 'book', id],
    queryFn: () => fetchBookDetail({ data: { id } })
  });

export const trialBalanceQuery = (accountingBookId: string) =>
  queryOptions({
    queryKey: ['finance', 'trial-balance', accountingBookId],
    queryFn: () => fetchTrialBalance({ data: { accountingBookId } })
  });

/** See `fetchSuspenseTrend`'s own doc (loxep-8e2 item 6) — one bounded read, last 12 fiscal periods. */
export const suspenseTrendQuery = (accountingBookId: string) =>
  queryOptions({
    queryKey: ['finance', 'suspense-trend', accountingBookId],
    queryFn: () => fetchSuspenseTrend({ data: { accountingBookId } })
  });

export const ledgerAccountsQuery = (accountingBookId: string) =>
  queryOptions({
    queryKey: ['finance', 'ledger-accounts', accountingBookId],
    queryFn: () => fetchLedgerAccounts({ data: { accountingBookId } })
  });

export interface JournalEntryFilterParams {
  from?: string;
  to?: string;
  statuses?: string[];
}

export const journalEntriesQuery = (accountingBookId: string, filter: JournalEntryFilterParams) =>
  queryOptions({
    queryKey: ['finance', 'journal-entries', accountingBookId, filter],
    queryFn: () =>
      fetchJournalEntries({
        data: {
          accountingBookId,
          from: filter.from ?? null,
          to: filter.to ?? null,
          statuses: (filter.statuses ?? null) as ('draft' | 'posted' | 'reversed' | 'void')[] | null
        }
      })
  });

export const journalEntryLinesQuery = (journalEntryId: string) =>
  queryOptions({
    queryKey: ['finance', 'journal-entry-lines', journalEntryId],
    queryFn: () => fetchJournalEntryLines({ data: { journalEntryId } })
  });
