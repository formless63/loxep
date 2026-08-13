import { queryOptions } from '@tanstack/react-query';
import { fetchBookDetail, fetchBooks, fetchTrialBalance } from '@/server/books-functions';

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
