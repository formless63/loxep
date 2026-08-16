import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icons } from '@/components/icons';
import { formatRelativeTime } from '@/lib/format';
import { purelymailAccountFactsQuery } from '@/features/infrastructure/api/queries';

/**
 * Account facts — `checkAccountCredit`/`getOwnershipCode` — folded into the
 * header and fetched ONLY on explicit expand (Rule P6/P7: the overview's
 * three calls — Domains, Mailboxes, Routing rules — are the budget; this
 * pair is a fourth call, so it is a drill-in). Purely `useQuery`'s own
 * `enabled` gate — no separate "fetched yet" state to track.
 */
export default function PurelymailAccountFactsPanel({ connectionId }: { connectionId: string }) {
  const [open, setOpen] = React.useState(false);
  const { data, isPending, isError, refetch } = useQuery({
    ...purelymailAccountFactsQuery(connectionId),
    enabled: open
  });

  return (
    <Card>
      <CardHeader className='pb-0'>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button size='sm' variant='ghost' className='-ml-2'>
              {open ? <Icons.chevronUp /> : <Icons.chevronDown />}
              Account facts (credit, ownership code)
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className='px-0 pt-2'>
              {!open ? null : isPending ? (
                <p className='text-muted-foreground text-sm'>
                  Reading account facts from Purelymail…
                </p>
              ) : isError ? (
                <div className='flex items-center justify-between gap-2 text-sm'>
                  <span className='text-destructive'>Could not read account facts.</span>
                  <Button size='sm' variant='outline' onClick={() => void refetch()}>
                    Retry
                  </Button>
                </div>
              ) : data === undefined ? null : data.status === 'blocked' ? (
                <p className='text-muted-foreground text-sm'>{data.reason}</p>
              ) : data.status === 'error' ? (
                <p className='text-destructive text-sm'>{data.message}</p>
              ) : (
                <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm'>
                  <dt className='text-muted-foreground'>Account credit</dt>
                  <dd className='font-mono'>{data.data.credit}</dd>
                  <dt className='text-muted-foreground'>Ownership code</dt>
                  <dd className='font-mono break-all'>{data.data.ownershipCode}</dd>
                  <dt className='text-muted-foreground'>Read</dt>
                  <dd>{formatRelativeTime(data.readAt)} — never stored.</dd>
                </dl>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </CardHeader>
    </Card>
  );
}
