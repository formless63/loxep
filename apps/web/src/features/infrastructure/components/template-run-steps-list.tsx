import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Icons } from '@/components/icons';
import { ToneBadge } from '@/features/settings/components/status-tone';
import {
  PROVISIONING_STEP_KIND_LABELS,
  TEMPLATE_BLOCKED_REASON_LABELS,
  TEMPLATE_RUN_STEP_STATUS_LABELS,
  TEMPLATE_RUN_STEP_STATUS_TONE
} from '@/features/infrastructure/constants';
import { formatTimestampPrecise } from '@/lib/format';
import type { ProvisioningTemplateRunStepDto } from '@/server/provisioning-functions';

const STATUS_ICON: Record<string, keyof typeof Icons> = {
  pending: 'clock',
  running: 'spinner',
  succeeded: 'circleCheck',
  blocked: 'warning',
  failed: 'circleX',
  skipped: 'circle'
};

/**
 * The run's own step ladder — the PERSISTENT spine `template_run_steps`
 * stores, distinct from `template-steps-list.tsx`'s DEFINITION view. Every
 * `'blocked'` step names the exact remedy (never a bare code) and links to
 * its own evidence — an ordinary reconcile run — when one exists. A step
 * with no `reconcileRunId` (only `domain.declare` today) is not a gap: it is
 * a pure Loxep intent write with no provider read of its own to be evidence
 * of.
 */
export default function TemplateRunStepsList({
  steps
}: {
  steps: ProvisioningTemplateRunStepDto[];
}) {
  return (
    <ol className='flex flex-col gap-3'>
      {steps.map((step) => {
        const Icon = Icons[STATUS_ICON[step.status] ?? 'circle'];
        return (
          <li key={step.id}>
            <Card>
              <CardContent className='flex flex-col gap-2 py-4'>
                <div className='flex flex-wrap items-center gap-2'>
                  <Icon
                    className={
                      step.status === 'running'
                        ? 'text-muted-foreground size-4 animate-spin'
                        : 'size-4'
                    }
                  />
                  <span className='text-muted-foreground font-mono text-xs'>
                    #{step.sequence + 1}
                  </span>
                  <span className='font-medium'>
                    {PROVISIONING_STEP_KIND_LABELS[step.stepKind] ?? step.stepKind}
                  </span>
                  {step.provider && <Badge variant='outline'>{step.provider}</Badge>}
                  <ToneBadge tone={TEMPLATE_RUN_STEP_STATUS_TONE[step.status] ?? 'secondary'}>
                    {TEMPLATE_RUN_STEP_STATUS_LABELS[step.status] ?? step.status}
                  </ToneBadge>
                  <span className='text-muted-foreground ml-auto text-xs'>
                    {formatTimestampPrecise(step.occurredAt)}
                  </span>
                </div>

                {step.status === 'blocked' && (
                  <Alert variant='warning'>
                    <Icons.warning />
                    <AlertTitle>
                      {(step.blockedReason && TEMPLATE_BLOCKED_REASON_LABELS[step.blockedReason]) ??
                        step.blockedReason ??
                        'Blocked'}
                    </AlertTitle>
                    {step.errorDetail && <AlertDescription>{step.errorDetail}</AlertDescription>}
                  </Alert>
                )}

                {step.status === 'failed' && step.errorDetail && (
                  <p className='text-destructive text-sm'>
                    {step.errorCode ? `${step.errorCode}: ` : ''}
                    {step.errorDetail}
                  </p>
                )}

                {step.reconcileRunId && (
                  <Link
                    to='/infrastructure/runs/$id'
                    params={{ id: step.reconcileRunId }}
                    className='text-primary w-fit text-xs outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
                  >
                    View reconcile run evidence →
                  </Link>
                )}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}
