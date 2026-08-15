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

/**
 * `/finance/expenses/new` — the real two-pane entry page (loxep-cd3.2, M2 —
 * `expense-entry-design.md` section 1). Search params carry whatever the
 * quick-entry dialog's "More options" link had already typed, so starting
 * fast and discovering the receipt has fourteen lines is not a re-type.
 * Every field is optional and free-form here — the actual submission is
 * still validated by `createExpenseWithEvidence`'s own schema.
 */
const newExpenseSearchSchema = z.object({
  amount: z.string().optional(),
  expenseDate: z.string().optional(),
  category: z.string().optional(),
  payeeName: z.string().optional(),
  paymentMethod: z.string().optional(),
  currency: z.string().optional(),
  economicEntityId: z.string().optional()
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
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(entitiesQuery);
  },
  errorComponent: NewExpenseError,
  component: FinanceExpensesNew
});

function FinanceExpensesNew() {
  const search = Route.useSearch();

  return (
    <FinancePage
      title='New expense'
      description='Form on the left, evidence on the right — visible at once. The dialog is capture; this page is composition.'
    >
      <React.Suspense fallback={<Skeleton className='h-96 w-full' />}>
        <NewExpensePage prefill={search} />
      </React.Suspense>
    </FinancePage>
  );
}
