import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { Icons } from '@/components/icons';
import { FinancePage } from '@/features/finance/components/finance-page';
import ExpenseDetail from '@/features/finance/components/expense-detail';

/**
 * `q`, when present, is the search term the operator arrived with from
 * `/finance/expenses`' "search receipt text" filter — it drives the
 * `ts_headline` snippet on this page (design section 5: "highlighted via
 * ts_headline when arriving from a search"), never a persistent filter of
 * this page's own.
 */
const expenseDetailSearchSchema = z.object({
  q: z.string().optional()
});

export const Route = createFileRoute('/finance/expenses/$id')({
  validateSearch: zodValidator(expenseDetailSearchSchema),
  component: FinanceExpenseDetail
});

function FinanceExpenseDetail() {
  const { id } = Route.useParams();
  const { q } = Route.useSearch();

  return (
    <FinancePage
      title='Expense'
      description='Recorded is a lock — correct it by voiding and recording the corrected fact, never by editing in place.'
      actions={
        <Link to='/finance/expenses' className='text-muted-foreground text-sm hover:underline'>
          <Icons.arrowRight className='mr-1 inline-block rotate-180 align-text-bottom' />
          Back to expenses
        </Link>
      }
    >
      <ExpenseDetail expenseId={id} q={q ?? null} />
    </FinancePage>
  );
}
