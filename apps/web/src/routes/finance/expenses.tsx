import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { FinancePage } from '@/features/finance/components/finance-page';
import ExpensesTable from '@/features/finance/components/expenses-table';
import QuickExpenseDialog from '@/features/finance/components/quick-expense-dialog';
import { entitiesQuery } from '@/features/settings/api/queries';

/**
 * `quickEntry=true` is how "New expense" (command palette + sidebar, via the
 * redirect-only `/finance/expenses/new` route) opens the quick-entry dialog
 * on arrival. The rest are the toolbar/date-range filter state
 * `ExpensesTable` reads — see its own doc for why they are plain search
 * params rather than `useDataTable`'s built-in (client-only) column filters.
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
  quickEntry: z.boolean().optional()
});

export const Route = createFileRoute('/finance/expenses')({
  validateSearch: zodValidator(expensesSearchSchema),
  component: FinanceExpenses
});

function FinanceExpenses() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: entities } = useQuery(entitiesQuery);

  const [dialogOpen, setDialogOpen] = React.useState(search.quickEntry === true);

  React.useEffect(() => {
    if (search.quickEntry === true) {
      setDialogOpen(true);
      void navigate({ search: (prev) => ({ ...prev, quickEntry: undefined }), replace: true });
    }
    // Only reacts to the initial/redirected arrival — the dialog's own
    // `onOpenChange` owns subsequent open/close state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.quickEntry]);

  return (
    <FinancePage
      title='Expenses'
      description='Every dollar that leaves, captured — quick entry writes it as recorded in one action. A recorded expense is locked; correct it by voiding and recording the corrected fact.'
      actions={
        <Button size='sm' onClick={() => setDialogOpen(true)}>
          <Icons.add />
          New expense
        </Button>
      }
    >
      <ExpensesTable />
      {dialogOpen && (
        <QuickExpenseDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          entities={entities ?? []}
        />
      )}
    </FinancePage>
  );
}
