import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { TableCell, TableRow } from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { dataTableFeatures, type DataTableFeatures } from '@/lib/table-features';
import { formatMoney } from '@/lib/format';
import { trialBalanceQuery } from '@/features/finance/api/books-queries';
import type { TrialBalanceDto, TrialBalanceRowDto } from '@/server/books-functions';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import AccountActivityDialog, {
  type AccountActivityTarget
} from '@/features/finance/components/account-activity-dialog';

function createColumns(
  functionalCurrency: string,
  onDrillThrough: (target: AccountActivityTarget) => void
): ColumnDef<DataTableFeatures, TrialBalanceRowDto>[] {
  return [
    {
      id: 'account',
      accessorKey: 'name',
      header: 'Account',
      cell: ({ row }) => (
        <button
          type='button'
          className='flex items-center gap-2 rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
          onClick={() =>
            onDrillThrough({
              ledgerAccountId: row.original.ledgerAccountId,
              code: row.original.code,
              name: row.original.name
            })
          }
        >
          <span className='text-muted-foreground tabular-nums'>{row.original.code}</span>
          <span className={row.original.lineCount === 0 ? 'text-muted-foreground' : undefined}>
            {row.original.name}
          </span>
          {row.original.systemKey && (
            <Badge variant='outline' className='text-xs'>
              {row.original.systemKey}
            </Badge>
          )}
        </button>
      )
    },
    {
      id: 'debit',
      accessorKey: 'debit',
      header: () => <div className='text-right'>Debit</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.debit, functionalCurrency)}
        </div>
      )
    },
    {
      id: 'credit',
      accessorKey: 'credit',
      header: () => <div className='text-right'>Credit</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.credit, functionalCurrency)}
        </div>
      )
    },
    {
      id: 'balance',
      accessorKey: 'balance',
      header: () => <div className='text-right'>Balance</div>,
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.balance, functionalCurrency)}
        </div>
      )
    }
  ];
}

/**
 * Read-only financial statement, not a sortable/filterable data grid: the
 * order (account code) and the row set (every account in the book) are both
 * fixed by the read model. It still renders through the sanctioned
 * `DataTable` shell — `useTable` + `features: dataTableFeatures` +
 * `manualPagination: true` (the same local-table pattern
 * `expense-reports.tsx`'s `MissingReceiptsList` uses) skips sort/filter/page
 * machinery this surface has no use for — with the required balances-to-zero
 * footer rendered through `DataTable`'s `summary` slot rather than a
 * hand-rolled `<Table>`.
 *
 * Each account row is a drill-through (loxep-6ea, audit finding A12) into
 * `LedgerReports.accountActivity` via `AccountActivityDialog` — before this,
 * a trial-balance row was a dead end with no way to see the lines behind a
 * balance.
 */
export default function BookTrialBalance({ accountingBookId }: { accountingBookId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    trialBalanceQuery(accountingBookId)
  );
  const [drillThrough, setDrillThrough] = React.useState<AccountActivityTarget | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trial balance</CardTitle>
        <CardDescription>
          Every account, summed over posted and reversed entries. A healthy book&rsquo;s difference
          is zero — non-zero is a bug in the ledger code, never in the data. Click an account to see
          its activity.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className='text-muted-foreground text-sm'>Loading…</div>
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load the trial balance'
            onRetry={() => refetch()}
          />
        ) : data.rows.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.statement />
              </EmptyMedia>
              <EmptyTitle>No activity in this book</EmptyTitle>
              <EmptyDescription>
                Nothing has posted yet — every account carries a zero balance.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <TrialBalanceDataTable data={data} onDrillThrough={setDrillThrough} />
        )}
      </CardContent>
      <AccountActivityDialog
        accountingBookId={accountingBookId}
        functionalCurrency={data?.functionalCurrency ?? 'USD'}
        target={drillThrough}
        onOpenChange={(open) => !open && setDrillThrough(null)}
      />
    </Card>
  );
}

function TrialBalanceDataTable({
  data,
  onDrillThrough
}: {
  data: TrialBalanceDto;
  onDrillThrough: (target: AccountActivityTarget) => void;
}) {
  const columns = createColumns(data.functionalCurrency, onDrillThrough);
  const table = useTable({
    data: data.rows,
    columns,
    features: dataTableFeatures,
    getRowId: (row) => row.ledgerAccountId,
    manualPagination: true
  });

  return (
    <DataTable
      table={table}
      summary={
        <TableRow>
          <TableCell className='font-medium'>Total</TableCell>
          <TableCell className='text-right font-medium tabular-nums'>
            {formatMoney(data.totalDebit, data.functionalCurrency)}
          </TableCell>
          <TableCell className='text-right font-medium tabular-nums'>
            {formatMoney(data.totalCredit, data.functionalCurrency)}
          </TableCell>
          <TableCell className='text-right'>
            <Badge variant={Number(data.difference) === 0 ? 'success' : 'destructive'}>
              {Number(data.difference) === 0 ? 'Balances to zero' : `Off by ${data.difference}`}
            </Badge>
          </TableCell>
        </TableRow>
      }
    />
  );
}
