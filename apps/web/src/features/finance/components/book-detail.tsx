import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toastError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { bookDetailQuery, booksQuery } from '@/features/finance/api/books-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { archiveBook } from '@/server/books-functions';
import BookAccounts from '@/features/finance/components/book-accounts';
import BookEntityLinks from '@/features/finance/components/book-entity-links';
import BookJournal from '@/features/finance/components/book-journal';
import BookPeriods from '@/features/finance/components/book-periods';
import BookStatements from '@/features/finance/components/book-statements';
import BookTrialBalance from '@/features/finance/components/book-trial-balance';

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-muted-foreground text-xs'>{label}</span>
      <span className='text-sm'>{children}</span>
    </div>
  );
}

function ArchiveBookDialog({
  open,
  onOpenChange,
  bookId,
  code
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookId: string;
  code: string;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => archiveBook({ data: { accountingBookId: bookId } }),
    onSuccess: () => {
      toast.success(`${code} archived`);
      void queryClient.invalidateQueries({ queryKey: bookDetailQuery(bookId).queryKey });
      void queryClient.invalidateQueries({ queryKey: booksQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to archive book')
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {code}?</AlertDialogTitle>
          <AlertDialogDescription>
            An archived book keeps every posted entry and every report exactly as it is — it only
            stops accepting new entity links. There is no delete: history does not disappear.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Archive book
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function BookDetail({ bookId, isAdmin }: { bookId: string; isAdmin: boolean }) {
  const { data, isPending, isError, error, refetch } = useQuery(bookDetailQuery(bookId));
  const [archiveOpen, setArchiveOpen] = React.useState(false);

  if (isPending) {
    return <div className='text-muted-foreground text-sm'>Loading…</div>;
  }

  if (isError) {
    return <QueryErrorAlert error={error} title='Could not load book' onRetry={() => refetch()} />;
  }

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader className='flex flex-row items-start justify-between gap-2'>
          <div>
            <CardTitle className='flex items-center gap-2 text-xl'>
              {data.name}
              <Badge variant={data.status === 'active' ? 'success' : 'outline'}>
                {data.status}
              </Badge>
            </CardTitle>
          </div>
          {data.status === 'active' && (
            <Button size='sm' variant='outline' onClick={() => setArchiveOpen(true)}>
              Archive
            </Button>
          )}
        </CardHeader>
        <CardContent className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
          <DetailRow label='Code'>{data.code}</DetailRow>
          <DetailRow label='Functional currency'>
            <Badge variant='outline'>{data.functionalCurrency}</Badge>
          </DetailRow>
          <DetailRow label='Basis'>{data.accountingBasis}</DetailRow>
          <DetailRow label='Opened on'>{formatDate(data.openedOn)}</DetailRow>
          <DetailRow label='Fiscal year starts'>
            {String(data.fiscalYearStartMonth).padStart(2, '0')}/
            {String(data.fiscalYearStartDay).padStart(2, '0')}
          </DetailRow>
          <DetailRow label='Entity dimension required'>
            {data.requiresEntityDimension ? 'Yes' : 'No'}
          </DetailRow>
          {data.notes && <DetailRow label='Notes'>{data.notes}</DetailRow>}
        </CardContent>
      </Card>

      <BookEntityLinks accountingBookId={bookId} links={data.links} />
      <BookPeriods accountingBookId={bookId} periods={data.periods} />
      <BookAccounts accountingBookId={bookId} isAdmin={isAdmin} />
      <BookStatements accountingBookId={bookId} periods={data.periods} />
      <BookTrialBalance accountingBookId={bookId} />
      <BookJournal accountingBookId={bookId} functionalCurrency={data.functionalCurrency} />

      <ArchiveBookDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        bookId={bookId}
        code={data.code}
      />
    </div>
  );
}
