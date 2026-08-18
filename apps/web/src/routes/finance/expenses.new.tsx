import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { FinancePage } from '@/features/finance/components/finance-page';
import NewExpensePage from '@/features/finance/components/new-expense-page';
import { entitiesQuery } from '@/features/settings/api/queries';
import { expenseQuery } from '@/features/finance/api/queries';

/**
 * `/finance/expenses/new` — the real two-pane entry page (loxep-cd3.2, M2 —
 * `expense-entry-design.md` section 1) and, since the OWNER REVERSAL
 * (2026-08-17, decision 1), the ONLY expense-entry path — the one-screen
 * quick-entry dialog is removed. Every field here is optional and free-form
 * — the actual submission is still validated by `createExpenseWithEvidence`'s
 * own schema.
 *
 * `reRecordFrom` is the void-and-re-record handoff (relocated from the
 * quick dialog's prefilled reopen, same decision): `expense-detail.tsx`
 * navigates here with the just-voided expense's id after the void write
 * lands, and `NewExpensePage` loads it via `fetchExpense` to seed the form.
 */
const newExpenseSearchSchema = z.object({
  amount: z.string().optional(),
  expenseDate: z.string().optional(),
  category: z.string().optional(),
  payeeName: z.string().optional(),
  paymentMethod: z.string().optional(),
  currency: z.string().optional(),
  economicEntityId: z.string().optional(),
  reRecordFrom: z.uuid().optional()
});

function NewExpenseError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <FinancePage title='New expense' description='Compose one expense from evidence.'>
      <Alert variant='destructive'>
        <Icons.warning />
        <AlertTitle>Could not load this page</AlertTitle>
        <AlertDescription className='flex flex-col gap-2'>
          <span>{error instanceof Error ? error.message : 'Unknown error'}</span>
          <Button size='sm' variant='outline' onClick={() => router.invalidate()} className='w-fit'>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </FinancePage>
  );
}

export const Route = createFileRoute('/finance/expenses/new')({
  validateSearch: zodValidator(newExpenseSearchSchema),
  loaderDeps: ({ search }) => ({ reRecordFrom: search.reRecordFrom }),
  loader: async ({ context: { queryClient }, deps: { reRecordFrom } }) => {
    await queryClient.ensureQueryData(entitiesQuery);
    if (reRecordFrom) {
      await queryClient.ensureQueryData(expenseQuery(reRecordFrom));
    }
  },
  errorComponent: NewExpenseError,
  component: FinanceExpensesNew
});

function FinanceExpensesNew() {
  const search = Route.useSearch();

  return (
    <FinancePage title='New expense'>
      <React.Suspense fallback={<Skeleton className='h-96 w-full' />}>
        <NewExpensePage prefill={search} reRecordFrom={search.reRecordFrom} />
      </React.Suspense>
    </FinancePage>
  );
}
