import { createFileRoute, Link } from '@tanstack/react-router';
import { Icons } from '@/components/icons';
import { FinancePage } from '@/features/finance/components/finance-page';
import ExpenseDetail from '@/features/finance/components/expense-detail';

export const Route = createFileRoute('/finance/expenses/$id')({
  component: FinanceExpenseDetail
});

function FinanceExpenseDetail() {
  const { id } = Route.useParams();

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
      <ExpenseDetail expenseId={id} />
    </FinancePage>
  );
}
