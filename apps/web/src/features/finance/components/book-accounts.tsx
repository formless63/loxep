import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { ledgerAccountsQuery } from '@/features/finance/api/books-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { LedgerAccountDto } from '@/server/ledger-accounts-functions';
import AccountFormDialog from '@/features/finance/components/account-form-dialog';
import { buildAccountTree, getAccountColumns } from './book-accounts-columns';

/**
 * The chart of accounts for one book (loxep-l49) — visible until now only as
 * the trial balance's account column. A tree, not a paginated list: every
 * account in the book is fetched already (a chart is bounded — dozens of
 * rows, not thousands), so the sanctioned `DataTable` shell is used for its
 * expand/indent machinery (`entities-table`'s own precedent) rather than for
 * sort/filter/page, which a hierarchy doesn't meaningfully support either.
 */
export default function BookAccounts({
  accountingBookId,
  isAdmin
}: {
  accountingBookId: string;
  isAdmin: boolean;
}) {
  const { data, isPending, isError, error, refetch } = useQuery(
    ledgerAccountsQuery(accountingBookId)
  );
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<LedgerAccountDto | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (account: LedgerAccountDto) => {
    setEditing(account);
    setDialogOpen(true);
  };

  const accounts = data ?? [];
  const columns = React.useMemo(
    () => getAccountColumns(isAdmin, accountingBookId, openEdit),
    [isAdmin, accountingBookId]
  );

  return (
    <Card>
      <CardHeader className='flex flex-row items-start justify-between gap-2'>
        <div>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            The chart of accounts this book posts against. Type and system key never change once an
            account is created; code, name, description, and parent may, freely.
          </CardDescription>
        </div>
        {isAdmin && !isPending && !isError && (
          <Button size='sm' onClick={openCreate}>
            <Icons.add />
            Add account
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isPending ? (
          <DataTableSkeleton columnCount={columns.length} filterCount={0} />
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load accounts'
            onRetry={() => refetch()}
          />
        ) : (
          <AccountsDataTable tree={buildAccountTree(accounts)} columns={columns} />
        )}
      </CardContent>
      {dialogOpen && (
        <AccountFormDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          accountingBookId={accountingBookId}
          accounts={accounts}
          account={editing}
        />
      )}
    </Card>
  );
}

function AccountsDataTable({
  tree,
  columns
}: {
  tree: ReturnType<typeof buildAccountTree>;
  columns: ReturnType<typeof getAccountColumns>;
}) {
  const { table } = useDataTable({
    data: tree,
    columns,
    pageCount: 1,
    getRowId: (account) => account.id,
    shallow: true,
    debounceMs: 500,
    getSubRows: (row) => (row.children.length > 0 ? row.children : undefined),
    initialState: { expanded: true, columnPinning: { start: [], end: ['actions'] } }
  });

  return <DataTable table={table} />;
}
