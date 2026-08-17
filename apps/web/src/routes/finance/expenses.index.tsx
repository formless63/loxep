import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { FinancePage } from '@/features/finance/components/finance-page';
import ExpensesTable from '@/features/finance/components/expenses-table';

/**
 * The toolbar/date-range filter state `ExpensesTable` reads — see its own
 * doc for why they are plain search params rather than `useDataTable`'s
 * built-in (client-only) column filters.
 *
 * OWNER REVERSAL (2026-08-17): the quick-entry dialog is REMOVED —
 * `/finance/expenses/new` is now the single expense-entry path, so this
 * route no longer carries a `quickEntry` search param.
 */
const expensesSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(10),
  sort: z.string().optional(),
  category: z.string().optional(),
  economicEntityId: z.string().optional(),
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** "Search receipt text" (design section 5) — see `ExpensesTable`'s own doc for the field-vs-receipt-match distinction. */
  q: z.string().optional()
});

export const Route = createFileRoute('/finance/expenses/')({
  validateSearch: zodValidator(expensesSearchSchema),
  component: FinanceExpenses
});

function FinanceExpenses() {
  return (
    <FinancePage
      title='Expenses'
      description='Every dollar that leaves, captured. A recorded expense is locked; correct it by voiding and recording the corrected fact.'
      actions={
        <Button size='sm' asChild>
          <Link to='/finance/expenses/new'>
            <Icons.add />
            New expense
          </Link>
        </Button>
      }
    >
      <ExpensesTable />
    </FinancePage>
  );
}
