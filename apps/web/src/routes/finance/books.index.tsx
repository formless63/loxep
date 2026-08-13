import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { FinancePage } from '@/features/finance/components/finance-page';
import BooksTable from '@/features/finance/components/books-table';
import CreateBookDialog from '@/features/finance/components/create-book-dialog';

export const Route = createFileRoute('/finance/books/')({
  component: FinanceBooks
});

function FinanceBooks() {
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <FinancePage
      title='Books'
      description='Accounting books, chart of accounts, and the fiscal periods that gate posting. A subsidiary or assumed name never gets a ledger of its own — its activity rolls up into the parent entity that owns it.'
      actions={
        <Button size='sm' onClick={() => setDialogOpen(true)}>
          <Icons.add />
          New book
        </Button>
      }
    >
      <BooksTable />
      {dialogOpen && <CreateBookDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
    </FinancePage>
  );
}
