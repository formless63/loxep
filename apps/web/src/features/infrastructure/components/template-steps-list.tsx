import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PROVISIONING_STEP_KIND_LABELS } from '@/features/infrastructure/constants';
import type { ProvisioningTemplateStepDto } from '@/server/provisioning-functions';

/**
 * A template's step DEFINITIONS — the ordered, idempotent list a run's
 * `compiled_plan` freezes at start. `${placeholder}` values in `params` are
 * shown verbatim; they are resolved against a run's own inputs only at
 * compile time, never here.
 */
export default function TemplateStepsList({ steps }: { steps: ProvisioningTemplateStepDto[] }) {
  return (
    <ol className='flex flex-col gap-3'>
      {steps.map((step) => (
        <li key={step.id}>
          <Card>
            <CardContent className='flex flex-col gap-2 py-4'>
              <div className='flex flex-wrap items-center gap-2'>
                <span className='text-muted-foreground font-mono text-xs'>
                  #{step.sequence + 1}
                </span>
                <span className='font-medium'>
                  {PROVISIONING_STEP_KIND_LABELS[step.stepKind] ?? step.stepKind}
                </span>
                <span className='text-muted-foreground font-mono text-xs'>{step.stepKind}</span>
                {step.provider && <Badge variant='outline'>{step.provider}</Badge>}
                {step.optional && <Badge variant='secondary'>Optional</Badge>}
              </div>
              <pre className='bg-muted overflow-x-auto rounded-md p-2 text-xs'>
                {JSON.stringify(step.params, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </li>
      ))}
    </ol>
  );
}
