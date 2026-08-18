import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
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
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatQuantity } from '@/lib/format';
import {
  explainSourceFactQuery,
  postingBacklogQuery
} from '@/features/finance/api/posting-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { triggerPostingSweep } from '@/server/posting-functions';
import type { PostingBacklogFactDto, UnpostableReason } from '@/server/posting-functions';

const REASON_LABELS: Record<UnpostableReason, string> = {
  fact_not_found: 'Fact not found',
  fact_ineligible: 'Not eligible to post',
  no_route: 'No book routed',
  no_rule: 'No matching rule',
  no_period: 'No open fiscal period',
  nothing_to_post: 'Nothing to post'
};

function ExplainDialog({
  fact,
  onOpenChange
}: {
  fact: PostingBacklogFactDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    ...explainSourceFactQuery(fact?.sourceFactType ?? '', fact?.sourceFactId ?? ''),
    enabled: fact !== null
  });

  return (
    <Dialog open={fact !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {fact?.sourceFactType} {fact?.sourceFactId}
          </DialogTitle>
          <DialogDescription>{fact?.explanation}</DialogDescription>
        </DialogHeader>
        {isPending ? (
          <Skeleton className='h-24 w-full' />
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load rule candidates'
            onRetry={() => refetch()}
          />
        ) : (
          <div className='flex flex-col gap-2'>
            <p className='text-muted-foreground text-xs'>
              Every rule considered for this fact&rsquo;s source type, in evaluation order:
            </p>
            {(data?.candidates.length ?? 0) === 0 ? (
              <p className='text-muted-foreground text-sm'>No rules exist for this fact type.</p>
            ) : (
              <ul className='flex flex-col gap-1.5'>
                {data?.candidates.map((candidate) => (
                  <li
                    key={candidate.code}
                    className='flex items-start justify-between gap-3 text-sm'
                  >
                    <span className='font-mono text-xs'>{candidate.code}</span>
                    <span className='flex items-center gap-2 text-right'>
                      <Badge variant={candidate.matched ? 'success' : 'outline'}>
                        {candidate.matched ? 'Matched' : 'No match'}
                      </Badge>
                      <span className='text-muted-foreground max-w-64'>{candidate.reason}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The posting engine's dead backlog, surfaced for the first time (loxep-6ea,
 * audit finding A3). Mounts `PostingEngine.unpostableBacklog` (grouped by
 * reason here) and `explainFact` (the per-fact "why" dialog) — both had zero
 * callers before this card. See `@/server/posting-functions`'s module doc.
 */
export default function PostingCard({ isAdmin }: { isAdmin: boolean }) {
  const { data, isPending, isError, error, refetch } = useQuery(postingBacklogQuery);
  const [explaining, setExplaining] = React.useState<PostingBacklogFactDto | null>(null);

  const sweepMutation = useMutation({
    mutationFn: () => triggerPostingSweep(),
    onSuccess: () => {
      toast.success('Posting sweep queued — it will pick up unposted facts shortly');
    },
    onError: (mutationError) => toastError(mutationError, 'Failed to queue a posting sweep')
  });

  const factsByReason = React.useMemo(() => {
    const map = new Map<UnpostableReason, PostingBacklogFactDto[]>();
    for (const fact of data?.facts ?? []) {
      const list = map.get(fact.reason) ?? [];
      list.push(fact);
      map.set(fact.reason, list);
    }
    return map;
  }, [data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Posting</CardTitle>
        <CardDescription>
          The unpostable backlog — facts with no journal entry yet, and why. Runs every 5 minutes.
        </CardDescription>
        {isAdmin && (
          <CardAction>
            <Button
              size='sm'
              variant='outline'
              disabled={sweepMutation.isPending}
              onClick={() => sweepMutation.mutate()}
            >
              <Icons.refresh />
              Post now
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className='flex flex-col gap-2'>
            <Skeleton className='h-8 w-full' />
            <Skeleton className='h-8 w-full' />
          </div>
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load the posting backlog'
            onRetry={() => refetch()}
          />
        ) : data.total === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.circleCheck />
              </EmptyMedia>
              <EmptyTitle>Nothing backlogged</EmptyTitle>
              <EmptyDescription>Every eligible fact has posted.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {data.truncated && (
              <p className='text-muted-foreground mb-2 text-xs'>
                Showing the first {formatQuantity(data.total)} facts — the real backlog may be
                larger.
              </p>
            )}
            <Accordion type='multiple' className='w-full'>
              {data.byReason.map(({ reason, count }) => (
                <AccordionItem key={reason} value={reason}>
                  <AccordionTrigger>
                    <span className='flex items-center gap-2'>
                      <Badge variant='warning'>{formatQuantity(count)}</Badge>
                      {REASON_LABELS[reason]}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <ul className='flex flex-col gap-1'>
                      {(factsByReason.get(reason) ?? []).map((fact) => (
                        <li
                          key={`${fact.sourceFactType}:${fact.sourceFactId}`}
                          className='flex items-center justify-between gap-3 text-sm'
                        >
                          <div className='flex min-w-0 flex-col'>
                            <span className='font-mono text-xs'>
                              {fact.sourceFactType} · {fact.sourceFactId}
                            </span>
                            <span className='text-muted-foreground truncate text-xs'>
                              {fact.explanation}
                            </span>
                          </div>
                          <Button size='sm' variant='ghost' onClick={() => setExplaining(fact)}>
                            Explain
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </>
        )}
      </CardContent>
      <ExplainDialog fact={explaining} onOpenChange={(open) => !open && setExplaining(null)} />
    </Card>
  );
}
