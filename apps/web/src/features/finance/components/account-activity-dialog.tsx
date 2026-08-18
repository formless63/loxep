import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { formatDate, formatMoney } from '@/lib/format';
import { accountActivityQuery } from '@/features/finance/api/statements-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';

export interface AccountActivityTarget {
  ledgerAccountId: string;
  code: string;
  name: string;
}

/**
 * The trial-balance drill-through the audit named by number:
 * `LedgerReports.accountActivity` had zero callers before this bead — a
 * trial-balance row was a dead end. Every posted/reversed journal line for
 * one account, most recent first.
 */
export default function AccountActivityDialog({
  accountingBookId,
  functionalCurrency,
  target,
  onOpenChange
}: {
  accountingBookId: string;
  functionalCurrency: string;
  target: AccountActivityTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    ...accountActivityQuery(accountingBookId, target?.ledgerAccountId ?? ''),
    enabled: target !== null
  });

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {target?.code} — {target?.name}
          </DialogTitle>
          <DialogDescription>
            Every posted or reversed journal line against this account, most recent first.
          </DialogDescription>
        </DialogHeader>
        {isPending ? (
          <Skeleton className='h-48 w-full' />
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load account activity'
            onRetry={() => refetch()}
          />
        ) : data.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.statement />
              </EmptyMedia>
              <EmptyTitle>No activity</EmptyTitle>
              <EmptyDescription>This account has no posted or reversed lines.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className='max-h-96 overflow-y-auto'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className='text-right'>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((line) => (
                  <TableRow key={line.journalLineId}>
                    <TableCell className='text-muted-foreground text-xs'>
                      {formatDate(line.entryDate)}
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center gap-1.5'>
                        <span className='tabular-nums'>{line.entryNumber ?? '—'}</span>
                        <Badge variant={line.entryStatus === 'reversed' ? 'outline' : 'success'}>
                          {line.entryStatus}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className='text-muted-foreground max-w-64 truncate text-sm'>
                      {line.description ?? '—'}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {formatMoney(line.functionalAmount, functionalCurrency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
