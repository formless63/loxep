import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable } from '@/components/ui/table/data-table';
import { TableCell, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { dataTableFeatures, type DataTableFeatures } from '@/lib/table-features';
import { formatMoney } from '@/lib/format';
import { balanceSheetQuery, incomeStatementQuery } from '@/features/finance/api/statements-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import AccountActivityDialog, {
  type AccountActivityTarget
} from '@/features/finance/components/account-activity-dialog';
import type { StatementLine } from '@/server/statements-functions';
import type { FiscalPeriodDto } from '@/server/books-functions';

function statementColumns(
  functionalCurrency: string,
  onDrillThrough: (target: AccountActivityTarget) => void
): ColumnDef<DataTableFeatures, StatementLine>[] {
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
          <span>{row.original.name}</span>
          {row.original.isContra && (
            <Badge variant='outline' className='text-xs'>
              contra
            </Badge>
          )}
        </button>
      )
    },
    {
      id: 'amount',
      accessorKey: 'amount',
      header: () => <div className='text-right'>Amount</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.amount, functionalCurrency)}
        </div>
      )
    }
  ];
}

/** One statement section (Revenue, Expense, Assets, …) as a fixed local table — same pattern `book-trial-balance.tsx` sets. */
function StatementLinesTable({
  lines,
  total,
  totalLabel,
  functionalCurrency,
  onDrillThrough
}: {
  lines: StatementLine[];
  total: string;
  totalLabel: string;
  functionalCurrency: string;
  onDrillThrough: (target: AccountActivityTarget) => void;
}) {
  const columns = statementColumns(functionalCurrency, onDrillThrough);
  const table = useTable({
    data: lines,
    columns,
    features: dataTableFeatures,
    getRowId: (row) => row.ledgerAccountId,
    manualPagination: true
  });

  if (lines.length === 0) {
    return <p className='text-muted-foreground text-sm'>No accounts with activity.</p>;
  }

  return (
    <DataTable
      table={table}
      summary={
        <TableRow>
          <TableCell className='font-medium'>{totalLabel}</TableCell>
          <TableCell className='text-right font-medium tabular-nums'>
            {formatMoney(total, functionalCurrency)}
          </TableCell>
        </TableRow>
      }
    />
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The fiscal period covering today, or the most recently generated one, or null when the book has none yet. */
function defaultPeriod(periods: FiscalPeriodDto[]): FiscalPeriodDto | null {
  const today = todayIso();
  const current = periods.find((period) => period.startsOn <= today && period.endsOn >= today);
  if (current !== undefined) return current;
  return periods.length === 0 ? null : (periods[periods.length - 1] ?? null);
}

/**
 * Income statement + balance sheet from the REAL service (loxep-6ea, audit
 * finding A12) — `createStatements` (`packages/accounting/src/statements.ts`)
 * had zero callers before this bead, and there was no balance sheet
 * anywhere. One period selector drives both: the range feeds the income
 * statement, and its end date is the balance sheet's `asOf`.
 */
export default function BookStatements({
  accountingBookId,
  periods
}: {
  accountingBookId: string;
  periods: FiscalPeriodDto[];
}) {
  const initial = React.useMemo(() => defaultPeriod(periods), [periods]);
  const [from, setFrom] = React.useState(initial?.startsOn ?? todayIso());
  const [to, setTo] = React.useState(initial?.endsOn ?? todayIso());
  const [drillThrough, setDrillThrough] = React.useState<AccountActivityTarget | null>(null);

  const incomeStatement = useQuery(incomeStatementQuery(accountingBookId, from, to));
  const balanceSheet = useQuery(balanceSheetQuery(accountingBookId, to));
  const functionalCurrency =
    incomeStatement.data?.functionalCurrency ?? balanceSheet.data?.functionalCurrency ?? 'USD';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Statements</CardTitle>
        <CardDescription>
          The income statement for the selected range, and the balance sheet as of its end date —
          both computed by the same service the trial balance is, so neither can disagree with it.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        <div className='flex flex-wrap items-end gap-4'>
          <div className='grid gap-1.5'>
            <Label htmlFor='statements-from'>From</Label>
            <Input
              id='statements-from'
              type='date'
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='statements-to'>To / as of</Label>
            <Input
              id='statements-to'
              type='date'
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        </div>

        <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
          <div className='flex flex-col gap-3'>
            <h3 className='text-sm font-medium'>Income statement</h3>
            {incomeStatement.isPending ? (
              <Skeleton className='h-40 w-full' />
            ) : incomeStatement.isError ? (
              <QueryErrorAlert
                error={incomeStatement.error}
                title='Could not load the income statement'
                onRetry={() => incomeStatement.refetch()}
              />
            ) : (
              <div className='flex flex-col gap-4'>
                <div>
                  <p className='text-muted-foreground mb-1.5 text-xs'>Revenue</p>
                  <StatementLinesTable
                    lines={incomeStatement.data.revenue.lines}
                    total={incomeStatement.data.revenue.total}
                    totalLabel='Total revenue'
                    functionalCurrency={functionalCurrency}
                    onDrillThrough={setDrillThrough}
                  />
                </div>
                <div>
                  <p className='text-muted-foreground mb-1.5 text-xs'>Expense</p>
                  <StatementLinesTable
                    lines={incomeStatement.data.expense.lines}
                    total={incomeStatement.data.expense.total}
                    totalLabel='Total expense'
                    functionalCurrency={functionalCurrency}
                    onDrillThrough={setDrillThrough}
                  />
                </div>
                <div className='flex items-center justify-between rounded-md border p-3'>
                  <span className='text-sm font-medium'>Net income</span>
                  <span className='tabular-nums text-sm font-semibold'>
                    {formatMoney(incomeStatement.data.netIncome, functionalCurrency)}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className='flex flex-col gap-3'>
            <h3 className='text-sm font-medium'>Balance sheet</h3>
            {balanceSheet.isPending ? (
              <Skeleton className='h-40 w-full' />
            ) : balanceSheet.isError ? (
              <QueryErrorAlert
                error={balanceSheet.error}
                title='Could not load the balance sheet'
                onRetry={() => balanceSheet.refetch()}
              />
            ) : (
              <div className='flex flex-col gap-4'>
                <div>
                  <p className='text-muted-foreground mb-1.5 text-xs'>Assets</p>
                  <StatementLinesTable
                    lines={balanceSheet.data.assets.lines}
                    total={balanceSheet.data.assets.total}
                    totalLabel='Total assets'
                    functionalCurrency={functionalCurrency}
                    onDrillThrough={setDrillThrough}
                  />
                </div>
                <div>
                  <p className='text-muted-foreground mb-1.5 text-xs'>Liabilities</p>
                  <StatementLinesTable
                    lines={balanceSheet.data.liabilities.lines}
                    total={balanceSheet.data.liabilities.total}
                    totalLabel='Total liabilities'
                    functionalCurrency={functionalCurrency}
                    onDrillThrough={setDrillThrough}
                  />
                </div>
                <div>
                  <p className='text-muted-foreground mb-1.5 text-xs'>Equity</p>
                  <StatementLinesTable
                    lines={balanceSheet.data.equityAccounts.lines}
                    total={balanceSheet.data.equityAccounts.total}
                    totalLabel='Contributed equity'
                    functionalCurrency={functionalCurrency}
                    onDrillThrough={setDrillThrough}
                  />
                  <ul className='mt-2 flex flex-col gap-1 text-sm'>
                    <li className='flex justify-between'>
                      <span className='text-muted-foreground'>Retained earnings</span>
                      <span className='tabular-nums'>
                        {formatMoney(balanceSheet.data.retainedEarnings, functionalCurrency)}
                      </span>
                    </li>
                    <li className='flex justify-between'>
                      <span className='text-muted-foreground'>Current-year earnings</span>
                      <span className='tabular-nums'>
                        {formatMoney(balanceSheet.data.currentEarnings, functionalCurrency)}
                      </span>
                    </li>
                    <li className='flex justify-between font-medium'>
                      <span>Total equity</span>
                      <span className='tabular-nums'>
                        {formatMoney(balanceSheet.data.totalEquity, functionalCurrency)}
                      </span>
                    </li>
                  </ul>
                </div>
                <div className='flex items-center justify-between rounded-md border p-3'>
                  <span className='text-sm font-medium'>Assets − (liabilities + equity)</span>
                  <span className='flex items-center gap-2'>
                    <span className='tabular-nums text-sm'>
                      {formatMoney(balanceSheet.data.difference, functionalCurrency)}
                    </span>
                    <Badge variant={balanceSheet.data.balanced ? 'success' : 'destructive'}>
                      {balanceSheet.data.balanced ? 'Balanced' : 'Out of balance'}
                    </Badge>
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
      <AccountActivityDialog
        accountingBookId={accountingBookId}
        functionalCurrency={functionalCurrency}
        target={drillThrough}
        onOpenChange={(open) => !open && setDrillThrough(null)}
      />
    </Card>
  );
}
