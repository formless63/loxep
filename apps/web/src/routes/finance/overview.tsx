import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { formatQuantity } from '@/lib/format';
import { FinancePage } from '@/features/finance/components/finance-page';
import {
  MissingReceiptsList,
  UnallocatedExpensesList
} from '@/features/finance/components/expense-reports';
import PushDraftInvoiceDialog from '@/features/finance/components/push-draft-invoice-dialog';
import PostingCard from '@/features/finance/components/posting-card';
import {
  invoiceNinjaConnectionsQuery,
  missingReceiptsQuery,
  unallocatedExpensesQuery
} from '@/features/finance/api/queries';

export const Route = createFileRoute('/finance/overview')({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(missingReceiptsQuery),
      queryClient.ensureQueryData(unallocatedExpensesQuery)
    ]);
  },
  component: FinanceOverview
});

function OverviewSkeleton() {
  return (
    <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
      <Skeleton className='h-64 w-full' />
      <Skeleton className='h-64 w-full' />
    </div>
  );
}

/**
 * Reports render straight from `@loxep/accounting`'s shipped read models —
 * `ReceiptsService.missingReceipts` and `ExpenseReports.unallocatedExpenses`
 * — which had no caller before this page (loxep-dgf.1 acceptance).
 *
 * The dashboard's Financial band, not this page, is where a recorded
 * expense's dollar amount reaches a statement — this page only ever counts
 * OPERATIONAL gaps (missing paper, an unfinished split), never a total, so
 * nothing here can be mistaken for an accounting figure. Acquisition-cost
 * spend (money that bought goods for resale) does not appear anywhere on
 * this page: it is not an expense, and posting it is a later milestone's gap
 * (see the design's "the weave").
 */
function OverviewData() {
  const { data: missingReceipts } = useSuspenseQuery(missingReceiptsQuery);
  const { data: unallocated } = useSuspenseQuery(unallocatedExpensesQuery);

  return (
    <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Missing receipts</CardTitle>
          <CardDescription>
            {formatQuantity(missingReceipts.length)} recorded expense
            {missingReceipts.length === 1 ? '' : 's'} with no receipt, invoice, or supporting
            document attached.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MissingReceiptsList rows={missingReceipts} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Unallocated expenses</CardTitle>
          <CardDescription>
            {formatQuantity(unallocated.length)} expense{unallocated.length === 1 ? '' : 's'} whose
            splits don't yet add up to the full amount.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UnallocatedExpensesList rows={unallocated} />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The "Push draft to Invoice Ninja" action (loxep-v5r.5) only appears once at
 * least one `provider='invoiceninja'` connection exists — there is nothing
 * useful to push to otherwise, and the connection picker inside the dialog
 * would just show its own empty state.
 */
function InvoiceNinjaPushAction() {
  const connectionsQuery = useQuery(invoiceNinjaConnectionsQuery);
  const [open, setOpen] = React.useState(false);

  if ((connectionsQuery.data ?? []).length === 0) return null;

  return (
    <>
      <Button variant='outline' size='sm' onClick={() => setOpen(true)}>
        <Icons.send />
        Push draft to Invoice Ninja
      </Button>
      <PushDraftInvoiceDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function FinanceOverview() {
  const { auth } = Route.useRouteContext();
  const isAdmin = auth?.roles.includes('admin') ?? false;

  return (
    <FinancePage
      title='Finance'
      description='Expense capture, receipts, and the expense reports. Money spent on goods for resale is not an expense — it belongs to the acquisition, arriving in a later milestone.'
      actions={<InvoiceNinjaPushAction />}
    >
      <div className='flex flex-col gap-4'>
        <React.Suspense fallback={<OverviewSkeleton />}>
          <OverviewData />
        </React.Suspense>
        {/* Own query/skeleton/error boundary — a genuinely independent data
            source from the receipts/unallocated pair above (Frontend
            Standards, "one boundary per data source"). */}
        <PostingCard isAdmin={isAdmin} />
      </div>
    </FinancePage>
  );
}
