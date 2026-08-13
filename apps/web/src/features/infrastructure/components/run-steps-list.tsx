import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { formatTimestampPrecise } from '@/lib/format';
import type { ReconcileRunStepDto } from '@/server/infrastructure-functions';

const STEP_STATUS_TONE = {
  succeeded: 'success',
  failed: 'destructive',
  skipped: 'secondary'
} as const;

/**
 * Every field here is a REDACTED structure — never a raw provider payload,
 * never a token value or `Authorization` header. `@loxep/infrastructure`
 * enforces that at the adapter boundary; this list just renders what it was
 * given.
 */
export default function RunStepsList({ steps }: { steps: ReconcileRunStepDto[] }) {
  if (steps.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.code />
          </EmptyMedia>
          <EmptyTitle>No steps recorded</EmptyTitle>
          <EmptyDescription>This run has not written any steps yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ol className='flex flex-col gap-3'>
      {steps.map((step) => (
        <li key={step.id}>
          <Card>
            <CardContent className='flex flex-col gap-2 py-4'>
              <div className='flex flex-wrap items-center gap-2'>
                <span className='text-muted-foreground font-mono text-xs'>#{step.sequence}</span>
                <span className='font-medium'>{step.step}</span>
                <ToneBadge
                  tone={
                    STEP_STATUS_TONE[step.status as keyof typeof STEP_STATUS_TONE] ?? 'secondary'
                  }
                >
                  {step.status}
                </ToneBadge>
                {step.provider && <Badge variant='outline'>{step.provider}</Badge>}
                <span className='text-muted-foreground ml-auto text-xs'>
                  {formatTimestampPrecise(step.occurredAt)}
                </span>
              </div>
              {step.errorDetail && (
                <p className='text-destructive text-sm'>
                  {step.errorCode ? `${step.errorCode}: ` : ''}
                  {step.errorDetail}
                </p>
              )}
              {step.requestSummary && (
                <pre className='bg-muted overflow-x-auto rounded-md p-2 text-xs'>
                  {JSON.stringify(step.requestSummary, null, 2)}
                </pre>
              )}
              {step.responseSummary && (
                <pre className='bg-muted overflow-x-auto rounded-md p-2 text-xs'>
                  {JSON.stringify(step.responseSummary, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>
        </li>
      ))}
    </ol>
  );
}
