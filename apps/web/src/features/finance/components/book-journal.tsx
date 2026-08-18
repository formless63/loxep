import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { formatDate, formatMoney } from '@/lib/format';
import {
  journalEntriesQuery,
  journalEntryLinesQuery,
  ledgerAccountsQuery
} from '@/features/finance/api/books-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import {
  journalEntrySourceLabel,
  journalEntryStatusLabel,
  journalEntryStatusTone
} from '@/features/finance/constants';

function EntryLinesRow({
  journalEntryId,
  colSpan,
  accountLabelById,
  functionalCurrency
}: {
  journalEntryId: string;
  colSpan: number;
  accountLabelById: Map<string, string>;
  functionalCurrency: string;
}) {
  const { data, isPending, isError } = useQuery(journalEntryLinesQuery(journalEntryId));

  return (
    <TableRow className='bg-muted/30 hover:bg-muted/30'>
      <TableCell colSpan={colSpan} className='p-0'>
        <div className='px-4 py-3'>
          {isPending ? (
            <span className='text-muted-foreground text-sm'>Loading lines…</span>
          ) : isError ? (
            <span className='text-destructive text-sm'>
              Could not load this entry&rsquo;s lines.
            </span>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Memo</TableHead>
                  <TableHead className='text-right'>Debit</TableHead>
                  <TableHead className='text-right'>Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((line) => {
                  const amount = Number(line.amount);
                  return (
                    <TableRow key={line.id}>
                      <TableCell>
                        {accountLabelById.get(line.ledgerAccountId) ?? line.ledgerAccountId}
                      </TableCell>
                      <TableCell className='text-muted-foreground'>
                        {line.description ?? '—'}
                      </TableCell>
                      <TableCell className='text-right tabular-nums'>
                        {amount > 0 ? formatMoney(line.amount, functionalCurrency) : ''}
                      </TableCell>
                      <TableCell className='text-right tabular-nums'>
                        {amount < 0 ? formatMoney(String(-amount), functionalCurrency) : ''}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * The journal for one book (loxep-l49) — `JournalService.listEntries` had
 * zero callers before this bead. READ ONLY: no create/edit/post/reverse
 * affordance exists anywhere on this section, by design (see
 * `journal-functions.ts`'s module doc) — the posting engine is the only
 * writer, and the caption below says so where an operator will see it.
 *
 * A plain `Table`, not the sanctioned `DataTable`, for the same reason
 * `book-trial-balance.tsx` gives: this is a financial statement with a row
 * expander showing each entry's lines, not a user-sortable/paginated grid —
 * and a per-row expansion into a DIFFERENTLY-SHAPED nested table (lines, not
 * entries) has no equivalent in the shared `DataTable` shell, which renders
 * one row per top-level record. Filtering is by period (and status), the
 * only predicates `JournalEntryFilter` supports — there is no account
 * filter because the service filters entries, not lines (see the module
 * doc's own account-filter note).
 */
export default function BookJournal({
  accountingBookId,
  functionalCurrency
}: {
  accountingBookId: string;
  functionalCurrency: string;
}) {
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const { data, isPending, isError, error, refetch } = useQuery(
    journalEntriesQuery(accountingBookId, {
      from: from === '' ? undefined : from,
      to: to === '' ? undefined : to
    })
  );
  const { data: accounts } = useQuery(ledgerAccountsQuery(accountingBookId));
  const accountLabelById = new Map(
    (accounts ?? []).map((account) => [account.id, `${account.code} — ${account.name}`])
  );

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Journal</CardTitle>
        <CardDescription>
          Every posted, draft, reversed, or void entry in this book. Read-only — entries are written
          by the posting engine (or a future dedicated entry surface), never from here.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        <div className='flex flex-wrap items-end gap-4'>
          <div className='grid gap-1.5'>
            <Label htmlFor='journal-from'>From</Label>
            <Input
              id='journal-from'
              type='date'
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='journal-to'>To</Label>
            <Input
              id='journal-to'
              type='date'
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          {(from || to) && (
            <Button
              variant='outline'
              size='sm'
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              Clear dates
            </Button>
          )}
        </div>

        {isPending ? (
          <div className='text-muted-foreground text-sm'>Loading…</div>
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load the journal'
            onRetry={() => refetch()}
          />
        ) : data.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.ledger />
              </EmptyMedia>
              <EmptyTitle>No journal entries</EmptyTitle>
              <EmptyDescription>
                Nothing has posted to this book yet — the posting engine hasn&rsquo;t run, or no
                entry falls inside the selected period.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-8' />
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className='text-right'>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((entry) => (
                <React.Fragment key={entry.id}>
                  <TableRow className='cursor-pointer' onClick={() => toggle(entry.id)}>
                    <TableCell>
                      {expanded.has(entry.id) ? (
                        <Icons.chevronDown className='text-muted-foreground h-4 w-4' />
                      ) : (
                        <Icons.chevronRight className='text-muted-foreground h-4 w-4' />
                      )}
                    </TableCell>
                    <TableCell className='tabular-nums'>{formatDate(entry.entryDate)}</TableCell>
                    <TableCell>
                      <div className='flex flex-col'>
                        <span>{entry.description}</span>
                        <span className='text-muted-foreground text-xs'>
                          {journalEntrySourceLabel(entry.entrySource)}
                          {entry.sourceFactType && ` · ${entry.sourceFactType}`}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={journalEntryStatusTone(entry.status)}>
                        {journalEntryStatusLabel(entry.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className='text-right font-medium tabular-nums'>
                      {formatMoney(entry.totalAmount, functionalCurrency)}
                    </TableCell>
                  </TableRow>
                  {expanded.has(entry.id) && (
                    <EntryLinesRow
                      journalEntryId={entry.id}
                      colSpan={5}
                      accountLabelById={accountLabelById}
                      functionalCurrency={functionalCurrency}
                    />
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
