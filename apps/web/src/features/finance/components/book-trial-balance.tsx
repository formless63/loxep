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
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { formatMoney } from '@/lib/format';
import { trialBalanceQuery } from '@/features/finance/api/books-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';

/**
 * Read-only financial statement, not a sortable/filterable data grid: the
 * order (account code) and the row set (every account in the book) are both
 * fixed by the read model, and the required balances-to-zero footer is what
 * `TableFooter` exists for — the sanctioned `DataTable` stack has no
 * equivalent, and adding pagination/sort machinery here would only hide the
 * one property a trial balance must visibly have.
 */
export default function BookTrialBalance({ accountingBookId }: { accountingBookId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    trialBalanceQuery(accountingBookId)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trial balance</CardTitle>
        <CardDescription>
          Every account, summed over posted and reversed entries. A healthy book&rsquo;s difference
          is zero — non-zero is a bug in the ledger code, never in the data.
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className='text-right'>Debit</TableHead>
                <TableHead className='text-right'>Credit</TableHead>
                <TableHead className='text-right'>Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <TableRow key={row.ledgerAccountId}>
                  <TableCell>
                    <div className='flex items-center gap-2'>
                      <span className='text-muted-foreground tabular-nums'>{row.code}</span>
                      <span className={row.lineCount === 0 ? 'text-muted-foreground' : undefined}>
                        {row.name}
                      </span>
                      {row.systemKey && (
                        <Badge variant='outline' className='text-xs'>
                          {row.systemKey}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {formatMoney(row.debit, data.functionalCurrency)}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {formatMoney(row.credit, data.functionalCurrency)}
                  </TableCell>
                  <TableCell className='text-right font-medium tabular-nums'>
                    {formatMoney(row.balance, data.functionalCurrency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
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
                    {Number(data.difference) === 0
                      ? 'Balances to zero'
                      : `Off by ${data.difference}`}
                  </Badge>
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
